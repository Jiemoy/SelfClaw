import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import {
  ExternalLink,
  Info,
  LoaderCircle,
  PackagePlus,
  Puzzle,
  RefreshCw,
  ShieldCheck,
  Wrench,
  X,
} from "lucide-react";
import { Button, Input } from "@/components/ui";
import { isIgnorableTauriInvokeError } from "@/lib/tauriErrors";
import { cn } from "@/lib/utils";

type HubTab = "skills" | "plugins";
type FeedbackType = "info" | "error";

interface FeedbackState {
  type: FeedbackType;
  text: string;
}

interface HubItem {
  key: string;
  name: string;
  description?: string;
  status?: string;
  enabled?: boolean;
}

interface DetailModalState {
  title: string;
  content: string;
}

const CLAWHUB_MARKET_URL = "https://openclaw.ai/clawhub";
const JSON_ARRAY_KEYS = ["data", "items", "list", "skills", "plugins", "rows", "result"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "enabled", "active", "online", "running"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "disabled", "inactive", "offline", "stopped"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function inferEnabledFromText(text: string | undefined): boolean | undefined {
  if (!text) {
    return undefined;
  }

  const normalized = text.toLowerCase();
  if (
    normalized.includes("disabled") ||
    normalized.includes("disable") ||
    normalized.includes("inactive") ||
    normalized.includes("offline") ||
    normalized.includes("off")
  ) {
    return false;
  }

  if (
    normalized.includes("enabled") ||
    normalized.includes("enable") ||
    normalized.includes("active") ||
    normalized.includes("online") ||
    normalized.includes("running") ||
    normalized.includes("on")
  ) {
    return true;
  }

  return undefined;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function collectJsonRecords(raw: string): Record<string, unknown>[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (Array.isArray(parsed)) {
    return parsed.filter(isRecord);
  }

  if (!isRecord(parsed)) {
    return [];
  }

  for (const key of JSON_ARRAY_KEYS) {
    const candidate = parsed[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord);
    }
  }

  const hasDirectFields =
    asText(parsed.name) ||
    asText(parsed.id) ||
    asText(parsed.skill) ||
    asText(parsed.plugin) ||
    asText(parsed.slug);
  if (hasDirectFields) {
    return [parsed];
  }

  const inferred: Record<string, unknown>[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      continue;
    }
    inferred.push({
      name,
      ...value,
    });
  }
  return inferred;
}

function mapRecordToHubItem(record: Record<string, unknown>): HubItem | null {
  const name =
    asText(record.name) ??
    asText(record.id) ??
    asText(record.skill) ??
    asText(record.plugin) ??
    asText(record.slug);
  if (!name) {
    return null;
  }

  const description =
    asText(record.description) ??
    asText(record.desc) ??
    asText(record.summary) ??
    asText(record.remark);

  const status =
    asText(record.status) ??
    asText(record.state) ??
    asText(record.health) ??
    asText(record.mode);

  const enabled =
    parseBoolean(record.enabled) ??
    parseBoolean(record.active) ??
    parseBoolean(record.is_enabled) ??
    inferEnabledFromText(status);

  return {
    key: normalizeKey(name),
    name,
    description,
    status,
    enabled,
  };
}

function parseTextItems(raw: string): HubItem[] {
  const records = new Map<string, HubItem>();
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const lowered = line.toLowerCase();
    if (
      /^[-=]{3,}$/.test(line) ||
      (lowered.includes("name") && lowered.includes("status")) ||
      lowered.startsWith("total")
    ) {
      continue;
    }

    const normalizedLine = line
      .replace(/^\d+[.)]\s*/, "")
      .replace(/^[-*]\s*/, "");
    const columns = normalizedLine.includes("|")
      ? normalizedLine
          .split("|")
          .map((part) => part.trim())
          .filter(Boolean)
      : normalizedLine.split(/\s{2,}|\t+/).map((part) => part.trim()).filter(Boolean);

    if (columns.length === 0) {
      continue;
    }

    let [name, status, ...rest] = columns;
    if (!status && normalizedLine.includes(" ")) {
      const compact = normalizedLine.split(/\s+/).filter(Boolean);
      name = compact[0];
      status = compact[1];
      rest = compact.slice(2);
    }

    if (!name) {
      continue;
    }

    const key = normalizeKey(name);
    const description = rest.join(" ").trim() || undefined;
    const mergedStatus = status?.trim();
    const enabled = inferEnabledFromText([mergedStatus, description].filter(Boolean).join(" "));

    records.set(key, {
      key,
      name,
      description,
      status: mergedStatus,
      enabled,
    });
  }

  return Array.from(records.values());
}

function parseHubItems(raw: string): HubItem[] {
  const jsonRecords = collectJsonRecords(raw);
  const map = new Map<string, HubItem>();

  for (const record of jsonRecords) {
    const mapped = mapRecordToHubItem(record);
    if (!mapped) {
      continue;
    }
    map.set(mapped.key, mapped);
  }

  if (map.size === 0) {
    for (const item of parseTextItems(raw)) {
      map.set(item.key, item);
    }
  }

  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function isActionLoading(activeAction: string | null, key: string): boolean {
  return activeAction === key;
}

function formatOutput(result: string, fallback: string): string {
  const trimmed = result.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function ClawHubPanel() {
  const [activeTab, setActiveTab] = useState<HubTab>("skills");
  const [skills, setSkills] = useState<HubItem[]>([]);
  const [plugins, setPlugins] = useState<HubItem[]>([]);
  const [pluginName, setPluginName] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [detailModal, setDetailModal] = useState<DetailModalState | null>(null);

  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshHubData = useCallback(async () => {
    if (!mountedRef.current) {
      return;
    }

    setIsRefreshing(true);
    setFeedback(null);

    const [skillsResult, pluginsResult] = await Promise.allSettled([
      invoke<string>("skills_list"),
      invoke<string>("plugins_list"),
    ]);

    if (!mountedRef.current) {
      return;
    }

    const errors: string[] = [];

    if (skillsResult.status === "fulfilled") {
      setSkills(parseHubItems(skillsResult.value));
    } else if (!isIgnorableTauriInvokeError(skillsResult.reason)) {
      errors.push(`加载技能列表失败：${String(skillsResult.reason)}`);
    }

    if (pluginsResult.status === "fulfilled") {
      setPlugins(parseHubItems(pluginsResult.value));
    } else if (!isIgnorableTauriInvokeError(pluginsResult.reason)) {
      errors.push(`加载插件列表失败：${String(pluginsResult.reason)}`);
    }

    if (errors.length > 0) {
      setFeedback({ type: "error", text: errors.join(" | ") });
    }

    setIsRefreshing(false);
  }, []);

  useEffect(() => {
    void refreshHubData();
  }, [refreshHubData]);

  const runCommand = useCallback(
    async (
      command: string,
      actionKey: string,
      payload?: Record<string, unknown>,
      fallbackMessage = "操作已完成"
    ): Promise<string | null> => {
      if (!mountedRef.current) {
        return null;
      }

      setActiveAction(actionKey);
      setFeedback(null);

      try {
        const result = payload
          ? await invoke<string>(command, payload)
          : await invoke<string>(command);
        if (!mountedRef.current) {
          return null;
        }
        const message = formatOutput(result, fallbackMessage);
        setFeedback({ type: "info", text: message });
        return message;
      } catch (error) {
        if (!mountedRef.current || isIgnorableTauriInvokeError(error)) {
          return null;
        }
        setFeedback({ type: "error", text: String(error) });
        return null;
      } finally {
        if (mountedRef.current) {
          setActiveAction(null);
        }
      }
    },
    []
  );

  const openMarketPage = async () => {
    try {
      await open(CLAWHUB_MARKET_URL);
    } catch (error) {
      setFeedback({
        type: "error",
        text: `打开 ClawHub 市场失败：${String(error)}`,
      });
    }
  };

  const handleInstallPlugin = async () => {
    const name = pluginName.trim();
    if (!name) {
      setFeedback({ type: "error", text: "请输入要安装的插件名称" });
      return;
    }

    const output = await runCommand(
      "plugins_install",
      `plugins-install:${name}`,
      { name },
      `插件 ${name} 安装完成`
    );
    if (!output || !mountedRef.current) {
      return;
    }

    setPluginName("");
    await refreshHubData();
  };

  const handleSkillInfo = async (item: HubItem) => {
    const output = await runCommand(
      "skills_info",
      `skills-info:${item.key}`,
      { name: item.name },
      `${item.name} 信息获取完成`
    );
    if (!output || !mountedRef.current) {
      return;
    }

    setDetailModal({
      title: `技能信息 · ${item.name}`,
      content: output,
    });
  };

  const handleSkillCheck = async (item: HubItem) => {
    await runCommand(
      "skills_check",
      `skills-check:${item.key}`,
      undefined,
      `技能依赖检查完成（${item.name}）`
    );
  };

  const handlePluginInfo = async (item: HubItem) => {
    const output = await runCommand(
      "plugins_info",
      `plugins-info:${item.key}`,
      { name: item.name },
      `${item.name} 信息获取完成`
    );
    if (!output || !mountedRef.current) {
      return;
    }

    setDetailModal({
      title: `插件详情 · ${item.name}`,
      content: output,
    });
  };

  const handleTogglePlugin = async (item: HubItem) => {
    const currentlyEnabled = item.enabled ?? inferEnabledFromText(item.status) ?? false;
    const nextEnabled = !currentlyEnabled;
    const command = nextEnabled ? "plugins_enable" : "plugins_disable";
    const output = await runCommand(
      command,
      `plugins-toggle:${item.key}`,
      { name: item.name },
      `插件 ${item.name} 已${nextEnabled ? "启用" : "禁用"}`
    );
    if (!output || !mountedRef.current) {
      return;
    }

    setPlugins((previous) =>
      previous.map((plugin) =>
        plugin.key === item.key
          ? {
              ...plugin,
              enabled: nextEnabled,
              status: nextEnabled ? "enabled" : "disabled",
            }
          : plugin
      )
    );
  };

  const handlePluginDoctor = async (item: HubItem) => {
    await runCommand(
      "plugins_doctor",
      `plugins-doctor:${item.key}`,
      undefined,
      `插件诊断完成（${item.name}）`
    );
  };

  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-neutral-100">ClawHub</h2>
          <p className="text-sm text-neutral-400">
            官方技能与社区插件统一管理，全部命令实时绑定 OpenClaw CLI。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-800"
            onClick={() => void refreshHubData()}
            disabled={isRefreshing || activeAction !== null}
          >
            <RefreshCw className={cn("mr-2 h-4 w-4", isRefreshing ? "animate-spin" : "")} />
            刷新列表
          </Button>
          <Button className="bg-orange-500 text-white hover:bg-orange-400" onClick={openMarketPage}>
            <ExternalLink className="mr-2 h-4 w-4" />
            前往 ClawHub 市场探索
          </Button>
        </div>
      </header>

      <div className="rounded-xl border border-neutral-800 bg-neutral-800 p-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[260px] flex-1">
            <label htmlFor="plugin-install-name" className="mb-1 block text-xs text-neutral-400">
              安装新插件
            </label>
            <Input
              id="plugin-install-name"
              value={pluginName}
              onChange={(event) => setPluginName(event.target.value)}
              placeholder="输入插件名称，例如: openclaw-plugin-xxx"
              className="border-neutral-700 bg-neutral-900 text-neutral-100 placeholder:text-neutral-500"
            />
          </div>
          <Button
            className="bg-orange-500 text-white hover:bg-orange-400"
            onClick={() => void handleInstallPlugin()}
            disabled={
              activeAction !== null ||
              isActionLoading(activeAction, `plugins-install:${pluginName.trim()}`) ||
              pluginName.trim().length === 0
            }
          >
            {isActionLoading(activeAction, `plugins-install:${pluginName.trim()}`) ? (
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <PackagePlus className="mr-2 h-4 w-4" />
            )}
            {isActionLoading(activeAction, `plugins-install:${pluginName.trim()}`) ? "安装中..." : "安装插件"}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-neutral-800 bg-neutral-800 p-4">
        <div className="mb-4 flex items-center gap-2">
          <button
            type="button"
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm transition",
              activeTab === "skills"
                ? "bg-orange-500/20 text-orange-300"
                : "text-neutral-300 hover:bg-neutral-700"
            )}
            onClick={() => setActiveTab("skills")}
          >
            官方技能 (Skills)
          </button>
          <button
            type="button"
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm transition",
              activeTab === "plugins"
                ? "bg-orange-500/20 text-orange-300"
                : "text-neutral-300 hover:bg-neutral-700"
            )}
            onClick={() => setActiveTab("plugins")}
          >
            社区插件 (Plugins)
          </button>
        </div>

        {activeTab === "skills" ? (
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
            {skills.map((item) => (
              <article
                key={item.key}
                className="rounded-xl border border-neutral-700 bg-neutral-900/70 p-4"
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-orange-500/20 p-1.5 text-orange-300">
                      <Puzzle className="h-4 w-4" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-neutral-100">{item.name}</h3>
                      <p className="text-xs text-neutral-500">{item.status ?? "状态未提供"}</p>
                    </div>
                  </div>
                </div>

                <p className="mb-3 line-clamp-3 text-sm text-neutral-300">
                  {item.description ?? "暂无技能描述。"}
                </p>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    className="border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-800"
                    onClick={() => void handleSkillInfo(item)}
                    disabled={activeAction !== null}
                  >
                    {isActionLoading(activeAction, `skills-info:${item.key}`) ? (
                      <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Info className="mr-2 h-4 w-4" />
                    )}
                    信息
                  </Button>
                  <Button
                    variant="outline"
                    className="border-orange-500/40 bg-neutral-900 text-orange-300 hover:bg-orange-500/10"
                    onClick={() => void handleSkillCheck(item)}
                    disabled={activeAction !== null}
                  >
                    {isActionLoading(activeAction, `skills-check:${item.key}`) ? (
                      <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="mr-2 h-4 w-4" />
                    )}
                    依赖检查
                  </Button>
                </div>
              </article>
            ))}

            {skills.length === 0 && !isRefreshing ? (
              <div className="col-span-full rounded-xl border border-dashed border-neutral-700 bg-neutral-900/40 p-8 text-center text-sm text-neutral-400">
                当前未解析到技能列表，请确认 `openclaw skills list` 输出正常。
              </div>
            ) : null}
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
            {plugins.map((item) => {
              const enabled = item.enabled ?? inferEnabledFromText(item.status) ?? false;
              return (
                <article
                  key={item.key}
                  className="rounded-xl border border-neutral-700 bg-neutral-900/70 p-4"
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="rounded-md bg-orange-500/20 p-1.5 text-orange-300">
                        <PackagePlus className="h-4 w-4" />
                      </span>
                      <div>
                        <h3 className="text-sm font-semibold text-neutral-100">{item.name}</h3>
                        <p className="text-xs text-neutral-500">{item.status ?? "状态未提供"}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={activeAction !== null}
                      onClick={() => void handleTogglePlugin(item)}
                      className={cn(
                        "relative inline-flex h-6 w-11 items-center rounded-full transition",
                        enabled ? "bg-orange-500" : "bg-neutral-600",
                        activeAction !== null ? "cursor-not-allowed opacity-70" : "cursor-pointer"
                      )}
                      aria-label={enabled ? `禁用插件 ${item.name}` : `启用插件 ${item.name}`}
                    >
                      <span
                        className={cn(
                          "inline-block h-5 w-5 transform rounded-full bg-white transition",
                          enabled ? "translate-x-5" : "translate-x-1"
                        )}
                      />
                    </button>
                  </div>

                  <p className="mb-3 line-clamp-3 text-sm text-neutral-300">
                    {item.description ?? "暂无插件描述。"}
                  </p>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      className="border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-800"
                      onClick={() => void handlePluginInfo(item)}
                      disabled={activeAction !== null}
                    >
                      {isActionLoading(activeAction, `plugins-info:${item.key}`) ? (
                        <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Info className="mr-2 h-4 w-4" />
                      )}
                      信息详情
                    </Button>
                    <Button
                      variant="outline"
                      className="border-orange-500/40 bg-neutral-900 text-orange-300 hover:bg-orange-500/10"
                      onClick={() => void handlePluginDoctor(item)}
                      disabled={activeAction !== null}
                    >
                      {isActionLoading(activeAction, `plugins-doctor:${item.key}`) ? (
                        <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Wrench className="mr-2 h-4 w-4" />
                      )}
                      诊断
                    </Button>
                  </div>
                </article>
              );
            })}

            {plugins.length === 0 && !isRefreshing ? (
              <div className="col-span-full rounded-xl border border-dashed border-neutral-700 bg-neutral-900/40 p-8 text-center text-sm text-neutral-400">
                当前未解析到插件列表，请确认 `openclaw plugins list` 输出正常。
              </div>
            ) : null}
          </div>
        )}
      </div>

      {feedback ? (
        <p className={cn("text-sm", feedback.type === "error" ? "text-red-400" : "text-neutral-300")}>
          {feedback.text}
        </p>
      ) : null}

      {detailModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-neutral-700 bg-neutral-900 shadow-xl">
            <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
              <h3 className="text-sm font-semibold text-neutral-100">{detailModal.title}</h3>
              <button
                type="button"
                className="rounded-md p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                onClick={() => setDetailModal(null)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs text-neutral-200">
              {detailModal.content}
            </pre>
          </div>
        </div>
      ) : null}
    </section>
  );
}
