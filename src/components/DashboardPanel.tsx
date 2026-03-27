import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  FolderOpen,
  LoaderCircle,
  Play,
  RefreshCw,
  Square,
  Stethoscope,
  Terminal,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui";
import { isIgnorableTauriInvokeError } from "@/lib/tauriErrors";
import { type GatewayRuntimeStatus, useAppStore } from "@/store/appStore";

interface GatewayStatus {
  running: boolean;
  pid?: number;
  checked_at: number;
}

type DashboardAction =
  | "refresh"
  | "start"
  | "stop"
  | "restart"
  | "doctor"
  | "open"
  | null;

const STATUS_TEXT: Record<GatewayRuntimeStatus, string> = {
  offline: "离线",
  running: "运行中",
  starting: "启动中",
  stopping: "停止中",
};

const STATUS_DOT_CLASS: Record<GatewayRuntimeStatus, string> = {
  offline: "bg-red-500",
  running: "bg-green-500",
  starting: "bg-yellow-500",
  stopping: "bg-orange-500",
};

export function DashboardPanel() {
  const gatewayStatus = useAppStore((state) => state.gatewayStatus);
  const gatewayLogs = useAppStore((state) => state.gatewayLogs);
  const setGatewayStatus = useAppStore((state) => state.setGatewayStatus);
  const appendGatewayLog = useAppStore((state) => state.appendGatewayLog);
  const clearGatewayLogs = useAppStore((state) => state.clearGatewayLogs);

  const [isLoading, setIsLoading] = useState(false);
  const [statusFailed, setStatusFailed] = useState(false);
  const [activeAction, setActiveAction] = useState<DashboardAction>(null);
  const [gatewayPid, setGatewayPid] = useState<number | undefined>(undefined);
  const [lastCheckedAt, setLastCheckedAt] = useState<number>(0);

  const mountedRef = useRef(false);
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const requestLockRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setFallbackStatus = useCallback(() => {
    if (!mountedRef.current) {
      return;
    }

    setStatusFailed(true);
    setGatewayStatus("offline");
    setGatewayPid(undefined);
    setLastCheckedAt(Math.floor(Date.now() / 1000));
  }, [setGatewayStatus]);

  const appendTerminalLog = useCallback(
    (text: string) => {
      appendGatewayLog(text);
    },
    [appendGatewayLog]
  );

  const fetchGatewayStatus = useCallback(async () => {
    try {
      const next = await invoke<GatewayStatus>("probe_openclaw_gateway");
      if (!mountedRef.current) {
        return;
      }

      setGatewayStatus(next.running ? "running" : "offline");
      setGatewayPid(next.pid);
      setLastCheckedAt(next.checked_at);
      setStatusFailed(false);
    } catch (error) {
      if (!mountedRef.current || isIgnorableTauriInvokeError(error)) {
        return;
      }
      appendTerminalLog(`[error] 获取网关状态失败：${String(error)}`);
      setFallbackStatus();
    }
  }, [appendTerminalLog, setFallbackStatus, setGatewayStatus]);

  const pullGatewayStatus = useCallback(() => {
    if (!mountedRef.current || requestLockRef.current) {
      return;
    }

    requestLockRef.current = true;
    setIsLoading(true);
    setActiveAction("refresh");

    void fetchGatewayStatus().finally(() => {
      requestLockRef.current = false;
      if (!mountedRef.current) {
        return;
      }
      setIsLoading(false);
      setActiveAction(null);
    });
  }, [fetchGatewayStatus]);

  useEffect(() => {
    pullGatewayStatus();
  }, [pullGatewayStatus]);

  useEffect(() => {
    let disposed = false;
    let unlistenLog: (() => void) | null = null;
    let unlistenExited: (() => void) | null = null;

    listen<string>("gateway-log-line", () => {
      if (!mountedRef.current) {
        return;
      }
      setGatewayStatus("running");
      setStatusFailed(false);
    })
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlistenLog = dispose;
      })
      .catch((error) => {
        if (!mountedRef.current || isIgnorableTauriInvokeError(error)) {
          return;
        }
        appendTerminalLog(`[error] 监听 gateway-log-line 失败：${String(error)}`);
      });

    listen("gateway-exited", () => {
      if (!mountedRef.current) {
        return;
      }
      setGatewayStatus("offline");
      setGatewayPid(undefined);
      setLastCheckedAt(Math.floor(Date.now() / 1000));
      appendGatewayLog("\n> [系统] 网关进程已退出或意外终止。");
    })
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlistenExited = dispose;
      })
      .catch((error) => {
        if (!mountedRef.current || isIgnorableTauriInvokeError(error)) {
          return;
        }
        appendTerminalLog(`[error] 监听 gateway-exited 失败：${String(error)}`);
      });

    return () => {
      disposed = true;
      if (unlistenLog) {
        unlistenLog();
      }
      if (unlistenExited) {
        unlistenExited();
      }
    };
  }, [appendGatewayLog, appendTerminalLog, setGatewayStatus]);

  useEffect(() => {
    const container = logContainerRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [gatewayLogs]);

  const runAction = useCallback(
    (
      action: Exclude<DashboardAction, "refresh" | null>,
      command: string,
      commandEcho: string,
      defaultSuccessMessage: string
    ) => {
      if (!mountedRef.current || requestLockRef.current) {
        return;
      }

      requestLockRef.current = true;
      setIsLoading(true);
      setActiveAction(action);

      if (action === "start" || action === "restart") {
        setGatewayStatus("starting");
      } else if (action === "stop") {
        setGatewayStatus("stopping");
      }

      appendTerminalLog(`\n> ${commandEcho}`);

      invoke<string>(command)
        .then((result) => {
          if (!mountedRef.current) {
            return;
          }
          appendTerminalLog(result && result.trim() ? result : defaultSuccessMessage);

          const now = Math.floor(Date.now() / 1000);
          setLastCheckedAt(now);
          setStatusFailed(false);

          if (action === "start" || action === "restart") {
            setGatewayStatus("running");
          } else if (action === "stop") {
            setGatewayStatus("offline");
            setGatewayPid(undefined);
          }
        })
        .catch((error) => {
          if (!mountedRef.current || isIgnorableTauriInvokeError(error)) {
            return;
          }
          appendTerminalLog(`[error] 操作失败：${String(error)}`);
        })
        .finally(() => {
          void fetchGatewayStatus().finally(() => {
            requestLockRef.current = false;
            if (!mountedRef.current) {
              return;
            }
            setIsLoading(false);
            setActiveAction(null);
          });
        });
    },
    [appendTerminalLog, fetchGatewayStatus, setGatewayStatus]
  );

  const formattedTime = lastCheckedAt
    ? new Date(lastCheckedAt * 1000).toLocaleTimeString()
    : "--";
  const statusText = statusFailed ? "异常" : STATUS_TEXT[gatewayStatus];
  const statusDotClass = statusFailed ? "bg-yellow-500" : STATUS_DOT_CLASS[gatewayStatus];
  const isRunning = gatewayStatus !== "offline";

  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <header>
        <h2 className="text-xl font-semibold text-neutral-100">监控大盘</h2>
        <p className="text-sm text-neutral-400">统一查看网关状态、生命周期控制与实时日志。</p>
      </header>

      <div className="rounded-xl border border-neutral-800 bg-neutral-800 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-xs tracking-wide text-neutral-400">网关状态</p>
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${statusDotClass}`} />
              <span className="text-lg font-semibold text-neutral-100">{statusText}</span>
            </div>
            <p className="text-xs text-neutral-500">
              PID: {gatewayPid ?? "N/A"} | 最后检查: {formattedTime}
            </p>
          </div>

          <Button
            variant="outline"
            className="border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-700"
            onClick={pullGatewayStatus}
            disabled={isLoading}
          >
            {isLoading && activeAction === "refresh" ? (
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {isLoading && activeAction === "refresh" ? "执行中..." : "刷新"}
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-neutral-800 bg-neutral-800 p-4">
        <h3 className="mb-3 text-sm font-semibold tracking-wide text-neutral-300">Gateway Controls</h3>
        <div className="flex flex-wrap gap-3">
          {!isRunning ? (
            <Button
              className="bg-orange-500 text-white hover:bg-orange-400"
              onClick={() =>
                runAction("start", "start_openclaw_gateway", "正在启动网关...", "网关已启动")
              }
              disabled={isLoading}
            >
              {isLoading && activeAction === "start" ? (
                <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              {isLoading && activeAction === "start" ? "执行中..." : "启动网关"}
            </Button>
          ) : (
            <>
              <Button
                className="bg-red-600 text-white hover:bg-red-500"
                onClick={() =>
                  runAction("stop", "stop_openclaw_gateway", "正在停止网关...", "网关已停止")
                }
                disabled={isLoading}
              >
                {isLoading && activeAction === "stop" ? (
                  <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Square className="mr-2 h-4 w-4" />
                )}
                {isLoading && activeAction === "stop" ? "执行中..." : "停止网关"}
              </Button>

              <Button
                variant="outline"
                className="border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-700"
                onClick={() =>
                  runAction("restart", "restart_openclaw_gateway", "正在重启网关...", "网关已重启")
                }
                disabled={isLoading}
              >
                {isLoading && activeAction === "restart" ? (
                  <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Activity className="mr-2 h-4 w-4" />
                )}
                {isLoading && activeAction === "restart" ? "执行中..." : "重启网关"}
              </Button>
            </>
          )}

          <Button
            variant="outline"
            className="border-orange-500/60 bg-neutral-900 text-orange-400 hover:bg-orange-500/10"
            onClick={() =>
              runAction(
                "doctor",
                "doctor_openclaw_gateway",
                "正在执行: openclaw doctor --fix ...",
                "环境诊断已完成"
              )
            }
            disabled={isLoading}
          >
            {isLoading && activeAction === "doctor" ? (
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Stethoscope className="mr-2 h-4 w-4" />
            )}
            {isLoading && activeAction === "doctor" ? "执行中..." : "环境诊断"}
          </Button>

          <Button
            variant="outline"
            className="border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-700"
            onClick={() =>
              runAction("open", "open_openclaw_workspace", "正在打开工作区 ~/.openclaw ...", "已打开工作区")
            }
            disabled={isLoading}
          >
            {isLoading && activeAction === "open" ? (
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FolderOpen className="mr-2 h-4 w-4" />
            )}
            {isLoading && activeAction === "open" ? "执行中..." : "打开 ~/.openclaw"}
          </Button>
        </div>
      </div>

      <div className="flex min-h-[260px] flex-1 flex-col rounded-xl border border-neutral-800 bg-neutral-800 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold tracking-wide text-neutral-300">
            <Terminal className="h-4 w-4 text-orange-400" />
            实时日志终端
          </h3>
          <Button
            variant="outline"
            className="border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800"
            onClick={clearGatewayLogs}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            清空日志
          </Button>
        </div>

        <div
          ref={logContainerRef}
          className="mt-3 flex-1 overflow-y-auto rounded-lg border border-neutral-700 bg-black p-2 font-mono whitespace-pre-wrap break-all text-xs text-green-400"
        >
          {gatewayLogs.length === 0 ? (
            <div className="text-neutral-600">等待网关日志输出...</div>
          ) : (
            gatewayLogs.map((line, index) => (
              <div key={`${index}-${line.slice(0, 18)}`}>{line === "" ? "\u00A0" : line}</div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
