import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import {
  AlertTriangle,
  Download,
  MessageSquarePlus,
  Paperclip,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui";
import { sendMessageToOpenClaw } from "@/lib/openclaw";
import { cn, formatTimestamp, generateId } from "@/lib/utils";
import { type Message, type Session, useAppStore } from "@/store/appStore";

interface PendingAttachment {
  id: string;
  name: string;
  size: number;
  path?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

const ROLE_LABELS: Record<Message["role"], string> = {
  user: "User",
  assistant: "AI",
  system: "System",
};

function sanitizeFileName(input: string): string {
  return input.replace(/[\\/:*?"<>|]/g, "_").trim() || "session";
}

function buildSessionMarkdown(session: Session): string {
  const lines: string[] = [];
  lines.push(`# ${session.title}`);
  lines.push("");
  lines.push(`- 会话 ID: ${session.id}`);
  lines.push(`- 创建时间: ${new Date(session.createdAt).toLocaleString()}`);
  lines.push(`- 更新时间: ${new Date(session.updatedAt).toLocaleString()}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const message of session.messages) {
    const role = ROLE_LABELS[message.role] ?? message.role;
    lines.push(`**${role}** (${new Date(message.timestamp).toLocaleString()})`);
    lines.push("");
    lines.push(message.content || "_(empty)_");
    if (message.files?.length) {
      lines.push("");
      lines.push(`附件: ${message.files.join(", ")}`);
    }
    if (typeof message.tokenUsage === "number") {
      lines.push(`Token Usage: ${message.tokenUsage}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

function toPendingAttachment(file: File): PendingAttachment {
  const fileWithPath = file as File & { path?: string };
  const normalizedPath = fileWithPath.path?.trim();

  return {
    id: generateId(),
    name: file.name,
    size: file.size,
    path: normalizedPath && normalizedPath.length > 0 ? normalizedPath : undefined,
  };
}

function extractAssistantContent(response: ChatCompletionResponse): string | null {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const text = content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text!.trim())
      .filter(Boolean)
      .join("\n");
    if (text) {
      return text;
    }
  }
  return null;
}

export function ChatSandbox() {
  const {
    openclaw,
    gatewayStatus,
    sessions,
    currentSessionId,
    addSession,
    setCurrentSession,
    addMessage,
    deleteSession,
  } = useAppStore();

  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [errorText, setErrorText] = useState("");

  const dragCounterRef = useRef(0);
  const messageContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!currentSessionId && sessions.length > 0) {
      setCurrentSession(sessions[0].id);
    }
  }, [currentSessionId, sessions, setCurrentSession]);

  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId) ?? null,
    [currentSessionId, sessions]
  );

  useEffect(() => {
    const container = messageContainerRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [currentSession?.messages]);

  const ensureSession = useCallback((): string => {
    if (currentSessionId) {
      const exists = sessions.some((session) => session.id === currentSessionId);
      if (exists) {
        return currentSessionId;
      }
    }

    if (sessions[0]) {
      setCurrentSession(sessions[0].id);
      return sessions[0].id;
    }

    const id = generateId();
    const now = Date.now();
    addSession({
      id,
      title: "新会话",
      messages: [],
      createdAt: now,
      updatedAt: now,
    });
    setCurrentSession(id);
    return id;
  }, [addSession, currentSessionId, sessions, setCurrentSession]);

  const ingestDroppedFiles = useCallback((files: File[]) => {
    if (files.length === 0) {
      return;
    }

    setPendingAttachments((previous) => {
      const existed = new Set(
        previous.map((item) => `${item.path ?? item.name}:${item.size}`)
      );
      const merged = [...previous];

      for (const file of files) {
        const next = toPendingAttachment(file);
        const signature = `${next.path ?? next.name}:${next.size}`;
        if (existed.has(signature)) {
          continue;
        }
        existed.add(signature);
        merged.push(next);
      }

      return merged;
    });

    setStatusText(`已添加 ${files.length} 个附件到待发送列表`);
    setErrorText("");
  }, []);

  const sendMessage = async () => {
    const text = input.trim();
    if ((!text && pendingAttachments.length === 0) || isSending) {
      return;
    }

    if (gatewayStatus !== "running") {
      setErrorText("本地网关未启动，请先在控制大盘启动网关");
      setStatusText("");
      return;
    }

    setIsSending(true);
    const sessionId = ensureSession();
    const attachmentLines = pendingAttachments.map((item) => `- ${item.path ?? item.name}`);
    const composed = [
      text || (attachmentLines.length > 0 ? "已添加附件" : ""),
      attachmentLines.length > 0 ? `附件:\n${attachmentLines.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const userMessage: Message = {
      id: generateId(),
      role: "user",
      content: composed,
      timestamp: Date.now(),
      files: pendingAttachments.map((item) => item.path ?? item.name),
    };

    addMessage(sessionId, userMessage);

    const sessionHistory =
      sessions.find((session) => session.id === sessionId)?.messages ??
      currentSession?.messages ??
      [];

    const formattedMessages = [
      ...sessionHistory.map((message) => ({
        role: message.role as "user" | "assistant" | "system",
        content: message.content,
      })),
      {
        role: "user" as const,
        content: userMessage.content,
      },
    ];

    setInput("");
    setPendingAttachments([]);
    setStatusText("消息已写入当前会话，正在请求模型...");
    setErrorText("");

    const configuredGatewayPort =
      typeof openclaw.gatewayPort === "number" &&
      Number.isFinite(openclaw.gatewayPort) &&
      openclaw.gatewayPort > 0
        ? Math.floor(openclaw.gatewayPort)
        : 18789;
    const gatewayToken = openclaw.gatewayToken?.trim() ?? "";
    const llmApiKey = openclaw.apiKey?.trim() ?? "";
    const model =
      openclaw.defaultModel?.trim() ||
      openclaw.model?.trim() ||
      "codex-mini-latest";

    try {
      // 1. WebSocket native protocol — primary method; gateway handles provider routing automatically
      setStatusText("通过 WebSocket 连接网关...");
      const wsResult = await sendMessageToOpenClaw(userMessage.content, {
        apiKey: llmApiKey,
        baseUrl: openclaw.baseUrl,
        model,
        provider: openclaw.provider,
        systemPrompt: openclaw.systemPrompt,
        temperature: openclaw.temperature,
        maxTokens: openclaw.maxTokens,
        gatewayToken: gatewayToken || undefined,
        gatewayPort: configuredGatewayPort,
        sessionKey: `selfclaw-sandbox-${sessionId}`,
      });

      if (!wsResult.success || !wsResult.response?.trim()) {
        throw new Error(wsResult.error ?? "Gateway returned an empty response.");
      }
      let assistantContent: string | null = null;
      if (wsResult.success && wsResult.response?.trim()) {
        assistantContent = wsResult.response.trim();
      } else {
        // 2. HTTP OpenAI-compatible API — fallback when WebSocket fails
        const httpEndpointCandidates = [
          `http://127.0.0.1:${configuredGatewayPort}/v1/chat/completions`,
          `http://127.0.0.1:${configuredGatewayPort}/openai/v1/chat/completions`,
        ];
        const body = JSON.stringify({ model, messages: formattedMessages });
        // Use gateway token for HTTP auth (required when gateway auth.mode=token)
        const authToken = gatewayToken || llmApiKey || "local";
        const headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        };

        setStatusText("WebSocket 不可用，尝试 HTTP 直连...");
        let httpError: string | null = null;

        for (let idx = 0; idx < httpEndpointCandidates.length; idx++) {
          const endpoint = httpEndpointCandidates[idx];
          const resp = await fetch(endpoint, { method: "POST", headers, body });
          if (resp.status === 404 && idx < httpEndpointCandidates.length - 1) continue;
          if (!resp.ok) {
            const failedText = await resp.text();
            httpError = `HTTP ${resp.status}: ${failedText || resp.statusText}`;
            break;
          }
          const payload = (await resp.json()) as ChatCompletionResponse;
          if (payload.error?.message) {
            httpError = payload.error.message;
            break;
          }
          assistantContent = extractAssistantContent(payload);
          break;
        }

        // If both WS and HTTP failed, throw detailed error
        if (!assistantContent) {
          const wsErr = wsResult.error ?? "";
          const hint = wsErr ? `（WebSocket: ${wsErr}）` : "";
          throw new Error(`${httpError}${hint}`);
        }
      }

      if (!assistantContent) {
        throw new Error("模型未返回可解析的回复内容");
      }

      addMessage(sessionId, {
        id: generateId(),
        role: "assistant",
        content: assistantContent,
        timestamp: Date.now(),
      });
      setStatusText("模型回复已写入当前会话");
    } catch (error) {
      setErrorText(`发送失败：${String(error)}`);
    } finally {
      setIsSending(false);
    }
  };

  const createSession = () => {
    const id = generateId();
    const now = Date.now();
    addSession({
      id,
      title: "新会话",
      messages: [],
      createdAt: now,
      updatedAt: now,
    });
    setCurrentSession(id);
    setStatusText("已创建新会话");
    setErrorText("");
  };

  const exportCurrentSession = async () => {
    if (!currentSession) {
      setErrorText("当前没有可导出的会话");
      return;
    }

    if (isExporting) {
      return;
    }

    setIsExporting(true);
    setErrorText("");
    setStatusText("");

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
      setStatusText(`导出成功：${savePath}`);
    } catch (error) {
      setErrorText(`导出失败：${String(error)}`);
    } finally {
      setIsExporting(false);
    }
  };

  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    dragCounterRef.current += 1;
    setIsDragging(true);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!isDragging) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();

    dragCounterRef.current = 0;
    setIsDragging(false);

    const files = Array.from(event.dataTransfer.files);
    ingestDroppedFiles(files);
  };

  return (
    <section
      className="relative grid h-full min-h-0 grid-cols-[270px_1fr] overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <aside className="flex h-full min-h-0 flex-col border-r border-neutral-800 bg-neutral-900">
        <div className="p-3">
          <Button onClick={createSession} className="w-full bg-orange-500 text-white hover:bg-orange-400">
            <MessageSquarePlus className="mr-2 h-4 w-4" />
            新建会话
          </Button>
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {sessions.map((session) => {
            const active = session.id === currentSessionId;
            return (
              <button
                key={session.id}
                type="button"
                className={cn(
                  "group flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition",
                  active
                    ? "bg-orange-500/15 text-orange-300"
                    : "text-neutral-300 hover:bg-neutral-800"
                )}
                onClick={() => setCurrentSession(session.id)}
              >
                <span className="truncate">{session.title}</span>
                <span className="ml-2 shrink-0 text-xs text-neutral-500">
                  {session.messages.length}
                </span>
                <span
                  className="ml-auto hidden rounded p-1 text-neutral-500 hover:bg-neutral-700 hover:text-red-400 group-hover:inline-flex"
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteSession(session.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="flex h-full min-h-0 flex-col bg-neutral-900">
        <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-neutral-100">对话沙盒</h2>
            <p className="text-xs text-neutral-400">会话记录持久化到 IndexedDB，刷新后自动恢复。</p>
          </div>
          <Button
            variant="outline"
            className="border-neutral-700 bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
            onClick={() => void exportCurrentSession()}
            disabled={!currentSession || isExporting}
          >
            {isExporting ? (
              <>
                <Send className="mr-2 h-4 w-4 animate-pulse" />
                导出中...
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                导出会话
              </>
            )}
          </Button>
        </header>

        <div ref={messageContainerRef} className="flex-1 overflow-y-auto p-5">
          {gatewayStatus !== "running" && (
            <div className="mb-4 flex items-start gap-3 rounded-xl border border-orange-500/40 bg-orange-500/10 px-4 py-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-orange-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-orange-300">
                  {gatewayStatus === "starting"
                    ? "本地网关正在启动，请稍候..."
                    : gatewayStatus === "stopping"
                    ? "本地网关正在停止..."
                    : "本地网关未启动"}
                </p>
                {gatewayStatus === "offline" && (
                  <p className="mt-0.5 text-xs text-orange-400/80">
                    请前往「控制大盘」启动网关后再发送消息。
                  </p>
                )}
              </div>
            </div>
          )}
          {!currentSession || currentSession.messages.length === 0 ? (
            <div className="rounded-xl border border-dashed border-neutral-700 bg-neutral-800/40 p-6 text-center text-neutral-400">
              输入消息或拖入文件，开始当前会话。
            </div>
          ) : (
            <div className="space-y-4">
              {currentSession.messages.map((message) => (
                <article key={message.id} className="space-y-1">
                  <div className="flex items-center justify-between text-xs text-neutral-500">
                    <span>{ROLE_LABELS[message.role]}</span>
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
                    <p className="whitespace-pre-wrap break-words">{message.content}</p>
                    {message.files?.length ? (
                      <div className="mt-2 space-y-1 text-xs text-neutral-400">
                        {message.files.map((fileName) => (
                          <p key={fileName} className="truncate">
                            附件: {fileName}
                          </p>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        <footer className="border-t border-neutral-800 p-4">
          {pendingAttachments.length > 0 ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {pendingAttachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="inline-flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200"
                >
                  <Paperclip className="h-3.5 w-3.5 text-orange-300" />
                  <span className="max-w-[220px] truncate" title={attachment.path ?? attachment.name}>
                    {attachment.path ?? attachment.name}
                  </span>
                  <button
                    type="button"
                    className="rounded p-0.5 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100"
                    onClick={() =>
                      setPendingAttachments((previous) =>
                        previous.filter((item) => item.id !== attachment.id)
                      )
                    }
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              rows={3}
              placeholder="输入消息，或拖入文件..."
              className="min-h-[88px] flex-1 resize-none rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2"
            />
            <Button
              onClick={() => void sendMessage()}
              disabled={isSending || (!input.trim() && pendingAttachments.length === 0)}
              className="h-11 bg-orange-500 text-white hover:bg-orange-400"
            >
              {isSending ? (
                <Send className="h-4 w-4 animate-pulse" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>

          {statusText ? <p className="mt-2 text-xs text-neutral-300">{statusText}</p> : null}
          {errorText ? <p className="mt-2 text-xs text-red-300">{errorText}</p> : null}
        </footer>
      </div>

      {isDragging ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/55">
          <div className="rounded-xl border border-orange-500/60 bg-neutral-900/95 px-6 py-4 text-sm text-orange-200 shadow-xl">
            松开鼠标，将文件添加至当前对话
          </div>
        </div>
      ) : null}
    </section>
  );
}
