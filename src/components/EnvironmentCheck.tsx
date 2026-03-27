import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, Download, LoaderCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui";
import { checkOpenClawInstalled } from "@/lib/openclaw";
import { installNodeJS, installOpenClaw } from "@/lib/autoInstaller";

interface CheckResult {
  ok: boolean;
  version?: string;
}

interface InstallState {
  running: boolean;
  progress: number;
}

interface EnvironmentCheckProps {
  onComplete: () => void;
}

async function checkCommand(command: string): Promise<CheckResult> {
  try {
    const output = await invoke<string>("run_sys_command", {
      command,
      args: ["--version"],
    });
    return { ok: true, version: output.trim() };
  } catch {
    return { ok: false };
  }
}

export function EnvironmentCheck({ onComplete }: EnvironmentCheckProps) {
  const [checking, setChecking] = useState(true);
  const [node, setNode] = useState<CheckResult>({ ok: false });
  const [npm, setNpm] = useState<CheckResult>({ ok: false });
  const [openclaw, setOpenclaw] = useState<CheckResult>({ ok: false });
  const [installNode, setInstallNode] = useState<InstallState>({
    running: false,
    progress: 0,
  });
  const [installOpenclaw, setInstallOpenclaw] = useState<InstallState>({
    running: false,
    progress: 0,
  });

  const refresh = useCallback(async () => {
    setChecking(true);
    const [nodeResult, npmResult, openclawResult] = await Promise.all([
      checkCommand("node"),
      checkCommand("npm"),
      checkOpenClawInstalled(),
    ]);

    setNode(nodeResult);
    setNpm(npmResult);
    setOpenclaw({
      ok: openclawResult.installed,
      version: openclawResult.version,
    });
    setChecking(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const allPassed = useMemo(
    () => node.ok && npm.ok && openclaw.ok,
    [node.ok, npm.ok, openclaw.ok]
  );

  const canContinue =
    allPassed &&
    !checking &&
    !installNode.running &&
    !installOpenclaw.running;

  const onInstallNode = async () => {
    setInstallNode({ running: true, progress: 0 });
    const success = await installNodeJS((progress) => {
      setInstallNode({ running: true, progress });
    });
    setInstallNode({ running: false, progress: 0 });
    if (success) {
      await refresh();
    }
  };

  const onInstallOpenClaw = async () => {
    setInstallOpenclaw({ running: true, progress: 0 });
    const success = await installOpenClaw((progress) => {
      setInstallOpenclaw({ running: true, progress });
    });
    setInstallOpenclaw({ running: false, progress: 0 });
    if (success) {
      await refresh();
    }
  };

  const renderStatusIcon = (ok: boolean, loading: boolean) => {
    if (loading) {
      return <LoaderCircle className="h-5 w-5 animate-spin text-orange-500" />;
    }
    if (ok) {
      return <CheckCircle2 className="h-5 w-5 text-green-500" />;
    }
    return <XCircle className="h-5 w-5 text-red-500" />;
  };

  return (
    <div className="flex h-full items-center justify-center bg-neutral-950 px-4 text-neutral-100">
      <div className="w-full max-w-xl rounded-2xl border border-neutral-800 bg-neutral-900 p-6 shadow-2xl">
        <h1 className="mb-2 text-2xl font-semibold">环境检查</h1>
        <p className="mb-6 text-sm text-neutral-400">
          Node.js、npm 与 OpenClaw 全部就绪后即可继续。
        </p>

        <div className="space-y-4">
          <div className="rounded-xl border border-neutral-800 bg-neutral-800/70 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                {renderStatusIcon(node.ok, checking || installNode.running)}
                <div>
                  <p className="font-medium">Node.js</p>
                  <p className="text-xs text-neutral-400">
                    {node.ok ? node.version : "未安装"}
                  </p>
                </div>
              </div>
              {!node.ok && !checking && !installNode.running ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onInstallNode}
                  className="border-orange-500/60 text-orange-400 hover:bg-orange-500/10"
                >
                  <Download className="mr-1 h-3.5 w-3.5" />
                  安装
                </Button>
              ) : null}
            </div>
            {installNode.running ? (
              <div className="mt-3 h-1.5 overflow-hidden rounded bg-neutral-700">
                <div
                  className="h-full bg-orange-500 transition-all"
                  style={{ width: `${installNode.progress}%` }}
                />
              </div>
            ) : null}
          </div>

          <div className="rounded-xl border border-neutral-800 bg-neutral-800/70 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                {renderStatusIcon(npm.ok, checking)}
                <div>
                  <p className="font-medium">npm</p>
                  <p className="text-xs text-neutral-400">
                    {npm.ok ? npm.version : "未安装"}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-neutral-800 bg-neutral-800/70 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                {renderStatusIcon(openclaw.ok, checking || installOpenclaw.running)}
                <div>
                  <p className="font-medium">OpenClaw</p>
                  <p className="text-xs text-neutral-400">
                    {openclaw.ok ? openclaw.version : "未安装"}
                  </p>
                </div>
              </div>
              {!openclaw.ok && !checking && !installOpenclaw.running ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onInstallOpenClaw}
                  className="border-orange-500/60 text-orange-400 hover:bg-orange-500/10"
                >
                  <Download className="mr-1 h-3.5 w-3.5" />
                  安装
                </Button>
              ) : null}
            </div>
            {installOpenclaw.running ? (
              <div className="mt-3 h-1.5 overflow-hidden rounded bg-neutral-700">
                <div
                  className="h-full bg-orange-500 transition-all"
                  style={{ width: `${installOpenclaw.progress}%` }}
                />
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          <Button
            variant="outline"
            className="flex-1 border-neutral-700 bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
            onClick={refresh}
            disabled={checking}
          >
            重新检查
          </Button>
          <Button
            className="flex-1 bg-orange-500 text-white hover:bg-orange-400"
            onClick={onComplete}
            disabled={!canContinue}
          >
            继续
          </Button>
        </div>
      </div>
    </div>
  );
}
