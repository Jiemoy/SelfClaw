import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ConsoleShell } from "@/components/ConsoleShell";
import { EnvironmentCheck } from "@/components/EnvironmentCheck";
import { Onboarding } from "@/components/Onboarding";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, resolveBaseUrl } from "@/lib/models";
import { TitleBar } from "@/components/TitleBar";
import { isIgnorableTauriInvokeError } from "@/lib/tauriErrors";
import { type OpenClawConfig, useAppStore } from "@/store/appStore";

interface BootOutcome {
  isSetupComplete: boolean;
  mappedConfig?: Partial<OpenClawConfig>;
  gatewayToken?: string | null;
}

let bootDetectionPromise: Promise<BootOutcome> | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readStringField(
  payload: Record<string, unknown>,
  fieldNames: string[]
): string | undefined {
  for (const fieldName of fieldNames) {
    const value = payload[fieldName];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function readNumberField(
  payload: Record<string, unknown>,
  fieldNames: string[]
): number | undefined {
  for (const fieldName of fieldNames) {
    const value = payload[fieldName];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function readBooleanField(
  payload: Record<string, unknown>,
  fieldNames: string[]
): boolean | undefined {
  for (const fieldName of fieldNames) {
    const value = payload[fieldName];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on", "enabled"].includes(normalized)) {
        return true;
      }
      if (["false", "0", "no", "off", "disabled"].includes(normalized)) {
        return false;
      }
    }
  }

  return undefined;
}

async function detectBootConfigOnce(): Promise<BootOutcome> {
  let gatewayToken: string | null = null;
  try {
    const [payload, tokenResult] = await Promise.all([
      invoke<Record<string, unknown>>("auto_detect_openclaw_config"),
      invoke<string>("get_gateway_auth_token").catch(() => null),
    ]);
    gatewayToken = tokenResult;
    console.log("【底层配置嗅探结果】:", JSON.stringify(payload, null, 2));
    if (gatewayToken) {
      console.log("【网关 Token】: 已获取（已脱敏）");
    }

    const targetData = asRecord(payload.data) ?? asRecord(payload.config) ?? payload;
    const apiKey =
      readStringField(targetData, ["apiKey", "api_key", "API_KEY"]) ??
      readStringField(payload, ["apiKey", "api_key", "API_KEY"]);
    const baseUrl =
      readStringField(targetData, ["baseUrl", "base_url", "BASE_URL"]) ??
      readStringField(payload, ["baseUrl", "base_url", "BASE_URL"]);
    const model =
      readStringField(targetData, [
        "defaultModel",
        "default_model",
        "DEFAULT_MODEL",
        "model",
        "MODEL",
      ]) ??
      readStringField(payload, [
        "defaultModel",
        "default_model",
        "DEFAULT_MODEL",
        "model",
        "MODEL",
      ]);
    const provider =
      readStringField(targetData, ["provider", "PROVIDER"]) ??
      readStringField(payload, ["provider", "PROVIDER"]);
    const systemPrompt =
      readStringField(targetData, ["systemPrompt", "system_prompt"]) ??
      readStringField(payload, ["systemPrompt", "system_prompt"]);
    const temperature =
      readNumberField(targetData, ["temperature", "TEMPERATURE"]) ??
      readNumberField(payload, ["temperature", "TEMPERATURE"]);
    const maxTokens =
      readNumberField(targetData, ["maxTokens", "max_tokens", "MAX_TOKENS"]) ??
      readNumberField(payload, ["maxTokens", "max_tokens", "MAX_TOKENS"]);
    const httpProxy =
      readStringField(targetData, ["httpProxy", "http_proxy", "HTTP_PROXY"]) ??
      readStringField(payload, ["httpProxy", "http_proxy", "HTTP_PROXY"]);
    const socks5Proxy =
      readStringField(targetData, ["socks5Proxy", "socks5_proxy", "SOCKS5_PROXY"]) ??
      readStringField(payload, ["socks5Proxy", "socks5_proxy", "SOCKS5_PROXY"]);
    const gatewayPort =
      readNumberField(targetData, ["gatewayPort", "gateway_port", "GATEWAY_PORT"]) ??
      readNumberField(payload, ["gatewayPort", "gateway_port", "GATEWAY_PORT"]);
    const logLevel =
      readStringField(targetData, ["logLevel", "log_level", "LOG_LEVEL"]) ??
      readStringField(payload, ["logLevel", "log_level", "LOG_LEVEL"]);
    const historyMessageLimit =
      readNumberField(targetData, [
        "historyMessageLimit",
        "history_message_limit",
        "HISTORY_MESSAGE_LIMIT",
      ]) ??
      readNumberField(payload, [
        "historyMessageLimit",
        "history_message_limit",
        "HISTORY_MESSAGE_LIMIT",
      ]);
    const longTermMemoryEnabled =
      readBooleanField(targetData, [
        "longTermMemoryEnabled",
        "long_term_memory_enabled",
        "LONG_TERM_MEMORY_ENABLED",
      ]) ??
      readBooleanField(payload, [
        "longTermMemoryEnabled",
        "long_term_memory_enabled",
        "LONG_TERM_MEMORY_ENABLED",
      ]);
    const autostartEnabled =
      readBooleanField(targetData, [
        "autostartEnabled",
        "autostart_enabled",
        "AUTOSTART_ENABLED",
      ]) ??
      readBooleanField(payload, [
        "autostartEnabled",
        "autostart_enabled",
        "AUTOSTART_ENABLED",
      ]);
    const customName =
      readStringField(targetData, ["customName", "custom_name"]) ??
      readStringField(payload, ["customName", "custom_name"]);

    const found =
      payload.found === true ||
      payload.is_setup_complete === true ||
      payload.isSetupComplete === true;
    const hasValidKey = Boolean(apiKey || baseUrl);
    const normalizedProvider = provider ?? DEFAULT_PROVIDER;

    if (!found && !hasValidKey) {
      console.log("底层确认无配置，进入向导");
      return { isSetupComplete: false };
    }

    return {
      isSetupComplete: true,
      gatewayToken,
      mappedConfig: {
        installed: true,
        apiKey,
        baseUrl: resolveBaseUrl(normalizedProvider, baseUrl),
        model: model ?? DEFAULT_MODEL,
        provider: normalizedProvider,
        systemPrompt,
        temperature,
        maxTokens,
        httpProxy,
        socks5Proxy,
        gatewayPort: gatewayPort ? Math.round(gatewayPort) : undefined,
        logLevel: ["info", "debug", "error"].includes(logLevel ?? "")
          ? (logLevel as "info" | "debug" | "error")
          : undefined,
        historyMessageLimit: historyMessageLimit
          ? Math.round(historyMessageLimit)
          : undefined,
        longTermMemoryEnabled,
        autostartEnabled,
        customName,
      },
    };
  } catch (error) {
    if (!isIgnorableTauriInvokeError(error)) {
      console.error("自动接管本地 OpenClaw 配置失败：", error);
    }
    return { isSetupComplete: false, gatewayToken };
  }
}

function getBootDetectionPromise(): Promise<BootOutcome> {
  if (!bootDetectionPromise) {
    bootDetectionPromise = detectBootConfigOnce();
  }

  return bootDetectionPromise;
}

function App() {
  const setOpenClawConfig = useAppStore((state) => state.setOpenClawConfig);
  const setEnvChecked = useAppStore((state) => state.setEnvChecked);
  const setOnboardingComplete = useAppStore((state) => state.setOnboardingComplete);
  const appendGatewayLog = useAppStore((state) => state.appendGatewayLog);
  const setGatewayStatus = useAppStore((state) => state.setGatewayStatus);
  const envChecked = useAppStore((state) => state.envChecked);
  const onboardingComplete = useAppStore((state) => state.onboardingComplete);

  const [isBooting, setIsBooting] = useState(true);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }

    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 2200);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    let unlistenLog: (() => void) | null = null;
    let unlistenExited: (() => void) | null = null;

    listen<string>("gateway-log-line", (event) => {
      if (!isMounted) {
        return;
      }

      appendGatewayLog(event.payload);
      setGatewayStatus("running");
    })
      .then((dispose) => {
        if (!isMounted) {
          dispose();
          return;
        }
        unlistenLog = dispose;
      })
      .catch((error) => {
        if (!isMounted || isIgnorableTauriInvokeError(error)) {
          return;
        }
        console.error("监听网关日志事件失败：", error);
      });

    listen("gateway-exited", () => {
      if (!isMounted) {
        return;
      }
      setGatewayStatus("offline");
    })
      .then((dispose) => {
        if (!isMounted) {
          dispose();
          return;
        }
        unlistenExited = dispose;
      })
      .catch((error) => {
        if (!isMounted || isIgnorableTauriInvokeError(error)) {
          return;
        }
        console.error("监听网关退出事件失败：", error);
      });

    return () => {
      isMounted = false;
      if (unlistenLog) {
        unlistenLog();
      }
      if (unlistenExited) {
        unlistenExited();
      }
    };
  }, [appendGatewayLog, setGatewayStatus]);

  useEffect(() => {
    const abortController = new AbortController();
    let isMounted = true;

    getBootDetectionPromise()
      .then((result) => {
        if (!isMounted || abortController.signal.aborted) {
          return;
        }

        if (result.isSetupComplete) {
          setEnvChecked(true);
          setOnboardingComplete(true);
          setOpenClawConfig({
            installed: true,
            apiKey: result.mappedConfig?.apiKey,
            baseUrl: result.mappedConfig?.baseUrl,
            model: result.mappedConfig?.model,
            provider: result.mappedConfig?.provider,
            systemPrompt: result.mappedConfig?.systemPrompt,
            temperature: result.mappedConfig?.temperature,
            maxTokens: result.mappedConfig?.maxTokens,
            httpProxy: result.mappedConfig?.httpProxy,
            socks5Proxy: result.mappedConfig?.socks5Proxy,
            gatewayPort: result.mappedConfig?.gatewayPort,
            logLevel: result.mappedConfig?.logLevel,
            historyMessageLimit: result.mappedConfig?.historyMessageLimit,
            longTermMemoryEnabled: result.mappedConfig?.longTermMemoryEnabled,
            autostartEnabled: result.mappedConfig?.autostartEnabled,
            customName: result.mappedConfig?.customName,
            gatewayToken: result.gatewayToken ?? undefined,
          });
          showToast("已无缝接入本地 OpenClaw 配置");
          return;
        }

        setEnvChecked(false);
        setOnboardingComplete(false);
        setOpenClawConfig({
          installed: false,
          apiKey: undefined,
          baseUrl: undefined,
          gatewayToken: result.gatewayToken ?? undefined,
        });
      })
      .catch((error) => {
        if (!isMounted || abortController.signal.aborted) {
          return;
        }

        if (!isIgnorableTauriInvokeError(error)) {
          console.error("启动检测失败：", error);
        }

        setEnvChecked(false);
        setOnboardingComplete(false);
        setOpenClawConfig({
          installed: false,
          apiKey: undefined,
          baseUrl: undefined,
        });
      })
      .finally(() => {
        if (!isMounted || abortController.signal.aborted) {
          return;
        }
        setIsBooting(false);
      });

    return () => {
      isMounted = false;
      abortController.abort();
    };
  }, [
    setEnvChecked,
    setOnboardingComplete,
    setOpenClawConfig,
    showToast,
  ]);

  const handleOnboardingComplete = useCallback(() => {
    setOnboardingComplete(true);
  }, [setOnboardingComplete]);

  const renderShell = (content: ReactNode) => (
    <div className="h-screen overflow-hidden bg-neutral-950 text-neutral-100">
      <TitleBar />
      <div className="h-full pt-8">{content}</div>

      {toastMessage ? (
        <div className="pointer-events-none fixed right-4 top-11 z-[70] rounded-lg border border-orange-500/40 bg-neutral-900/95 px-4 py-2 text-sm text-orange-200 shadow-lg">
          {toastMessage}
        </div>
      ) : null}
    </div>
  );

  if (isBooting) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-neutral-900 text-neutral-500">
        正在接管本地配置...
      </div>
    );
  }

  if (!envChecked) {
    return renderShell(<EnvironmentCheck onComplete={() => setEnvChecked(true)} />);
  }

  if (!onboardingComplete) {
    return renderShell(<Onboarding onComplete={handleOnboardingComplete} />);
  }

  return renderShell(<ConsoleShell />);
}

export default App;
