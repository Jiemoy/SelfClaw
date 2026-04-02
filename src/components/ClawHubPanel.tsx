import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import {
  ExternalLink,
  LoaderCircle,
  PackagePlus,
  Puzzle,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button, Input, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import { isIgnorableTauriInvokeError } from "@/lib/tauriErrors";
import { cn } from "@/lib/utils";

type HubView = "discover" | "installed";
type FeedbackType = "info" | "success" | "error";

interface FeedbackState {
  type: FeedbackType;
  text: string;
}

interface InstalledSkill {
  name: string;
  description?: string | null;
  enabled: boolean;
}

interface SkillSwitchProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

const CLAWHUB_STORE_URL = "https://clawhub.ai";
const SYSTEM_SKILL_NAMES = new Set([
  "imagegen",
  "openai-docs",
  "plugin-creator",
  "skill-creator",
  "skill-installer",
]);

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
}

function isSystemSkill(skill: InstalledSkill): boolean {
  const normalized = normalizeSkillName(skill.name);
  return (
    !normalized ||
    normalized.startsWith(".") ||
    normalized.startsWith("_") ||
    SYSTEM_SKILL_NAMES.has(normalized)
  );
}

function formatCommandOutput(result: string, fallback: string): string {
  const trimmed = result.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function buildInstallCandidates(name: string): string[][] {
  return [
    ["skill", "install", name],
    ["skills", "install", name],
  ];
}

function buildUninstallCandidates(name: string): string[][] {
  return [
    ["skill", "uninstall", name],
    ["skills", "uninstall", name],
    ["skill", "remove", name],
    ["skills", "remove", name],
  ];
}

function SkillSwitch({ checked, disabled, onChange }: SkillSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-7 w-12 items-center rounded-full border transition-colors",
        checked
          ? "border-orange-400/80 bg-orange-500/90"
          : "border-neutral-600 bg-neutral-700",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      )}
    >
      <span
        className={cn(
          "inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-6" : "translate-x-1"
        )}
      />
    </button>
  );
}

export function ClawHubPanel() {
  const [activeTab, setActiveTab] = useState<HubView>("discover");
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);
  const [packageName, setPackageName] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);

  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshInstalledSkills = useCallback(async (showSuccess = false) => {
    if (!mountedRef.current) {
      return;
    }

    setIsRefreshing(true);
    if (!showSuccess) {
      setFeedback(null);
    }

    try {
      const skills = await invoke<InstalledSkill[]>("get_installed_skills");
      if (!mountedRef.current) {
        return;
      }

      const normalized = [...skills].sort((a, b) => a.name.localeCompare(b.name));
      setInstalledSkills(normalized);

      if (showSuccess) {
        setFeedback({
          type: "info",
          text: "本地技能列表已刷新。",
        });
      }
    } catch (error) {
      if (!mountedRef.current || isIgnorableTauriInvokeError(error)) {
        return;
      }
      setFeedback({
        type: "error",
        text: `刷新技能列表失败：${formatError(error)}`,
      });
    } finally {
      if (mountedRef.current) {
        setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void refreshInstalledSkills();
  }, [refreshInstalledSkills]);

  const runOpenClawCandidates = useCallback(
    async (candidates: string[][], actionKey: string, fallbackMessage: string) => {
      if (!mountedRef.current) {
        return null;
      }

      setActiveAction(actionKey);
      setFeedback(null);

      let lastError: unknown = null;

      try {
        for (const args of candidates) {
          try {
            const result = await invoke<string>("run_sys_command", {
              command: "openclaw",
              args,
            });
            if (!mountedRef.current) {
              return null;
            }

            const message = formatCommandOutput(result, fallbackMessage);
            setFeedback({ type: "success", text: message });
            return message;
          } catch (error) {
            if (isIgnorableTauriInvokeError(error)) {
              return null;
            }
            lastError = error;
          }
        }

        throw lastError ?? new Error("OpenClaw command failed");
      } catch (error) {
        if (!mountedRef.current) {
          return null;
        }
        setFeedback({
          type: "error",
          text: formatError(error),
        });
        return null;
      } finally {
        if (mountedRef.current) {
          setActiveAction(null);
        }
      }
    },
    []
  );

  const handleInstallSkill = async () => {
    const name = packageName.trim();
    if (!name) {
      setFeedback({ type: "error", text: "请输入要安装的技能包名。" });
      return;
    }

    const output = await runOpenClawCandidates(
      buildInstallCandidates(name),
      `install:${normalizeSkillName(name)}`,
      `技能 ${name} 已安装。`
    );
    if (!output || !mountedRef.current) {
      return;
    }

    setPackageName("");
    setActiveTab("installed");
    await refreshInstalledSkills();
  };

  const handleToggleSkill = async (skill: InstalledSkill, nextEnabled: boolean) => {
    if (!mountedRef.current) {
      return;
    }

    const actionKey = `toggle:${normalizeSkillName(skill.name)}`;
    setActiveAction(actionKey);
    setFeedback(null);

    try {
      const result = await invoke<string>("toggle_skill_status", {
        name: skill.name,
        enabled: nextEnabled,
      });
      if (!mountedRef.current) {
        return;
      }

      setInstalledSkills((previous) =>
        previous.map((item) =>
          item.name === skill.name ? { ...item, enabled: nextEnabled } : item
        )
      );
      setFeedback({
        type: "success",
        text: formatCommandOutput(
          result,
          `技能 ${skill.name} 已${nextEnabled ? "启用" : "禁用"}。`
        ),
      });
    } catch (error) {
      if (!mountedRef.current || isIgnorableTauriInvokeError(error)) {
        return;
      }
      setFeedback({
        type: "error",
        text: formatError(error),
      });
    } finally {
      if (mountedRef.current) {
        setActiveAction(null);
      }
    }
  };

  const handleUninstallSkill = async (skill: InstalledSkill) => {
    const confirmed = window.confirm(`确认卸载技能 "${skill.name}" 吗？`);
    if (!confirmed) {
      return;
    }

    const output = await runOpenClawCandidates(
      buildUninstallCandidates(skill.name),
      `uninstall:${normalizeSkillName(skill.name)}`,
      `技能 ${skill.name} 已卸载。`
    );
    if (!output || !mountedRef.current) {
      return;
    }

    await refreshInstalledSkills();
  };

  const openStoreExternally = async () => {
    try {
      await open(CLAWHUB_STORE_URL);
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setFeedback({
        type: "error",
        text: `打开官方商店失败：${formatError(error)}`,
      });
    }
  };

  const visibleSkills = useMemo(
    () => installedSkills.filter((skill) => !isSystemSkill(skill)),
    [installedSkills]
  );
  const hiddenSystemCount = Math.max(0, installedSkills.length - visibleSkills.length);
  const installActionKey = `install:${normalizeSkillName(packageName)}`;

  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <header className="rounded-2xl border border-neutral-800 bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_42%),linear-gradient(180deg,rgba(24,24,27,0.98),rgba(15,15,18,0.98))] p-5 shadow-[0_24px_80px_-48px_rgba(249,115,22,0.45)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.28em] text-orange-300/85">
              ClawHub
            </p>
            <h2 className="text-2xl font-semibold text-neutral-50">发现官方商店，管理你的本地技能</h2>
            <p className="mt-2 text-sm leading-6 text-neutral-400">
              默认进入官方商店发现页，商店内容由 <span className="text-neutral-200">clawhub.ai</span>{" "}
              直接接管；已安装页只保留用户真正需要管理的本地技能，并隐藏系统级内置依赖。
            </p>
          </div>

          <Button
            variant="outline"
            className="border-neutral-700 bg-neutral-950/70 text-neutral-100 hover:bg-neutral-900"
            onClick={openStoreExternally}
          >
            <ExternalLink className="mr-2 h-4 w-4" />
            在浏览器打开商店
          </Button>
        </div>
      </header>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as HubView)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="h-auto w-fit gap-2 rounded-2xl border border-neutral-800 bg-neutral-900 p-2">
          <TabsTrigger
            value="discover"
            className="rounded-xl px-4 py-2 data-[state=active]:bg-orange-500/20 data-[state=active]:text-orange-200"
          >
            <Puzzle className="mr-2 h-4 w-4" />
            发现技能
          </TabsTrigger>
          <TabsTrigger
            value="installed"
            className="rounded-xl px-4 py-2 data-[state=active]:bg-orange-500/20 data-[state=active]:text-orange-200"
          >
            <ShieldCheck className="mr-2 h-4 w-4" />
            我的技能
          </TabsTrigger>
        </TabsList>

        <TabsContent value="discover" className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
          <div className="rounded-2xl border border-neutral-800 bg-neutral-900/85 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              <div className="flex-1">
                <label
                  htmlFor="skill-install-name"
                  className="mb-2 block text-xs font-medium uppercase tracking-[0.18em] text-neutral-500"
                >
                  一键安装技能
                </label>
                <Input
                  id="skill-install-name"
                  value={packageName}
                  onChange={(event) => setPackageName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleInstallSkill();
                    }
                  }}
                  placeholder="在商店看到包名后，粘贴到这里直接安装"
                  className="border-neutral-700 bg-neutral-950 text-neutral-100 placeholder:text-neutral-500"
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  className="bg-orange-500 text-white hover:bg-orange-400"
                  onClick={() => void handleInstallSkill()}
                  disabled={Boolean(activeAction) || packageName.trim().length === 0}
                >
                  {activeAction === installActionKey ? (
                    <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <PackagePlus className="mr-2 h-4 w-4" />
                  )}
                  安装技能
                </Button>
                <Button
                  variant="outline"
                  className="border-neutral-700 bg-neutral-950 text-neutral-100 hover:bg-neutral-800"
                  onClick={openStoreExternally}
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  外部打开
                </Button>
              </div>
            </div>

            <p className="mt-3 text-xs text-neutral-400">
              商店浏览交给官方页面，安装入口保留在本地，避免把底层依赖细节暴露给普通用户。
            </p>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 shadow-[0_24px_80px_-48px_rgba(249,115,22,0.45)]">
            <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-950/95 px-4 py-3 text-xs text-neutral-400">
              <span className="inline-flex items-center gap-2">
                <Puzzle className="h-4 w-4 text-orange-300" />
                官方商店 · clawhub.ai
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-neutral-300 transition hover:text-white"
                onClick={openStoreExternally}
              >
                新窗口打开
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            </div>

            <iframe
              title="ClawHub Discover"
              src={CLAWHUB_STORE_URL}
              className="min-h-0 flex-1 border-0 bg-white"
            />
          </div>
        </TabsContent>

        <TabsContent value="installed" className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-neutral-800 bg-neutral-900/85 p-4">
            <div>
              <h3 className="text-base font-semibold text-neutral-100">本地技能管理</h3>
              <p className="mt-1 text-sm text-neutral-400">
                共展示 <span className="text-neutral-100">{visibleSkills.length}</span> 个技能
                {hiddenSystemCount > 0 ? (
                  <>
                    {" "}
                    · 已隐藏 <span className="text-neutral-100">{hiddenSystemCount}</span> 个系统级技能
                  </>
                ) : null}
              </p>
            </div>

            <Button
              variant="outline"
              className="border-neutral-700 bg-neutral-950 text-neutral-100 hover:bg-neutral-800"
              onClick={() => void refreshInstalledSkills(true)}
              disabled={isRefreshing || Boolean(activeAction)}
            >
              <RefreshCw className={cn("mr-2 h-4 w-4", isRefreshing ? "animate-spin" : "")} />
              刷新列表
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {isRefreshing && visibleSkills.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-neutral-800 bg-neutral-900/55">
                <div className="inline-flex items-center gap-2 text-sm text-neutral-300">
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  正在读取本地技能...
                </div>
              </div>
            ) : visibleSkills.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-900/55 p-10 text-center">
                <p className="text-sm font-medium text-neutral-200">还没有可管理的用户技能</p>
                <p className="mt-2 text-sm leading-6 text-neutral-400">
                  去「发现技能」页浏览官方商店，复制包名后一键安装。系统内置技能已经自动隐藏，不会干扰这里的列表。
                </p>
              </div>
            ) : (
              <div className="grid gap-3 xl:grid-cols-2">
                {visibleSkills.map((skill) => {
                  const normalizedName = normalizeSkillName(skill.name);
                  const toggleActionKey = `toggle:${normalizedName}`;
                  const uninstallActionKey = `uninstall:${normalizedName}`;
                  const isToggling = activeAction === toggleActionKey;
                  const isUninstalling = activeAction === uninstallActionKey;
                  const isBusy = Boolean(activeAction);

                  return (
                    <article
                      key={skill.name}
                      className="rounded-2xl border border-neutral-800 bg-[linear-gradient(180deg,rgba(31,31,35,0.96),rgba(20,20,24,0.96))] p-4 shadow-[0_18px_60px_-42px_rgba(249,115,22,0.42)]"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="rounded-xl bg-orange-500/15 p-2 text-orange-300">
                              <Puzzle className="h-4 w-4" />
                            </span>
                            <div className="min-w-0">
                              <h4 className="truncate text-sm font-semibold text-neutral-100">
                                {skill.name}
                              </h4>
                              <p className="text-xs text-neutral-500">
                                {skill.enabled ? "已启用" : "已禁用"}
                              </p>
                            </div>
                          </div>

                          <p className="mt-3 text-sm leading-6 text-neutral-400">
                            {skill.description?.trim() || "暂无说明。"}
                          </p>
                        </div>

                        <span
                          className={cn(
                            "rounded-full border px-2.5 py-1 text-xs font-medium",
                            skill.enabled
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                              : "border-neutral-700 bg-neutral-800 text-neutral-400"
                          )}
                        >
                          {skill.enabled ? "Enabled" : "Disabled"}
                        </span>
                      </div>

                      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800 pt-4">
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-medium uppercase tracking-[0.18em] text-neutral-500">
                            启用
                          </span>
                          <SkillSwitch
                            checked={skill.enabled}
                            disabled={isBusy}
                            onChange={(next) => void handleToggleSkill(skill, next)}
                          />
                          {isToggling ? (
                            <span className="inline-flex items-center gap-1 text-xs text-neutral-400">
                              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                              更新中
                            </span>
                          ) : null}
                        </div>

                        <Button
                          variant="outline"
                          className="border-red-500/30 bg-transparent text-red-300 hover:bg-red-500/10 hover:text-red-200"
                          onClick={() => void handleUninstallSkill(skill)}
                          disabled={isBusy}
                        >
                          {isUninstalling ? (
                            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="mr-2 h-4 w-4" />
                          )}
                          卸载
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {feedback ? (
        <div
          className={cn(
            "rounded-2xl border px-4 py-3 text-sm",
            feedback.type === "error"
              ? "border-red-500/25 bg-red-500/10 text-red-200"
              : feedback.type === "success"
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
              : "border-neutral-700 bg-neutral-900 text-neutral-300"
          )}
        >
          {feedback.text}
        </div>
      ) : null}
    </section>
  );
}
