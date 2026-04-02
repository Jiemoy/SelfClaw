import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BaseDirectory, exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { BookOpen, Brain, RefreshCw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";

const MEMORY_FILE_PATH = ".openclaw/MEMORY.md";

function wordCount(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

function charCount(text: string): number {
  return text.length;
}

export function MemoryCenter() {
  const { openclaw, sessions, deleteSession, setCurrentSession } = useAppStore();

  const [memoryContent, setMemoryContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [fileError, setFileError] = useState("");
  const [fileSaveStatus, setFileSaveStatus] = useState("");
  const [isClearingHistory, setIsClearingHistory] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);

  const totalMessages = useMemo(
    () => sessions.reduce((sum, session) => sum + session.messages.length, 0),
    [sessions]
  );

  const isDirty = memoryContent !== savedContent;

  const loadMemoryFile = useCallback(async () => {
    setIsLoadingFile(true);
    setFileError("");
    setFileSaveStatus("");
    try {
      const fileExists = await exists(MEMORY_FILE_PATH, {
        baseDir: BaseDirectory.Home,
      });
      if (!fileExists) {
        const initial = "# 长期记忆\n\n<!-- 在此记录需要长期保存的上下文与用户偏好 -->\n";
        setMemoryContent(initial);
        setSavedContent(initial);
      } else {
        const content = await readTextFile(MEMORY_FILE_PATH, {
          baseDir: BaseDirectory.Home,
        });
        setMemoryContent(content);
        setSavedContent(content);
      }
    } catch (error) {
      setFileError(`加载失败：${String(error)}`);
    } finally {
      setIsLoadingFile(false);
    }
  }, []);

  useEffect(() => {
    void loadMemoryFile();
  }, [loadMemoryFile]);

  const saveMemoryFile = async () => {
    if (isSaving) return;
    setIsSaving(true);
    setFileSaveStatus("");
    setFileError("");
    try {
      await writeTextFile(MEMORY_FILE_PATH, memoryContent, {
        baseDir: BaseDirectory.Home,
      });
      setSavedContent(memoryContent);
      setFileSaveStatus("已保存");
    } catch (error) {
      setFileError(`保存失败：${String(error)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearHistory = async () => {
    if (!clearConfirm) {
      setClearConfirm(true);
      return;
    }
    setIsClearingHistory(true);
    setClearConfirm(false);
    try {
      setCurrentSession(null);
      for (const session of sessions) {
        deleteSession(session.id);
      }
    } finally {
      setIsClearingHistory(false);
    }
  };

  const openWorkspace = async () => {
    try {
      await invoke("open_openclaw_workspace");
    } catch {
      // ignore
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col gap-0 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
        <div>
          <h2 className="text-base font-semibold text-neutral-100">记忆中枢</h2>
          <p className="text-xs text-neutral-400">管理 MEMORY.md 与长期记忆策略。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="border-neutral-700 bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
            onClick={() => void loadMemoryFile()}
            disabled={isLoadingFile}
          >
            <RefreshCw className={cn("mr-2 h-4 w-4", isLoadingFile && "animate-spin")} />
            刷新
          </Button>
          <Button
            onClick={() => void saveMemoryFile()}
            disabled={isSaving || !isDirty}
            className={cn(
              "h-9",
              isDirty
                ? "bg-orange-500 text-white hover:bg-orange-400"
                : "cursor-default bg-neutral-800 text-neutral-500"
            )}
          >
            <Save className="mr-2 h-4 w-4" />
            {isSaving ? "保存中..." : "保存"}
          </Button>
        </div>
      </header>

      {/* Body */}
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_280px]">
        {/* Left: MEMORY.md editor */}
        <div className="flex min-h-0 flex-col border-r border-neutral-800">
          <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-950/40 px-4 py-2">
            <div className="flex items-center gap-2 text-xs text-neutral-400">
              <BookOpen className="h-3.5 w-3.5" />
              <span>~/.openclaw/MEMORY.md</span>
              {isDirty && (
                <span className="rounded bg-orange-500/20 px-1.5 py-0.5 text-[10px] text-orange-300">
                  未保存
                </span>
              )}
            </div>
            <div className="text-xs text-neutral-500">
              {charCount(memoryContent)} 字符 · {wordCount(memoryContent)} 词
            </div>
          </div>

          <div className="relative flex-1 overflow-hidden">
            {isLoadingFile ? (
              <div className="flex h-full items-center justify-center text-sm text-neutral-400">
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                加载中...
              </div>
            ) : (
              <textarea
                value={memoryContent}
                onChange={(e) => setMemoryContent(e.target.value)}
                className="h-full w-full resize-none bg-neutral-950/60 p-4 font-mono text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-1"
                placeholder="在此编写长期记忆内容..."
                spellCheck={false}
              />
            )}
          </div>

          {(fileError || fileSaveStatus) && (
            <div
              className={cn(
                "border-t border-neutral-800 px-4 py-2 text-xs",
                fileError ? "text-red-300" : "text-green-400"
              )}
            >
              {fileError || fileSaveStatus}
            </div>
          )}
        </div>

        {/* Right: Strategy + Stats */}
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
          {/* Memory Strategy */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-800/50 p-4">
            <div className="mb-3 flex items-center gap-2">
              <Brain className="h-4 w-4 text-orange-400" />
              <h3 className="text-sm font-semibold text-neutral-100">记忆策略</h3>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-lg bg-neutral-900/60 px-3 py-2.5">
                <div>
                  <p className="text-xs font-medium text-neutral-200">长期记忆</p>
                  <p className="text-[11px] text-neutral-500">跨会话记忆 MEMORY.md</p>
                </div>
                <span
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-xs font-medium",
                    openclaw.longTermMemoryEnabled
                      ? "bg-green-500/20 text-green-400"
                      : "bg-neutral-700 text-neutral-400"
                  )}
                >
                  {openclaw.longTermMemoryEnabled ? "已启用" : "已禁用"}
                </span>
              </div>

              <div className="flex items-center justify-between rounded-lg bg-neutral-900/60 px-3 py-2.5">
                <div>
                  <p className="text-xs font-medium text-neutral-200">历史消息限制</p>
                  <p className="text-[11px] text-neutral-500">每次请求携带的历史轮数</p>
                </div>
                <span className="rounded-full bg-neutral-700 px-2.5 py-0.5 text-xs font-medium text-neutral-300">
                  {openclaw.historyMessageLimit ?? 10}
                </span>
              </div>
            </div>

            <p className="mt-3 text-[11px] text-neutral-500">
              可在「设置」面板中修改以上策略。
            </p>
          </div>

          {/* Session Stats */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-800/50 p-4">
            <h3 className="mb-3 text-sm font-semibold text-neutral-100">会话统计</h3>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-neutral-400">会话总数</span>
                <span className="font-semibold text-neutral-100">{sessions.length}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-neutral-400">消息总数</span>
                <span className="font-semibold text-neutral-100">{totalMessages}</span>
              </div>
            </div>

            <div className="mt-4 border-t border-neutral-700 pt-3">
              {clearConfirm ? (
                <div className="space-y-2">
                  <p className="text-xs text-orange-300">确认清空所有会话？此操作不可撤销。</p>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => void handleClearHistory()}
                      disabled={isClearingHistory}
                      className="flex-1 bg-red-600 text-white hover:bg-red-500"
                    >
                      {isClearingHistory ? "清空中..." : "确认清空"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setClearConfirm(false)}
                      className="flex-1 border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
                    >
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => void handleClearHistory()}
                  disabled={sessions.length === 0 || isClearingHistory}
                  className="w-full border-neutral-700 bg-neutral-800 text-red-400 hover:bg-neutral-700 hover:text-red-300"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  清空会话历史
                </Button>
              )}
            </div>
          </div>

          {/* Workspace shortcut */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-800/50 p-4">
            <h3 className="mb-3 text-sm font-semibold text-neutral-100">工作区</h3>
            <p className="mb-3 text-xs text-neutral-400">
              打开 OpenClaw 工作区目录（~/.openclaw），可手动查看配置文件、日志等。
            </p>
            <Button
              variant="outline"
              onClick={() => void openWorkspace()}
              className="w-full border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
            >
              打开工作区目录
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
