import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  AlertCircle,
  Download,
  LoaderCircle,
  MessageSquarePlus,
  Send,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui";
import { PROVIDER_MODELS } from "@/lib/models";
import { sendMessageToOpenClaw, type StreamCallback } from "@/lib/openclaw";
import { isIgnorableTauriInvokeError } from "@/lib/tauriErrors";
import { cn, formatTimestamp, generateId } from "@/lib/utils";
import { useAppStore, type Message, type Session } from "@/store/appStore";

const LazyMarkdownMessage = lazy(() => import("@/components/MarkdownMessage"));

interface GatewayStatus {
  running: boolean;
}

interface DroppedFileAnalysis {
  file_name: string;
  size: number;
  line_count: number;
  preview: string;
}

const ROLE_LABELS: Record<Message["role"], string> = {
  user: "用户",
  assistant: "助手",
  system: "系统",
};

const MARKDOWN_ROLE_LABELS: Record<Message["role"], string> = {
  user: "User",
  assistant: "AI",
  system: "System",
};

function sanitizeFileName(input: string): string {
  return input.replace(/[\\\\/:*?"<>|]/g, "_").trim() || "session";
}

function buildSessionMarkdown(session: Session): string {
  const chunks: string[] = [];
  chunks.push(`# ${session.title}`);
  chunks.push("");
  chunks.push(`- 会话 ID: ${session.id}`);
  chunks.push(`- 创建时间: ${new Date(session.createdAt).toLocaleString()}`);
  chunks.push(`- 更新时间: ${new Date(session.updatedAt).toLocaleString()}`);
  chunks.push("");
  chunks.push("---");
  chunks.push("");

  for (const message of session.messages) {
    const role = MARKDOWN_ROLE_LABELS[message.role] ?? message.role;
    const time = new Date(message.timestamp).toLocaleString();
    chunks.push(`**${role}** (${time})`);
    chunks.push("");
    chunks.push(message.content || "_(empty)_");
    if (message.files?.length) {
      chunks.push("");
      chunks.push(`附件: ${message.files.join(", ")}`);
    }
    if (typeof message.tokenUsage === "number") {
      chunks.push(`Token Usage: ${message.tokenUsage}`);
    }
    chunks.push("");
    chunks.push("---");
    chunks.push("");
  }

  return chunks.join("\n");
}

async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else if (reader.result instanceof ArrayBuffer) {
        resolve(`[二进制文件:${file.name}:${reader.result.byteLength}]`);
      } else {
        resolve("");
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsText(file);
  });
}

export function ChatInterface() {
  const {
    sessions,
    currentSessionId,
    addSession,
    setCurrentSession,
    addMessage,
    updateMessage,
    deleteSession,
    openclaw,
    setOpenClawConfig,
  } = useAppStore();

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [gatewayRunning, setGatewayRunning] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [infoText, setInfoText] = useState("");
  const [exporting, setExporting] = useState(false);
  const [selectedModel, setSelectedModel] = useState(openclaw.model ?? "codex-mini-latest");

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const currentSession = useMemo(
    () => sessions.find((item) => item.id === currentSessionId) ?? null,
    [currentSessionId, sessions]
  );

  const modelOptions = useMemo(() => {
    const provider = openclaw.provider ?? "openai";
    const models = PROVIDER_MODELS[provider] ?? [];
    if (!models.some((item) => item.id === "codex-mini-latest")) {
      return [{ id: "codex-mini-latest", name: "codex-mini-latest" }, ...models];
    }
    return models;
  }, [openclaw.provider]);

  const ensureSession = useCallback(
    (titleHint: string): string => {
      if (currentSessionId) {
        return currentSessionId;
      }

      const id = generateId();
      const now = Date.now();
      addSession({
        id,
        title: titleHint.slice(0, 24) || "新对话",
        messages: [],
        createdAt: now,
        updatedAt: now,
      });
      return id;
    },
    [addSession, currentSessionId]
  );

  useEffect(() => {
    let isMounted = true;
    invoke<GatewayStatus>("get_gateway_status")
      .then((status) => {
        if (isMounted) {
          setGatewayRunning(status.running);
        }
      })
      .catch((error) => {
        if (!isMounted || isIgnorableTauriInvokeError(error)) {
          return;
        }
        setGatewayRunning(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const sendPrompt = useCallback(
    async (prompt: string, sessionId: string) => {
      if (!openclaw.apiKey && !openclaw.gatewayToken) {
        addMessage(sessionId, {
          id: generateId(),
          role: "assistant",
          content: "请先在设置页配置 API Key。",
          timestamp: Date.now(),
        });
        return;
      }

      if (!gatewayRunning) {
        addMessage(sessionId, {
          id: generateId(),
          role: "assistant",
          content: "网关当前离线，请先在控制面板中启动或重启网关。",
          timestamp: Date.now(),
        });
        return;
      }

      const assistantId = generateId();
      addMessage(sessionId, {
        id: assistantId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      });

      if (mountedRef.current) {
        setBusy(true);
      }
      let streamText = "";

      try {
        const onStream: StreamCallback = (chunk, done) => {
          if (done) {
            return;
          }
          streamText += chunk;
          updateMessage(sessionId, assistantId, { content: streamText });
        };

        const result = await sendMessageToOpenClaw(
          prompt,
          {
            apiKey: openclaw.apiKey,
            gatewayToken: openclaw.gatewayToken,
            gatewayPort: openclaw.gatewayPort,
            provider: openclaw.provider,
            model: selectedModel,
            baseUrl: openclaw.baseUrl,
            systemPrompt: openclaw.systemPrompt,
            temperature: openclaw.temperature,
            maxTokens: openclaw.maxTokens,
            sessionKey: `selfclaw-chat-${sessionId}`,
          },
          onStream
        );

        if (!result.success) {
          updateMessage(sessionId, assistantId, {
            content: result.error ?? "网关返回未知错误",
          });
        }
      } catch (error) {
        if (isIgnorableTauriInvokeError(error)) {
          return;
        }
        updateMessage(sessionId, assistantId, {
          content: `请求失败：${String(error)}`,
        });
      } finally {
        if (mountedRef.current) {
          setBusy(false);
        }
      }
    },
    [
      addMessage,
      gatewayRunning,
      openclaw.apiKey,
      openclaw.baseUrl,
      openclaw.gatewayPort,
      openclaw.gatewayToken,
      openclaw.maxTokens,
      openclaw.provider,
      openclaw.systemPrompt,
      openclaw.temperature,
      selectedModel,
      updateMessage,
    ]
  );

  const handleSend = async () => {
    const prompt = input.trim();
    if (!prompt || busy) {
      return;
    }

    const sessionId = ensureSession(prompt);
    addMessage(sessionId, {
      id: generateId(),
      role: "user",
      content: prompt,
      timestamp: Date.now(),
    });

    setInput("");
    await sendPrompt(prompt, sessionId);
  };

  const processDroppedFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) {
        return;
      }

      setDragging(false);
      const firstName = files[0]?.name ?? "文件";
      const sessionId = ensureSession(`文件: ${firstName}`);

      for (const file of files) {
        try {
          const rawText = await readFileAsText(file);
          const analysis = await invoke<DroppedFileAnalysis>("parse_dropped_file", {
            fileName: file.name,
            content: rawText,
          });

          const userMessage: Message = {
            id: generateId(),
            role: "user",
            content: `文件已拖入: ${analysis.file_name}\n大小: ${analysis.size} 字节\n行数: ${analysis.line_count}\n\n${analysis.preview}`,
            timestamp: Date.now(),
            files: [analysis.file_name],
          };
          addMessage(sessionId, userMessage);

          await sendPrompt(
            `请分析这个文件内容，并给出简洁的关键信息：\n\n${analysis.preview}`,
            sessionId
          );
        } catch (error) {
          if (isIgnorableTauriInvokeError(error)) {
            return;
          }
          if (mountedRef.current) {
            setStatusText(`文件解析失败：${String(error)}`);
          }
        }
      }
    },
    [addMessage, ensureSession, sendPrompt]
  );

  const onDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    await processDroppedFiles(files);
  };

  const createSession = () => {
    const id = generateId();
    const now = Date.now();
    addSession({
      id,
      title: "新对话",
      messages: [],
      createdAt: now,
      updatedAt: now,
    });
    setCurrentSession(id);
  };

  const exportCurrentSessionAsMarkdown = async () => {
    if (!currentSession) {
      setStatusText("当前没有可导出的会话");
      return;
    }

    if (exporting) {
      return;
    }

    setExporting(true);
    setStatusText("");
    setInfoText("");

    try {
      const markdown = buildSessionMarkdown(currentSession);
      const defaultName = `${sanitizeFileName(currentSession.title)}.md`;
      const savePath = await save({
        defaultPath: defaultName,
        filters: [
          {
            name: "Markdown",
            extensions: ["md"],
          },
        ],
      });

      if (!savePath) {
        return;
      }

      await writeTextFile(savePath, markdown);
      setInfoText(`已导出会话：${savePath}`);
    } catch (error) {
      if (isIgnorableTauriInvokeError(error)) {
        return;
      }
      setStatusText(`导出失败：${String(error)}`);
    } finally {
      if (mountedRef.current) {
        setExporting(false);
      }
    }
  };

  return (
    <section className="grid h-full grid-cols-[260px_1fr] overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900">
      <aside className="flex h-full flex-col border-r border-neutral-800 bg-neutral-900">
        <div className="p-3">
          <Button
            onClick={createSession}
            className="w-full bg-orange-500 text-white hover:bg-orange-400"
          >
            <MessageSquarePlus className="mr-2 h-4 w-4" />
            新建会话
          </Button>
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {sessions.map((session) => {
            const active = session.id === currentSessionId;
            return (
              <div
                key={session.id}
                className={cn(
                  "group flex cursor-pointer items-center rounded-lg px-3 py-2 text-sm transition",
                  active
                    ? "bg-orange-500/15 text-orange-300"
                    : "text-neutral-300 hover:bg-neutral-800"
                )}
                onClick={() => setCurrentSession(session.id)}
              >
                <span className="truncate">{session.title}</span>
                <button
                  className="ml-auto hidden rounded p-1 text-neutral-500 hover:bg-neutral-700 hover:text-red-400 group-hover:block"
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteSession(session.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      <div className="flex h-full flex-col bg-neutral-900">
        <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-neutral-100">对话沙盒</h2>
            <p className="text-xs text-neutral-400">网关{gatewayRunning ? "在线" : "离线"}</p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="border-neutral-700 bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
              onClick={() => void exportCurrentSessionAsMarkdown()}
              disabled={!currentSession || exporting}
            >
              {exporting ? (
                <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {exporting ? "导出中..." : "导出 Markdown"}
            </Button>
            <select
              value={selectedModel}
              onChange={(event) => {
                setSelectedModel(event.target.value);
                setOpenClawConfig({ model: event.target.value });
              }}
              className="h-9 rounded-lg border border-neutral-700 bg-neutral-800 px-3 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2"
            >
              {modelOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {!currentSession || currentSession.messages.length === 0 ? (
            <div className="rounded-xl border border-dashed border-neutral-700 bg-neutral-800/40 p-6 text-center text-neutral-400">
              开始对话，或将文件拖入下方输入区。
            </div>
          ) : (
            currentSession.messages.map((message) => (
              <article key={message.id} className="space-y-1">
                <div className="flex items-center justify-between text-xs text-neutral-500">
                  <span className="tracking-wide">{ROLE_LABELS[message.role]}</span>
                  <span>{formatTimestamp(message.timestamp)}</span>
                </div>
                <div
                  className={cn(
                    "rounded-lg border px-4 py-3 text-sm",
                    message.role === "user"
                      ? "border-orange-500/30 bg-orange-500/10 text-neutral-100"
                      : "border-neutral-700 bg-neutral-800 text-neutral-100"
                  )}
                >
                  <Suspense fallback={<pre className="whitespace-pre-wrap">{message.content}</pre>}>
                    <LazyMarkdownMessage content={message.content} />
                  </Suspense>
                </div>
              </article>
            ))
          )}
        </div>

        <footer className="border-t border-neutral-800 p-4">
          <div
            className={cn(
              "rounded-xl border bg-neutral-800 p-3 transition",
              dragging ? "border-orange-500 bg-orange-500/10" : "border-neutral-700"
            )}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <div className="mb-2 flex items-center gap-2 text-xs text-neutral-400">
              <Upload className="h-3.5 w-3.5" />
              将文件拖到这里，先由后端解析，再交给 AI 分析。
            </div>
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                rows={2}
                placeholder="输入消息..."
                className="min-h-[72px] flex-1 resize-none rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2"
              />
              <Button
                onClick={() => void handleSend()}
                disabled={!input.trim() || busy}
                className="h-10 bg-orange-500 text-white hover:bg-orange-400"
              >
                {busy ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          {infoText ? <p className="mt-2 text-xs text-neutral-300">{infoText}</p> : null}

          {statusText ? (
            <p className="mt-2 flex items-center gap-1 text-xs text-red-300">
              <AlertCircle className="h-3.5 w-3.5" />
              {statusText}
            </p>
          ) : null}
        </footer>
      </div>
    </section>
  );
}
