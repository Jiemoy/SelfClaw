import { invoke } from "@tauri-apps/api/core";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
// @ts-ignore — @noble/hashes uses ESM submodules, resolved by vite bundler
import { sha512 } from "@noble/hashes/sha2.js";
// @ts-ignore
import { randomBytes } from "@noble/hashes/utils.js";

// ---------------------------------------------------------------------------
// OpenClaw native config helpers
// ---------------------------------------------------------------------------

export interface OpenClawInfo {
  installed: boolean;
  version?: string;
  workDir?: string;
}

export interface OpenClawConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  provider?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  httpProxy?: string;
  socks5Proxy?: string;
  gatewayPort?: number;
  logLevel?: "info" | "debug" | "error";
  historyMessageLimit?: number;
  longTermMemoryEnabled?: boolean;
  autostartEnabled?: boolean;
  gatewayToken?: string;
  /** 网关会话键（可选），用于多轮对话与网关侧会话对齐 */
  sessionKey?: string;
}

export interface DetectedOpenClawConfig {
  found: boolean;
  source?: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  provider?: string;
}

export type StreamCallback = (chunk: string, isDone: boolean) => void;

export function stripAnsi(content: string): string {
  // eslint-disable-next-line no-control-regex
  return content.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export async function checkOpenClawInstalled(): Promise<OpenClawInfo> {
  const candidates = [
    { command: "openclaw", args: ["--version"] },
    { command: "npx", args: ["openclaw", "--version"] },
  ];

  for (const candidate of candidates) {
    try {
      const output = await invoke<string>("run_sys_command", candidate);
      if (output.trim()) {
        return { installed: true, version: output.trim() };
      }
    } catch {
      // 尝试下一个候选命令。
    }
  }

  return { installed: false };
}

export async function autoDetectOpenClawConfig(): Promise<DetectedOpenClawConfig> {
  try {
    const detected = await invoke<DetectedOpenClawConfig>("auto_detect_openclaw_config");
    return detected;
  } catch {
    return { found: false };
  }
}

// ---------------------------------------------------------------------------
// OpenClaw V2 WebSocket Protocol — aligned with openclaw/src/gateway/client.ts
// ---------------------------------------------------------------------------

/** Valid client.mode values (src/gateway/protocol/client-info.ts) */
export const GATEWAY_CLIENT_MODES = {
  WEBCHAT: "webchat",
  CLI: "cli",
  UI: "ui",
  BACKEND: "backend",
  NODE: "node",
  PROBE: "probe",
  TEST: "test",
} as const;
export type GatewayClientMode = (typeof GATEWAY_CLIENT_MODES)[keyof typeof GATEWAY_CLIENT_MODES];

/** Recognized client.id values */
export const GATEWAY_CLIENT_IDS = {
  CONTROL_UI: "openclaw-control-ui",
  CLI: "cli",
  TUI: "openclaw-tui",
  WEBCHAT: "webchat",
  WEBCHAT_UI: "webchat-ui",
  GATEWAY_CLIENT: "gateway-client",
  MACOS_APP: "openclaw-macos",
  IOS_APP: "openclaw-ios",
  ANDROID_APP: "openclaw-android",
  NODE_HOST: "node-host",
  PROBE: "openclaw-probe",
} as const;

// ---------------------------------------------------------------------------
// Device Identity — uses Ed25519 (matching openclaw/ui/src/ui/device-identity.ts)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "selfclaw-device-identity-v1";
const CLIENT_VERSION = "0.1.0";

interface StoredIdentity {
  version: 1;
  deviceId: string;
  publicKey: string; // base64url
  privateKey: string; // base64url
  createdAtMs: number;
}

interface DeviceIdentity {
  deviceId: string;
  publicKey: string; // base64url
  privateKey: string; // base64url
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fingerprintPublicKey(publicKey: Uint8Array): Promise<string> {
  const hash = await sha512(publicKey);
  return bytesToHex(new Uint8Array(hash).slice(0, 16));
}

async function generateIdentity(): Promise<DeviceIdentity> {
  const privateKeyBytes = randomBytes(32);
  // Derive public key from private key using Ed25519
  const publicKey = await getPublicKeyAsync(privateKeyBytes);
  const deviceId = await fingerprintPublicKey(publicKey);
  return {
    deviceId,
    publicKey: base64UrlEncode(publicKey),
    privateKey: base64UrlEncode(privateKeyBytes),
  };
}

async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredIdentity;
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKey === "string" &&
        typeof parsed.privateKey === "string"
      ) {
        // Re-derive deviceId from public key to prevent tampering
        const publicKeyBytes = base64UrlDecode(parsed.publicKey);
        const derivedId = await fingerprintPublicKey(publicKeyBytes);
        if (derivedId !== parsed.deviceId) {
          // Tampering detected — regenerate
          const identity = await generateIdentity();
          const stored: StoredIdentity = { version: 1, ...identity, createdAtMs: Date.now() };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
          return identity;
        }
        return { deviceId: derivedId, publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      }
    }
  } catch {
    // Fall through to regenerate
  }

  const identity = await generateIdentity();
  const stored: StoredIdentity = { version: 1, ...identity, createdAtMs: Date.now() };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // localStorage may be unavailable (e.g. in certain environments)
  }
  return identity;
}

async function signDevicePayload(privateKeyBase64Url: string, payload: string): Promise<string> {
  const privateKeyBytes = base64UrlDecode(privateKeyBase64Url);
  const data = new TextEncoder().encode(payload);
  const signature = await signAsync(data, privateKeyBytes);
  return base64UrlEncode(signature);
}

// ---------------------------------------------------------------------------
// Device Auth Payload Builders — exact match with openclaw/src/gateway/device-auth.ts
// V3 is preferred (includes platform + deviceFamily)
// ---------------------------------------------------------------------------

interface DeviceAuthPayloadV3Params {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
  platform?: string | null;
  deviceFamily?: string | null;
}

function buildDeviceAuthPayloadV3(params: DeviceAuthPayloadV3Params): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  const platform = params.platform ?? "";
  const deviceFamily = params.deviceFamily ?? "";
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join("|");
}

// ---------------------------------------------------------------------------
// Error codes (from openclaw/src/gateway/protocol/connect-error-details.ts)
// ---------------------------------------------------------------------------

const ERROR_CODE = {
  AUTH_TOKEN_MISMATCH: "AUTH_TOKEN_MISMATCH",
  AUTH_TOKEN_MISSING: "AUTH_TOKEN_MISSING",
  AUTH_PASSWORD_MISSING: "AUTH_PASSWORD_MISSING",
  AUTH_PASSWORD_MISMATCH: "AUTH_PASSWORD_MISMATCH",
  AUTH_BOOTSTRAP_TOKEN_INVALID: "AUTH_BOOTSTRAP_TOKEN_INVALID",
  AUTH_RATE_LIMITED: "AUTH_RATE_LIMITED",
  PAIRING_REQUIRED: "PAIRING_REQUIRED",
  CONTROL_UI_DEVICE_IDENTITY_REQUIRED: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED",
  DEVICE_IDENTITY_REQUIRED: "DEVICE_IDENTITY_REQUIRED",
  DEVICE_AUTH_INVALID: "DEVICE_AUTH_INVALID",
  DEVICE_AUTH_SIGNATURE_INVALID: "DEVICE_AUTH_SIGNATURE_INVALID",
  DEVICE_AUTH_PUBLIC_KEY_INVALID: "DEVICE_AUTH_PUBLIC_KEY_INVALID",
} as const;

function resolveErrorCode(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  return typeof d.code === "string" ? d.code : null;
}

function resolveAdvice(
  details: unknown
): { canRetryWithDeviceToken?: boolean; recommendedNextStep?: string } {
  if (!details || typeof details !== "object") return {};
  const d = details as Record<string, unknown>;
  return {
    canRetryWithDeviceToken: typeof d.canRetryWithDeviceToken === "boolean" ? d.canRetryWithDeviceToken : undefined,
    recommendedNextStep: typeof d.recommendedNextStep === "string" ? d.recommendedNextStep : undefined,
  };
}

function isNonRecoverable(code: string | null): boolean {
  if (!code) return false;
  return (
    code === ERROR_CODE.AUTH_TOKEN_MISSING ||
    code === ERROR_CODE.AUTH_BOOTSTRAP_TOKEN_INVALID ||
    code === ERROR_CODE.AUTH_PASSWORD_MISSING ||
    code === ERROR_CODE.AUTH_PASSWORD_MISMATCH ||
    code === ERROR_CODE.AUTH_RATE_LIMITED ||
    code === ERROR_CODE.PAIRING_REQUIRED ||
    code === ERROR_CODE.CONTROL_UI_DEVICE_IDENTITY_REQUIRED ||
    code === ERROR_CODE.DEVICE_IDENTITY_REQUIRED
  );
}

function isDeviceAuthError(code: string | null): boolean {
  if (!code) return false;
  return (
    code === ERROR_CODE.DEVICE_AUTH_INVALID ||
    code === ERROR_CODE.DEVICE_AUTH_SIGNATURE_INVALID ||
    code === ERROR_CODE.DEVICE_AUTH_PUBLIC_KEY_INVALID ||
    code === ERROR_CODE.CONTROL_UI_DEVICE_IDENTITY_REQUIRED
  );
}

/** 网关有时用纯文本/ reason 表示身份不匹配，而不走 details.code */
function identityMismatchFromRes(resFrame: {
  error?: { message?: string; details?: { reason?: string; code?: string } };
}): boolean {
  const msg = String(resFrame.error?.message || "").toLowerCase();
  const reason = String(
    resFrame.error?.details && typeof resFrame.error.details === "object"
      ? (resFrame.error.details as { reason?: string }).reason || ""
      : ""
  ).toLowerCase();
  const blob = `${msg} ${reason}`;
  return (
    blob.includes("device identity") ||
    blob.includes("identity mismatch") ||
    blob.includes("device identity mismatch")
  );
}

function requiresRegisteredDeviceConnect(code: string | null): boolean {
  if (!code) return false;
  return (
    code === ERROR_CODE.CONTROL_UI_DEVICE_IDENTITY_REQUIRED ||
    code === ERROR_CODE.DEVICE_IDENTITY_REQUIRED
  );
}

/** 与 openclaw AgentParamsSchema 对齐（见 src/gateway/protocol/schema/agent.ts） */
function buildGatewayAgentParams(
  userMessage: string,
  config: OpenClawConfig | undefined
): Record<string, unknown> {
  const trimmed = userMessage.trim();
  const message = trimmed.length > 0 ? trimmed : "\u00a0";
  const idempotencyKey =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? `selfclaw-${crypto.randomUUID()}`
      : `selfclaw-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

  const params: Record<string, unknown> = {
    message,
    idempotencyKey,
  };

  const extraSystemPrompt = config?.systemPrompt?.trim();
  if (extraSystemPrompt) params.extraSystemPrompt = extraSystemPrompt;

  const sessionKey = config?.sessionKey?.trim();
  if (sessionKey) params.sessionKey = sessionKey;

  return params;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstMeaningfulString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (/^(accepted|completed|ok)$/i.test(trimmed)) continue;
    return trimmed;
  }
  return "";
}

function extractGatewayPayloadText(payload: unknown): string {
  if (typeof payload === "string") {
    return payload.trim();
  }

  if (!isRecord(payload)) {
    return "";
  }

  const direct = firstMeaningfulString(payload.text, payload.content);
  if (direct) {
    return direct;
  }

  const content = payload.content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text.trim() : ""))
      .filter(Boolean)
      .join("\n");
    if (text) {
      return text;
    }
  }

  const parts = payload.parts;
  if (Array.isArray(parts)) {
    const text = parts
      .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text.trim() : ""))
      .filter(Boolean)
      .join("\n");
    if (text) {
      return text;
    }
  }

  return "";
}

function extractGatewayPayloadTexts(
  payloads: unknown[],
  opts?: { includeErrors?: boolean }
): string[] {
  const texts: string[] = [];

  for (const entry of payloads) {
    if (isRecord(entry)) {
      if (entry.isReasoning === true) continue;
      if (!opts?.includeErrors && entry.isError === true) continue;
    }

    const text = extractGatewayPayloadText(entry);
    if (text) {
      texts.push(text);
    }
  }

  return texts;
}

function extractAgentResponseText(payload: unknown, streamedText: string): string {
  if (!isRecord(payload)) {
    return streamedText.trim();
  }

  const result = isRecord(payload.result) ? payload.result : undefined;
  const payloadGroups = [
    Array.isArray(result?.payloads) ? result.payloads : [],
    Array.isArray(result?.deliveryPayloads) ? result.deliveryPayloads : [],
    Array.isArray(payload.payloads) ? payload.payloads : [],
  ];

  for (const group of payloadGroups) {
    const texts = extractGatewayPayloadTexts(group);
    if (texts.length > 0) {
      return texts.join("\n\n").trim();
    }
  }

  for (const group of payloadGroups) {
    const texts = extractGatewayPayloadTexts(group, { includeErrors: true });
    if (texts.length > 0) {
      return texts.join("\n\n").trim();
    }
  }

  return (
    firstMeaningfulString(
      result?.outputText,
      result?.response,
      payload.response,
      result?.summary,
      payload.summary
    ) || streamedText.trim()
  );
}

// ---------------------------------------------------------------------------
// sendMessageToOpenClaw — V2 WebSocket protocol (aligned with openclaw/src/gateway/client.ts)
// ---------------------------------------------------------------------------

export async function sendMessageToOpenClaw(
  message: string,
  config?: OpenClawConfig,
  onStream?: StreamCallback
): Promise<{ success: boolean; response?: string; error?: string }> {
  const authToken = config?.gatewayToken?.trim() || config?.apiKey?.trim();
  if (!authToken) {
    return { success: false, error: "未配置网关认证凭证（gatewayToken 或 apiKey）" };
  }

  const port = config?.gatewayPort ?? 18789;
  const wsUrl = `ws://127.0.0.1:${port}`;

  const clientId = GATEWAY_CLIENT_IDS.CONTROL_UI; // "openclaw-control-ui"
  const clientVersion = CLIENT_VERSION;
  const clientMode = GATEWAY_CLIENT_MODES.WEBCHAT;
  const platform = typeof navigator !== "undefined" ? navigator.platform : "unknown";
  const locale = typeof navigator !== "undefined" ? navigator.language || "zh-CN" : "zh-CN";
  const userAgent =
    typeof navigator !== "undefined"
      ? navigator.userAgent || `${clientId}/${clientVersion}`
      : `${clientId}/${clientVersion}`;
  const role = "operator";
  const scopes = ["operator.read", "operator.write", "operator.admin", "operator.approvals", "operator.pairing"];

  return new Promise((resolve) => {
    let settled = false;
    let accumulated = "";
    let ws: WebSocket | null = null;
    let deviceIdentity: DeviceIdentity | null = null;
    let nonce: string | null = null;
    let pendingConnectErrorCode: string | null = null;
    let helloOkReceived = false;
    let agentRequestId: string | null = null;
    let agentRunId: string | null = null;
    let agentStreamCompleted = false;
    const connectRequestIds = new Set<string>();
    /** 本轮会话最后一次 connect 是 token-only 还是带 device（用于重试顺序） */
    let lastConnectKind: "no-device" | "device" | null = null;
    let handledChallengeNonce: string | null = null;
    let mismatchReconnectDone = false;
    let initialConnectHandle: number | null = null;
    let timeoutHandle: number | undefined;

    const clearRequestTimeout = () => {
      if (timeoutHandle !== undefined) {
        window.clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
    };

    const armConnectTimeout = () => {
      clearRequestTimeout();
      timeoutHandle = window.setTimeout(() => {
        if (!settled) {
          settle({ success: false, error: "网关连接超时（15s）" });
        }
      }, 15000);
    };

    const armFinalTimeout = () => {
      clearRequestTimeout();
      timeoutHandle = window.setTimeout(() => {
        if (!settled) {
          settle({ success: false, error: "等待网关最终响应超时（120s）" });
        }
      }, 120000);
    };

    const armTimeout = armConnectTimeout;

    const settle = (result: { success: boolean; response?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      if (initialConnectHandle !== null) {
        window.clearTimeout(initialConnectHandle);
        initialConnectHandle = null;
      }
      clearRequestTimeout();
      ws?.close();
      resolve(result);
    };

    const nextId = (() => {
      let counter = 0;
      return () => `req-${Date.now()}-${++counter}`;
    })();

    const queueInitialConnect = () => {
      if (initialConnectHandle !== null) {
        window.clearTimeout(initialConnectHandle);
      }

      initialConnectHandle = window.setTimeout(() => {
        initialConnectHandle = null;

        if (
          settled ||
          helloOkReceived ||
          lastConnectKind !== null ||
          !ws ||
          ws.readyState !== WebSocket.OPEN
        ) {
          return;
        }

        lastConnectKind = "no-device";
        armConnectTimeout();
        void sendConnectWithoutDevice();
      }, 750);
    };

    armConnectTimeout();

    const attachSocketHandlers = (socket: WebSocket) => {
      socket.onopen = () => {
        queueInitialConnect();
      };

      socket.onmessage = onMessage;
      socket.onerror = onError;
      socket.onclose = onClose;
    };

    function onError() {
      clearRequestTimeout();
      if (!settled) {
        settle({ success: false, error: "无法连接本地网关 WebSocket" });
        return;
      }
    }

    function onClose(ev: CloseEvent) {
      if (initialConnectHandle !== null) {
        window.clearTimeout(initialConnectHandle);
        initialConnectHandle = null;
      }
      clearRequestTimeout();
      if (settled) return;

      const reason = String(ev.reason || "");
      const mismatch =
        ev.code === 1008 && /device identity|identity mismatch/i.test(reason);

      if (!helloOkReceived && mismatch && !mismatchReconnectDone) {
        mismatchReconnectDone = true;
        handledChallengeNonce = null;
        lastConnectKind = null;
        nonce = null;
        connectRequestIds.clear();
        agentRequestId = null;
        agentRunId = null;
        agentStreamCompleted = false;
        armTimeout();
        const next = new WebSocket(wsUrl);
        ws = next;
        attachSocketHandlers(next);
        return;
      }

      if (agentStreamCompleted && accumulated.trim()) {
        onStream?.("", true);
        settle({ success: true, response: accumulated });
      } else {
        const closeDetail = mismatch || /device identity|identity mismatch/i.test(reason)
          ? `（${reason || "device identity mismatch"}）`
          : "";
        settle({
          success: false,
          error: `网关连接关闭（${ev.code}）${closeDetail}`,
        });
        return;
      }
    }

    const matchesAgentRun = (payload: Record<string, unknown> | undefined) => {
      if (!payload || !agentRunId) return true;
      const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
      return !runId || runId === agentRunId;
    };

    async function onMessage(event: MessageEvent) {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = frame.type as string;

      // ── connect.challenge ──────────────────────────────────────────────────
      if (type === "event" && frame.event === "connect.challenge") {
        if (initialConnectHandle !== null) {
          window.clearTimeout(initialConnectHandle);
          initialConnectHandle = null;
        }
        const payload = frame.payload as Record<string, unknown> | undefined;
        nonce = typeof payload?.nonce === "string" && payload.nonce.trim().length > 0
          ? payload.nonce.trim()
          : null;

        if (!nonce) {
          settle({ success: false, error: "网关 challenge 缺少 nonce" });
          return;
        }

        if (handledChallengeNonce === nonce) return;
        handledChallengeNonce = nonce;
        // 本地网关常开 allowInsecureAuth：优先仅 token 连接，避免缓存的 device 与网关登记不一致导致 1008
        lastConnectKind = "no-device";
        void sendConnectWithoutDevice();
        return;
      }

      // ── Response frame ────────────────────────────────────────────────────
      if (type === "res") {
        const resFrame = frame as {
          id?: string;
          ok: boolean;
          payload?: Record<string, unknown>;
          error?: {
            code?: string;
            message?: string;
            details?: {
              code?: string;
              reason?: string;
              canRetryWithDeviceToken?: boolean;
              recommendedNextStep?: string;
            };
          };
        };
        const responseId = typeof resFrame.id === "string" ? resFrame.id : null;
        const payload = isRecord(resFrame.payload) ? resFrame.payload : undefined;

        if (responseId && connectRequestIds.has(responseId)) {
          connectRequestIds.delete(responseId);
        }

        if (resFrame.ok && responseId && payload?.type === "hello-ok") {
          helloOkReceived = true;
          pendingConnectErrorCode = null;
          const agentParams = buildGatewayAgentParams(message, config);
          if (ws && ws.readyState === WebSocket.OPEN) {
            const requestId = nextId();
            agentRequestId = requestId;
            agentRunId = null;
            agentStreamCompleted = false;
            ws.send(JSON.stringify({ type: "req", id: requestId, method: "agent", params: agentParams }));
            armFinalTimeout();
          } else {
            settle({ success: false, error: "WebSocket disconnected before agent request was sent" });
          }
          return;
        }

        if (resFrame.ok && responseId && agentRequestId === responseId) {
          const status = typeof payload?.status === "string" ? payload.status : "";
          const runId = typeof payload?.runId === "string" ? payload.runId.trim() : "";

          if (runId) {
            agentRunId = runId;
          }

          if (status === "accepted") {
            armFinalTimeout();
            return;
          }

          const text = extractAgentResponseText(payload, accumulated);
          if (text) {
            accumulated = text;
          }

          if (status === "error") {
            settle({ success: false, error: text || "Agent run failed" });
            return;
          }

          onStream?.("", true);
          settle({ success: true, response: accumulated || undefined });
          return;
        }

        if (resFrame.ok && helloOkReceived) {
          if (payload?.runId && typeof payload.runId === "string") {
            agentRunId = payload.runId.trim() || agentRunId;
          }
          armFinalTimeout();
          return;
        }

        if (resFrame.ok) {
          // Check payload type to identify connect response
          const pl = resFrame.payload;
          if (pl && (pl as Record<string, unknown>).type === "hello-ok") {
            helloOkReceived = true;
            // AgentParamsSchema: message + idempotencyKey + 可选字段（禁止 messages/baseUrl/stream 等）
            const agentParams = buildGatewayAgentParams(message, config);
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "req", id: nextId(), method: "agent", params: agentParams }));
            }
            return;
          }

          // agent 可能先返回仅含 runId 的受理帧，正文由后续 event 流式推送
          const plObj = pl as Record<string, unknown> | undefined;
          const response = plObj?.response as string | undefined;
          const summary = plObj?.summary as string | undefined;
          const runId = plObj?.runId;
          if (
            (response === undefined || response === "") &&
            (summary === undefined || summary === "") &&
            typeof runId === "string" &&
            runId.length > 0
          ) {
            return;
          }

          const text = response || summary || "";
          if (text && text !== accumulated) accumulated = text;
          if (onStream) onStream("", true);
          settle({ success: true, response: accumulated || undefined });
          return;
        }

        // Error response
        const errorCode = resolveErrorCode(resFrame.error?.details);
        const advice = resolveAdvice(resFrame.error?.details);
        const mismatchText = identityMismatchFromRes(resFrame);

        if (!helloOkReceived) {
          // connect 阶段：按顺序重试（曾误用 connectSent 导致永远无法回退到无 device）
          if (lastConnectKind === "no-device" && requiresRegisteredDeviceConnect(errorCode)) {
            pendingConnectErrorCode = null;
            lastConnectKind = "device";
            void sendConnect();
            return;
          }

          if (
            lastConnectKind === "device" &&
            (isDeviceAuthError(errorCode) || mismatchText)
          ) {
            pendingConnectErrorCode = null;
            lastConnectKind = "no-device";
            void sendConnectWithoutDevice();
            return;
          }

          if (
            lastConnectKind === "device" &&
            errorCode === ERROR_CODE.AUTH_TOKEN_MISMATCH &&
            advice.canRetryWithDeviceToken === true
          ) {
            pendingConnectErrorCode = null;
            lastConnectKind = "no-device";
            void sendConnectWithoutDevice();
            return;
          }

          if (lastConnectKind === "no-device" && mismatchText) {
            pendingConnectErrorCode = null;
            lastConnectKind = "device";
            void sendConnect();
            return;
          }

          pendingConnectErrorCode = errorCode;
          const msg =
            resFrame.error?.message ||
            (errorCode ? `认证失败: ${errorCode}` : "网关认证失败");
          settle({ success: false, error: msg });
          return;
        }

        pendingConnectErrorCode = errorCode;
        const msg =
          resFrame.error?.message ||
          (errorCode ? `请求失败: ${errorCode}` : "网关请求失败");
        settle({ success: false, error: msg });
        return;
      }

      // ── Error frame (not res) ─────────────────────────────────────────────
      if (type === "error") {
        const err = frame as { message?: string };
        settle({ success: false, error: err.message || "网关返回未知错误" });
        return;
      }

      // ── Event frame ───────────────────────────────────────────────────────
      if (type === "event") {
        const ev = frame as { event: string; payload?: Record<string, unknown> };
        const payload = isRecord(ev.payload) ? ev.payload : undefined;

        if (!matchesAgentRun(payload)) {
          return;
        }

        if (ev.event === "agent" || ev.event === "agent.text") {
          const text = extractGatewayPayloadText(payload);
          if (text) {
            accumulated += text;
            onStream?.(text, false);
            armFinalTimeout();
          }
          const done = Boolean(payload?.done) || payload?.status === "completed";
          if (done) {
            agentStreamCompleted = true;
            onStream?.("", true);
            armFinalTimeout();
          }
          return;
        }

        if (ev.event === "chat") {
          const p = payload as {
            state?: string;
            message?: unknown;
            errorMessage?: string;
          } | undefined;
          if (p?.state === "delta" && p.message != null) {
            const m = p.message;
            let chunk = "";
            if (typeof m === "string") chunk = m;
            else if (m && typeof m === "object" && "content" in m) {
              const c = (m as { content?: unknown }).content;
              if (typeof c === "string") chunk = c;
            }
            if (chunk) {
              accumulated += chunk;
              onStream?.(chunk, false);
              armFinalTimeout();
            }
          }
          if (p?.state === "final") {
            agentStreamCompleted = true;
            onStream?.("", true);
            armFinalTimeout();
          }
          if (p?.state === "error") {
            settle({ success: false, error: p.errorMessage || "网关 chat 错误" });
          }
          return;
        }

        if (ev.event === "agent.done") {
          agentStreamCompleted = true;
          onStream?.("", true);
          armFinalTimeout();
          return;
        }

        if (ev.event === "agent" || ev.event === "agent.text") {
          const p = ev.payload;
          const text =
            typeof p?.content === "string" ? p.content
            : typeof p?.text === "string" ? p.text
            : "";
          if (text) {
            accumulated += text;
            onStream?.(text, false);
          }
          const done = Boolean(p?.done) || p?.status === "completed";
          if (done) {
            onStream?.("", true);
            settle({ success: true, response: accumulated || undefined });
          }
          return;
        }

        // chat.send 流式事件（ChatEventSchema）
        if (ev.event === "chat") {
          const p = ev.payload as {
            state?: string;
            message?: unknown;
            errorMessage?: string;
          };
          if (p?.state === "delta" && p.message != null) {
            const m = p.message;
            let chunk = "";
            if (typeof m === "string") chunk = m;
            else if (m && typeof m === "object" && "content" in m) {
              const c = (m as { content?: unknown }).content;
              if (typeof c === "string") chunk = c;
            }
            if (chunk) {
              accumulated += chunk;
              onStream?.(chunk, false);
            }
          }
          if (p?.state === "final") {
            onStream?.("", true);
            settle({ success: true, response: accumulated || undefined });
          }
          if (p?.state === "error") {
            settle({ success: false, error: p.errorMessage || "网关 chat 错误" });
          }
          return;
        }

        if (ev.event === "agent.done") {
          onStream?.("", true);
          settle({ success: true, response: accumulated || undefined });
          return;
        }

        return;
      }
    }

    ws = new WebSocket(wsUrl);
    attachSocketHandlers(ws);

    // Build device-auth connect params
    async function buildDeviceConnectParams(): Promise<Record<string, unknown> | null> {
      if (!nonce) return null;

      // Load/create device identity (stable, cached in localStorage)
      if (!deviceIdentity) {
        try {
          deviceIdentity = await loadOrCreateDeviceIdentity();
        } catch (err) {
          console.warn("[openclaw] 设备身份生成失败，尝试无设备认证:", err);
          return null;
        }
      }

      const signedAtMs = Date.now();
      const payload = buildDeviceAuthPayloadV3({
        deviceId: deviceIdentity.deviceId,
        clientId,
        clientMode,
        role,
        scopes,
        signedAtMs,
        token: authToken ?? null,
        nonce,
        platform,
        deviceFamily: null,
      });
      const signature = await signDevicePayload(deviceIdentity.privateKey, payload);

      return {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: clientId,
          version: clientVersion,
          platform,
          mode: clientMode,
        },
        caps: ["tool-events"],
        commands: [],
        permissions: {},
        role,
        scopes,
        auth: { token: authToken },
        locale,
        userAgent,
        device: {
          id: deviceIdentity.deviceId,
          publicKey: deviceIdentity.publicKey,
          signature,
          signedAt: signedAtMs,
          nonce,
        },
      };
    }

    // Build no-device connect params (for loopback insecure auth fallback)
    function buildNoDeviceConnectParams(): Record<string, unknown> {
      return {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: clientId,
          version: clientVersion,
          platform,
          mode: clientMode,
        },
        caps: ["tool-events"],
        commands: [],
        permissions: {},
        role,
        scopes,
        auth: { token: authToken },
        locale,
        userAgent,
      };
    }

    async function sendConnect() {
      const params = await buildDeviceConnectParams();
      if (!params) {
        lastConnectKind = "no-device";
        void sendConnectWithoutDevice();
        return;
      }
      lastConnectKind = "device";
      if (ws && ws.readyState === WebSocket.OPEN) {
        const requestId = nextId();
        connectRequestIds.add(requestId);
        armConnectTimeout();
        ws.send(JSON.stringify({ type: "req", id: requestId, method: "connect", params }));
      }
    }

    async function sendConnectWithoutDevice() {
      const params = buildNoDeviceConnectParams();
      if (ws && ws.readyState === WebSocket.OPEN) {
        const requestId = nextId();
        connectRequestIds.add(requestId);
        armConnectTimeout();
        ws.send(JSON.stringify({ type: "req", id: requestId, method: "connect", params }));
      }
    }
  });
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function runOpenClawCommand(
  command: string,
  args: string[] = []
): Promise<{ success: boolean; output?: string; error?: string }> {
  try {
    const finalArgs = command ? [command, ...args] : args;
    const output = await invoke<string>("run_sys_command", {
      command: "openclaw",
      args: finalArgs,
    });
    return { success: true, output };
  } catch (error) {
    return { success: false, error: `命令执行失败：${stripAnsi(String(error))}` };
  }
}
