import { invoke } from "@tauri-apps/api/core";

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
        return {
          installed: true,
          version: output.trim(),
        };
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

export async function sendMessageToOpenClaw(
  message: string,
  config?: OpenClawConfig,
  onStream?: StreamCallback
): Promise<{ success: boolean; response?: string; error?: string }> {
  return new Promise((resolve) => {
    if (!config?.apiKey) {
      resolve({ success: false, error: "未配置 API Key" });
      return;
    }

    let settled = false;
    let accumulated = "";
    let requestCounter = 0;

    const settle = (result: { success: boolean; response?: string; error?: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const nextId = () => {
      requestCounter += 1;
      return `req-${Date.now()}-${requestCounter}`;
    };

    const ws = new WebSocket("ws://localhost:18789");

    ws.onopen = () => {
      const connectPayload = {
        type: "req",
        id: nextId(),
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: "openclaw-control-ui",
            version: "0.1.0",
            platform: navigator.platform || "unknown",
            mode: "webchat",
          },
          role: "operator",
          scopes: ["operator.read", "operator.write", "agent.execute"],
          auth: {
            token: config.apiKey,
          },
        },
      };

      ws.send(JSON.stringify(connectPayload));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as {
          type?: string;
          method?: string;
          ok?: boolean;
          error?: { message?: string };
          message?: string;
          event?: string;
          payload?: {
            content?: string;
            text?: string;
            done?: boolean;
            status?: string;
            response?: string;
            summary?: string;
          };
        };

        if (data.type === "res" && data.method === "connect") {
          if (!data.ok) {
            ws.close();
            settle({ success: false, error: data.error?.message ?? "网关认证失败" });
            return;
          }

          ws.send(
            JSON.stringify({
              type: "req",
              id: nextId(),
              method: "agent",
              params: {
                messages: [{ role: "user", content: message }],
                systemPrompt: config.systemPrompt,
                model: config.model ?? "codex-mini-latest",
                provider: config.provider ?? "openai",
                baseUrl: config.baseUrl,
                temperature: config.temperature,
                maxTokens: config.maxTokens,
                stream: Boolean(onStream),
              },
            })
          );
          return;
        }

        if (data.type === "event" && data.event === "agent") {
          const chunk = data.payload?.content ?? data.payload?.text ?? "";
          if (chunk) {
            accumulated += chunk;
            if (onStream) {
              onStream(chunk, false);
            }
          }

          const done = data.payload?.done || data.payload?.status === "completed";
          if (done) {
            if (onStream) {
              onStream("", true);
            }
            ws.close();
            settle({ success: true, response: accumulated });
          }
          return;
        }

        if (data.type === "res" && data.method === "agent") {
          const final = data.payload?.response ?? data.payload?.summary;
          if (final && final !== accumulated) {
            accumulated = final;
          }
          if (onStream) {
            onStream("", true);
          }
          ws.close();
          settle({ success: true, response: accumulated });
          return;
        }

        if (data.type === "error" || data.ok === false) {
          ws.close();
          settle({
            success: false,
            error: data.error?.message ?? data.message ?? "网关返回错误",
          });
        }
      } catch (error) {
        ws.close();
        settle({ success: false, error: `网关响应解析失败：${String(error)}` });
      }
    };

    ws.onerror = () => {
      ws.close();
      settle({ success: false, error: "无法连接本地网关 WebSocket" });
    };

    ws.onclose = () => {
      if (!settled) {
        if (accumulated) {
          if (onStream) {
            onStream("", true);
          }
          settle({ success: true, response: accumulated });
        } else {
          settle({ success: false, error: "网关连接异常关闭" });
        }
      }
    };

    window.setTimeout(() => {
      if (!settled && ws.readyState === WebSocket.OPEN) {
        ws.close();
        settle({ success: false, error: "网关请求超时" });
      }
    }, 15000);
  });
}

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
