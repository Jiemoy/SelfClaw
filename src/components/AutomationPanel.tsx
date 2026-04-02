import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity, AlertCircle, CheckCircle2, Play, RefreshCw, RotateCcw, Square, Timer, Zap } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";

interface AutomationLogEntry {
  id: number;
  timestamp: number;
  action: string;
  result: "success" | "error";
  detail: string;
}

let logIdCounter = 1;

function formatRelativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  return new Date(ts).toLocaleTimeString();
}

export function AutomationPanel() {
  const { gatewayStatus } = useAppStore();

  // --- Health check timer state ---
  const [healthCheckEnabled, setHealthCheckEnabled] = useState(false);
  const [healthCheckInterval, setHealthCheckInterval] = useState(15);
  const [healthCheckCountdown, setHealthCheckCountdown] = useState(0);
  const healthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const healthCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- Auto-restart state ---
  const [autoRestartEnabled, setAutoRestartEnabled] = useState(false);
  const autoRestartRef = useRef(false);
  const prevGatewayStatus = useRef(gatewayStatus);

  // --- Log state ---
  const [logs, setLogs] = useState<AutomationLogEntry[]>([]);
  const [isRunningHealthCheck, setIsRunningHealthCheck] = useState(false);
  const [isRunningRestart, setIsRunningRestart] = useState(false);

  const appendLog = useCallback(
    (action: string, result: "success" | "error", detail: string) => {
      setLogs((prev) => {
        const entry: AutomationLogEntry = {
          id: logIdCounter++,
          timestamp: Date.now(),
          action,
          result,
          detail,
        };
        return [entry, ...prev].slice(0, 50);
      });
    },
    []
  );

  // --- Manual health check ---
  const runHealthCheck = useCallback(async () => {
    if (isRunningHealthCheck) return;
    setIsRunningHealthCheck(true);
    try {
      const result = await invoke<string>("doctor_openclaw_gateway");
      appendLog("健康检查", "success", result || "诊断完成");
    } catch (error) {
      appendLog("健康检查", "error", String(error));
    } finally {
      setIsRunningHealthCheck(false);
    }
  }, [isRunningHealthCheck, appendLog]);

  // --- Manual restart ---
  const runRestart = useCallback(async () => {
    if (isRunningRestart) return;
    setIsRunningRestart(true);
    try {
      const result = await invoke<string>("restart_openclaw_gateway");
      appendLog("重启网关", "success", result || "重启完成");
    } catch (error) {
      appendLog("重启网关", "error", String(error));
    } finally {
      setIsRunningRestart(false);
    }
  }, [isRunningRestart, appendLog]);

  // --- Health check timer ---
  const stopHealthTimer = useCallback(() => {
    if (healthTimerRef.current) {
      clearInterval(healthTimerRef.current);
      healthTimerRef.current = null;
    }
    if (healthCountdownRef.current) {
      clearInterval(healthCountdownRef.current);
      healthCountdownRef.current = null;
    }
    setHealthCheckCountdown(0);
  }, []);

  const startHealthTimer = useCallback(
    (intervalMinutes: number) => {
      stopHealthTimer();
      const intervalMs = intervalMinutes * 60 * 1000;

      // Countdown display (updates every second)
      let remaining = intervalMs / 1000;
      setHealthCheckCountdown(Math.round(remaining));
      healthCountdownRef.current = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          remaining = intervalMs / 1000;
        }
        setHealthCheckCountdown(Math.round(remaining));
      }, 1000);

      // Actual task timer
      healthTimerRef.current = setInterval(() => {
        invoke<string>("doctor_openclaw_gateway")
          .then((result) => {
            appendLog("定时健康检查", "success", result || "诊断完成");
          })
          .catch((error: unknown) => {
            appendLog("定时健康检查", "error", String(error));
          });
      }, intervalMs);
    },
    [stopHealthTimer, appendLog]
  );

  const toggleHealthCheck = () => {
    const next = !healthCheckEnabled;
    setHealthCheckEnabled(next);
    if (next) {
      startHealthTimer(healthCheckInterval);
      appendLog("定时健康检查", "success", `已启动，间隔 ${healthCheckInterval} 分钟`);
    } else {
      stopHealthTimer();
      appendLog("定时健康检查", "success", "已停止");
    }
  };

  // Update timer if interval changes while running
  useEffect(() => {
    if (healthCheckEnabled) {
      startHealthTimer(healthCheckInterval);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [healthCheckInterval]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopHealthTimer();
    };
  }, [stopHealthTimer]);

  // --- Auto-restart on gateway offline ---
  useEffect(() => {
    autoRestartRef.current = autoRestartEnabled;
  }, [autoRestartEnabled]);

  useEffect(() => {
    const prev = prevGatewayStatus.current;
    prevGatewayStatus.current = gatewayStatus;

    if (
      autoRestartRef.current &&
      prev === "running" &&
      gatewayStatus === "offline"
    ) {
      appendLog("自动重启", "success", "检测到网关离线，正在自动重启...");
      invoke<string>("restart_openclaw_gateway")
        .then((result) => {
          appendLog("自动重启", "success", result || "重启完成");
        })
        .catch((error: unknown) => {
          appendLog("自动重启", "error", String(error));
        });
    }
  }, [gatewayStatus, appendLog]);

  const gatewayRunning = gatewayStatus === "running";

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900">
      {/* Header */}
      <header className="border-b border-neutral-800 px-5 py-3">
        <h2 className="text-base font-semibold text-neutral-100">自动化</h2>
        <p className="text-xs text-neutral-400">配置定时任务与自动化策略，监控执行历史。</p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
        {/* Config cards row */}
        <div className="grid grid-cols-2 gap-4">
          {/* Health Check Timer Card */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-800/50 p-4">
            <div className="mb-3 flex items-center gap-2">
              <Timer className="h-4 w-4 text-orange-400" />
              <h3 className="text-sm font-semibold text-neutral-100">定时健康检查</h3>
              <span
                className={cn(
                  "ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium",
                  healthCheckEnabled
                    ? "bg-green-500/20 text-green-400"
                    : "bg-neutral-700 text-neutral-500"
                )}
              >
                {healthCheckEnabled ? "运行中" : "已停止"}
              </span>
            </div>

            <p className="mb-4 text-xs text-neutral-400">
              定期运行 <code className="rounded bg-neutral-900 px-1 text-orange-300">openclaw doctor --fix</code>，自动诊断并修复网关问题。
            </p>

            <div className="mb-4 flex items-center gap-3">
              <label className="shrink-0 text-xs text-neutral-400">间隔（分钟）</label>
              <input
                type="number"
                min={1}
                max={1440}
                value={healthCheckInterval}
                onChange={(e) => setHealthCheckInterval(Math.max(1, parseInt(e.target.value) || 15))}
                disabled={healthCheckEnabled}
                className="h-8 w-20 rounded-lg border border-neutral-700 bg-neutral-900 px-2 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2 disabled:opacity-50"
              />
              {healthCheckEnabled && healthCheckCountdown > 0 && (
                <span className="text-xs text-neutral-500">
                  下次: {healthCheckCountdown >= 60
                    ? `${Math.floor(healthCheckCountdown / 60)}m ${healthCheckCountdown % 60}s`
                    : `${healthCheckCountdown}s`}
                </span>
              )}
            </div>

            <div className="flex gap-2">
              <Button
                onClick={toggleHealthCheck}
                className={cn(
                  "flex-1",
                  healthCheckEnabled
                    ? "bg-neutral-700 text-neutral-100 hover:bg-neutral-600"
                    : "bg-orange-500 text-white hover:bg-orange-400"
                )}
              >
                {healthCheckEnabled ? (
                  <><Square className="mr-2 h-3.5 w-3.5" />停止</>
                ) : (
                  <><Play className="mr-2 h-3.5 w-3.5" />启动</>
                )}
              </Button>
              <Button
                variant="outline"
                onClick={() => void runHealthCheck()}
                disabled={isRunningHealthCheck}
                className="border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
                title="立即执行一次"
              >
                {isRunningHealthCheck ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Zap className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>

          {/* Auto-Restart Card */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-800/50 p-4">
            <div className="mb-3 flex items-center gap-2">
              <RotateCcw className="h-4 w-4 text-orange-400" />
              <h3 className="text-sm font-semibold text-neutral-100">自动重启</h3>
              <span
                className={cn(
                  "ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium",
                  autoRestartEnabled
                    ? "bg-green-500/20 text-green-400"
                    : "bg-neutral-700 text-neutral-500"
                )}
              >
                {autoRestartEnabled ? "监控中" : "已停止"}
              </span>
            </div>

            <p className="mb-4 text-xs text-neutral-400">
              检测到网关从「运行中」变为「离线」时，自动触发重启命令。
            </p>

            <div className="mb-4 rounded-lg border border-neutral-700 bg-neutral-900/60 px-3 py-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-neutral-400">网关状态</span>
                <span
                  className={cn(
                    "ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium",
                    gatewayRunning
                      ? "bg-green-500/20 text-green-400"
                      : gatewayStatus === "starting"
                      ? "bg-orange-500/20 text-orange-400"
                      : "bg-neutral-700 text-neutral-400"
                  )}
                >
                  {gatewayStatus === "running"
                    ? "运行中"
                    : gatewayStatus === "starting"
                    ? "启动中"
                    : gatewayStatus === "stopping"
                    ? "停止中"
                    : "离线"}
                </span>
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                onClick={() => {
                  const next = !autoRestartEnabled;
                  setAutoRestartEnabled(next);
                  appendLog(
                    "自动重启监控",
                    "success",
                    next ? "已启用自动重启监控" : "已禁用自动重启监控"
                  );
                }}
                className={cn(
                  "flex-1",
                  autoRestartEnabled
                    ? "bg-neutral-700 text-neutral-100 hover:bg-neutral-600"
                    : "bg-orange-500 text-white hover:bg-orange-400"
                )}
              >
                {autoRestartEnabled ? (
                  <><Square className="mr-2 h-3.5 w-3.5" />停止监控</>
                ) : (
                  <><Activity className="mr-2 h-3.5 w-3.5" />启动监控</>
                )}
              </Button>
              <Button
                variant="outline"
                onClick={() => void runRestart()}
                disabled={isRunningRestart}
                className="border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
                title="立即重启网关"
              >
                {isRunningRestart ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>
        </div>

        {/* Execution History */}
        <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-neutral-800 bg-neutral-800/50">
          <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-100">
              <Activity className="h-4 w-4 text-orange-400" />
              执行历史
            </h3>
            {logs.length > 0 && (
              <button
                type="button"
                onClick={() => setLogs([])}
                className="text-xs text-neutral-500 hover:text-neutral-300"
              >
                清空
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {logs.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-sm text-neutral-500">
                暂无执行记录
              </div>
            ) : (
              <div className="divide-y divide-neutral-800">
                {logs.map((entry) => (
                  <div key={entry.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="mt-0.5 shrink-0">
                      {entry.result === "success" ? (
                        <CheckCircle2 className="h-4 w-4 text-green-400" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-red-400" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-neutral-200">{entry.action}</span>
                        <span className="ml-auto shrink-0 text-[11px] text-neutral-500">
                          {formatRelativeTime(entry.timestamp)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-neutral-400">{entry.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
