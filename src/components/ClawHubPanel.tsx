import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { remove } from "@tauri-apps/plugin-fs";
import { open } from "@tauri-apps/plugin-shell";
import {
  ExternalLink,
  Globe,
  LoaderCircle,
  PackagePlus,
  Puzzle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { Button, Input, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import { isIgnorableTauriInvokeError } from "@/lib/tauriErrors";
import { cn } from "@/lib/utils";

type HubView = "discover" | "installed";
type FeedbackType = "info" | "success" | "error";
type InstalledKind = "skill" | "plugin";
type IframeState = "loading" | "ready" | "slow";
type InstallMode = "skillZip" | "pluginCommand";
type SkillUpdateState = "idle" | "checking" | "available" | "latest" | "error";

interface FeedbackState {
  type: FeedbackType;
  text: string;
}

interface SkillListEntry {
  name: string;
  description?: string | null;
  source: string;
  bundled: boolean;
  disabled: boolean;
  eligible: boolean;
  blockedByAllowlist: boolean;
  emoji?: string | null;
  homepage?: string | null;
}

interface SkillsListReport {
  workspaceDir?: string;
  managedSkillsDir?: string;
  skills?: SkillListEntry[];
}

interface SkillDetail extends SkillListEntry {
  skillKey?: string | null;
  filePath?: string | null;
  baseDir?: string | null;
}

interface PluginListEntry {
  id: string;
  name?: string | null;
  description?: string | null;
  origin?: string | null;
  enabled?: boolean;
  status?: string | null;
  rootDir?: string | null;
  source?: string | null;
}

interface PluginsListReport {
  workspaceDir?: string;
  plugins?: PluginListEntry[];
}

interface InstalledItem {
  kind: InstalledKind;
  id: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  needsAttention: boolean;
  clawhubSlug?: string | null;
  installedVersion?: string | null;
  latestVersion?: string | null;
  updateState?: SkillUpdateState;
  updateMessage?: string | null;
}

interface ItemStats {
  skills: number;
  plugins: number;
}

interface InstallProgressState {
  progress: number;
  stage: string;
  slug?: string | null;
}

interface SkillInstallResult {
  slug: string;
  installedDir: string;
  sourceUrl: string;
  downloadUrl: string;
}

interface InstalledClawHubSkillMeta {
  name: string;
  slug: string;
  installedVersion?: string | null;
  installedDir: string;
}

interface ClawHubSkillUpdateCheckInput {
  slug: string;
  installedVersion?: string | null;
}

interface ClawHubSkillUpdateInfo {
  slug: string;
  installedVersion?: string | null;
  latestVersion?: string | null;
  updateAvailable: boolean;
  sourceUrl: string;
  downloadUrl?: string | null;
  message?: string | null;
}

interface InstallPreview {
  request: InstallRequest | null;
  error: string | null;
}

interface RefreshOptions {
  showSuccess?: boolean;
  keepFeedback?: boolean;
}

interface SkillSwitchProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

interface BaseInstallRequest {
  mode: InstallMode;
  kind: InstalledKind;
  label: string;
  sourceLabel: string;
  summary: string;
}

interface SkillZipInstallRequest extends BaseInstallRequest {
  mode: "skillZip";
  kind: "skill";
  input: string;
}

interface PluginCommandInstallRequest extends BaseInstallRequest {
  mode: "pluginCommand";
  kind: "plugin";
  args: string[];
}

type InstallRequest = SkillZipInstallRequest | PluginCommandInstallRequest;

const CLAWHUB_STORE_URL = "https://clawhub.ai";
const MANAGED_SKILL_SOURCE = "openclaw-managed";
const IFRAME_SLOW_THRESHOLD_MS = 6000;

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function parseJsonPayload<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = [trimmed];
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      candidates.push(trimmed.slice(objectStart, objectEnd + 1));
    }

    const arrayStart = trimmed.indexOf("[");
    const arrayEnd = trimmed.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      candidates.push(trimmed.slice(arrayStart, arrayEnd + 1));
    }
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }

  return null;
}

async function runOpenClawText(args: string[]): Promise<string> {
  return invoke<string>("run_sys_command", {
    command: "openclaw",
    args,
  });
}

async function runOpenClawJson<T>(args: string[]): Promise<T> {
  try {
    const output = await runOpenClawText(args);
    const parsed = parseJsonPayload<T>(output);
    if (parsed !== null) {
      return parsed;
    }
  } catch (error) {
    const recovered = parseJsonPayload<T>(formatError(error));
    if (recovered !== null) {
      return recovered;
    }
    throw error;
  }

  throw new Error("OpenClaw 返回了无法解析的数据。");
}

function formatCommandOutput(result: string, fallback: string): string {
  const trimmed = result.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isWithinRoot(candidate: string, root: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedCandidate = normalizePath(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function tokenizeInput(value: string): string[] {
  const matches = value.match(/"[^"]*"|'[^']*'|\S+/g);
  if (!matches) {
    return [];
  }
  return matches.map(stripWrappingQuotes);
}

function formatKindLabel(kind: InstalledKind): string {
  return kind === "plugin" ? "插件" : "技能";
}

function looksLikeBundledPlugin(plugin: PluginListEntry): boolean {
  const origin = plugin.origin?.trim().toLowerCase() || "";
  if (origin === "bundled") {
    return true;
  }

  const bundledRoots = [plugin.rootDir, plugin.source]
    .map((value) => (typeof value === "string" ? normalizePath(value) : ""))
    .filter(Boolean);

  return bundledRoots.some((value) =>
    value.includes("/node_modules/openclaw/dist/extensions/")
  );
}

function isManageablePlugin(plugin: PluginListEntry): boolean {
  return Boolean(plugin.id?.trim()) && !looksLikeBundledPlugin(plugin);
}

function buildToggleArgs(skillKey: string, enabled: boolean): string[] {
  return [
    "config",
    "set",
    "--strict-json",
    `skills.entries.${skillKey}.enabled`,
    enabled ? "true" : "false",
  ];
}

function getInstallTarget(tokens: string[]): string | null {
  const tail = tokens.slice(2);
  for (let index = 0; index < tail.length; index += 1) {
    const token = tail[index];
    if (!token.startsWith("-")) {
      return token;
    }

    if (token === "--version" || token === "--marketplace") {
      index += 1;
    }
  }

  return null;
}

function isClawHubHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "clawhub.ai" || normalized.endsWith(".clawhub.ai");
}

function looksLikePluginSpecifier(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return (
    lower.startsWith("clawhub:") ||
    lower.startsWith("@") ||
    lower.includes("/plugins/") ||
    lower.endsWith("-plugin") ||
    lower.startsWith("plugin-") ||
    lower.includes("plugin")
  );
}

function buildSkillRequest(
  input: string,
  label: string,
  sourceLabel: string
): SkillZipInstallRequest {
  return {
    mode: "skillZip",
    kind: "skill",
    input,
    label,
    sourceLabel,
    summary: "将自动下载 zip、解压并安装到本机技能目录。",
  };
}

function buildPluginRequest(
  label: string,
  args: string[],
  sourceLabel: string
): PluginCommandInstallRequest {
  return {
    mode: "pluginCommand",
    kind: "plugin",
    label,
    args,
    sourceLabel,
    summary: "将按插件方式安装到本机，安装后可在“我的技能”里启用、停用或卸载。",
  };
}

function resolveInstallRequest(value: string): InstallRequest {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("请输入技能页链接、下载链接、插件链接或包名。");
  }

  try {
    const url = new URL(trimmed);
    const lower = trimmed.toLowerCase();

    if (lower.includes("/api/v1/download?slug=")) {
      const slug = url.searchParams.get("slug")?.trim();
      if (!slug) {
        throw new Error("这个下载链接里没有技能名称，暂时无法自动安装。");
      }
      return buildSkillRequest(trimmed, slug, "技能下载链接");
    }

    if (isClawHubHost(url.hostname)) {
      const segments = url.pathname
        .split("/")
        .map((segment) => decodeURIComponent(segment.trim()))
        .filter(Boolean);

      if (segments.length < 2) {
        throw new Error("请粘贴具体的技能详情页或插件详情页链接。");
      }

      if (segments[0] === "plugins" && segments[1]) {
        const slug = segments[1].trim();
        return buildPluginRequest(
          slug,
          ["plugins", "install", `clawhub:${slug}`],
          "插件页面链接"
        );
      }

      const slug = segments[segments.length - 1]?.trim();
      if (!slug) {
        throw new Error("没有从链接里识别到技能名称。");
      }

      return buildSkillRequest(trimmed, slug, "技能页面链接");
    }

    throw new Error("这里只支持 ClawHub 技能页链接、Download zip 链接、插件页链接或包名。");
  } catch (error) {
    if (error instanceof TypeError) {
      // Not a URL. Fall through to command / plain text handling.
    } else if (error instanceof Error) {
      throw error;
    }
  }

  const tokens = tokenizeInput(trimmed);
  const normalizedTokens =
    tokens[0]?.toLowerCase() === "openclaw" ? tokens.slice(1) : tokens;

  if (
    normalizedTokens.length >= 2 &&
    (normalizedTokens[0]?.toLowerCase() === "skills" ||
      normalizedTokens[0]?.toLowerCase() === "plugins") &&
    normalizedTokens[1]?.toLowerCase() === "install"
  ) {
    const target = getInstallTarget(normalizedTokens);
    if (!target) {
      throw new Error("没有从安装命令里识别到要安装的内容。");
    }

    if (normalizedTokens[0]?.toLowerCase() === "plugins") {
      return buildPluginRequest(target, normalizedTokens, "插件安装命令");
    }

    return buildSkillRequest(target, target, "技能安装命令");
  }

  if (tokens[0]?.toLowerCase() === "openclaw") {
    throw new Error("这里只支持技能或插件安装相关的链接、命令和包名。");
  }

  if (/\s/.test(trimmed)) {
    throw new Error("请直接粘贴一个链接、一条安装命令，或只输入一个包名。");
  }

  if (/^clawhub:/i.test(trimmed) || looksLikePluginSpecifier(trimmed)) {
    return buildPluginRequest(trimmed, ["plugins", "install", trimmed], "插件包名");
  }

  return buildSkillRequest(trimmed, trimmed, "技能名");
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
          ? "border-orange-300/80 bg-gradient-to-r from-orange-500 to-amber-400"
          : "border-neutral-700 bg-neutral-800",
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
  const [installedItems, setInstalledItems] = useState<InstalledItem[]>([]);
  const [installInput, setInstallInput] = useState("");
  const [managedSkillsDir, setManagedSkillsDir] = useState<string | null>(null);
  const [hiddenSystemCount, setHiddenSystemCount] = useState(0);
  const [stats, setStats] = useState<ItemStats>({ skills: 0, plugins: 0 });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [iframeState, setIframeState] = useState<IframeState>("loading");
  const [iframeKey, setIframeKey] = useState(0);
  const [hasLoadedInstalled, setHasLoadedInstalled] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [installProgress, setInstallProgress] = useState<InstallProgressState | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    const unlistenPromise = listen<InstallProgressState>(
      "clawhub-skill-install-progress",
      (event) => {
        if (disposed || !mountedRef.current) {
          return;
        }

        const payload = event.payload;
        setInstallProgress({
          progress: Math.max(0, Math.min(100, Number(payload.progress) || 0)),
          stage: payload.stage?.trim() || "正在安装...",
          slug: payload.slug?.trim() || null,
        });
      }
    );

    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (activeTab !== "discover" || iframeState === "ready") {
      return;
    }

    const timer = window.setTimeout(() => {
      if (!mountedRef.current) {
        return;
      }

      setIframeState((previous) => (previous === "ready" ? previous : "slow"));
    }, IFRAME_SLOW_THRESHOLD_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeTab, iframeKey, iframeState]);

  const refreshInstalledItems = useCallback(
    async (options: RefreshOptions = {}) => {
      if (!mountedRef.current) {
        return;
      }

      setIsRefreshing(true);
      if (!options.keepFeedback) {
        setFeedback(null);
      }

      try {
        const [skillsReport, pluginsReport, clawhubSkillMeta] = await Promise.all([
          runOpenClawJson<SkillsListReport>(["skills", "list", "--json"]),
          runOpenClawJson<PluginsListReport>(["plugins", "list", "--json"]),
          invoke<InstalledClawHubSkillMeta[]>("list_installed_clawhub_skills"),
        ]);

        if (!mountedRef.current) {
          return;
        }

        const allSkills = Array.isArray(skillsReport.skills) ? skillsReport.skills : [];
        const allPlugins = Array.isArray(pluginsReport.plugins) ? pluginsReport.plugins : [];
        const installedClawHubSkills = Array.isArray(clawhubSkillMeta) ? clawhubSkillMeta : [];
        const clawhubMetaByName = new Map(
          installedClawHubSkills.map((entry) => [entry.name.trim(), entry])
        );

        const skillItems: InstalledItem[] = allSkills
          .filter((skill) => skill.source === MANAGED_SKILL_SOURCE)
          .map((skill) => {
            const meta = clawhubMetaByName.get(skill.name.trim());
            return {
              kind: "skill",
              id: skill.name,
              name: skill.name,
              description: skill.description,
              enabled: !skill.disabled,
              needsAttention: !skill.disabled && !skill.eligible,
              clawhubSlug: meta?.slug?.trim() || null,
              installedVersion: meta?.installedVersion?.trim() || null,
              latestVersion: null,
              updateState: meta ? "idle" : undefined,
              updateMessage: null,
            };
          });

        const pluginItems: InstalledItem[] = allPlugins
          .filter(isManageablePlugin)
          .map((plugin) => ({
            kind: "plugin",
            id: plugin.id.trim(),
            name: plugin.name?.trim() || plugin.id.trim(),
            description: plugin.description,
            enabled: plugin.enabled !== false && plugin.status !== "disabled",
            needsAttention: false,
            clawhubSlug: null,
            installedVersion: null,
            latestVersion: null,
            updateState: undefined,
            updateMessage: null,
          }));

        const mergedItems = [...skillItems, ...pluginItems].sort((left, right) =>
          left.name.localeCompare(right.name)
        );

        setInstalledItems(mergedItems);
        setManagedSkillsDir(skillsReport.managedSkillsDir?.trim() || null);
        setHiddenSystemCount(
          allSkills.filter((skill) => skill.bundled).length +
            allPlugins.filter((plugin) => !isManageablePlugin(plugin)).length
        );
        setStats({
          skills: skillItems.length,
          plugins: pluginItems.length,
        });
        setHasLoadedInstalled(true);

        if (options.showSuccess) {
          setFeedback({
            type: "info",
            text: "已刷新本地安装列表。",
          });
        }
      } catch (error) {
        if (!mountedRef.current || isIgnorableTauriInvokeError(error)) {
          return;
        }

        setHasLoadedInstalled(true);
        setFeedback({
          type: "error",
          text: `加载本地安装列表失败：${formatError(error)}`,
        });
      } finally {
        if (mountedRef.current) {
          setIsRefreshing(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    if (activeTab === "installed" && !hasLoadedInstalled) {
      void refreshInstalledItems();
    }
  }, [activeTab, hasLoadedInstalled, refreshInstalledItems]);

  const installPreview = useMemo<InstallPreview>(() => {
    if (!installInput.trim()) {
      return { request: null, error: null };
    }

    try {
      return {
        request: resolveInstallRequest(installInput),
        error: null,
      };
    } catch (error) {
      return {
        request: null,
        error: formatError(error),
      };
    }
  }, [installInput]);

  const installButtonLabel = useMemo(() => {
    if (activeAction === "install") {
      return "安装中...";
    }

    if (installPreview.request?.kind === "plugin") {
      return "安装插件";
    }

    return "一键安装";
  }, [activeAction, installPreview.request]);

  const installedClawHubSkillCount = useMemo(
    () =>
      installedItems.filter(
        (item) => item.kind === "skill" && Boolean(item.clawhubSlug?.trim())
      ).length,
    [installedItems]
  );

  const pendingSkillUpdateCount = useMemo(
    () =>
      installedItems.filter(
        (item) => item.kind === "skill" && item.updateState === "available"
      ).length,
    [installedItems]
  );

  const openStoreExternally = async () => {
    try {
      await open(CLAWHUB_STORE_URL);
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }

      setFeedback({
        type: "error",
        text: `打开 ClawHub 失败：${formatError(error)}`,
      });
    }
  };

  const reloadStore = () => {
    setIframeState("loading");
    setIframeKey((previous) => previous + 1);
  };

  const handleInstall = async () => {
    let request: InstallRequest;
    try {
      request = resolveInstallRequest(installInput);
    } catch (error) {
      setFeedback({
        type: "error",
        text: formatError(error),
      });
      return;
    }

    setActiveAction("install");
    setFeedback(null);
    if (request.mode === "skillZip") {
      setInstallProgress({
        progress: 4,
        stage: "正在准备技能安装...",
        slug: request.label,
      });
    } else {
      setInstallProgress(null);
    }

    try {
      let successText = "";

      if (request.mode === "pluginCommand") {
        const result = await runOpenClawText(request.args);
        successText = formatCommandOutput(result, `插件 ${request.label} 已安装。`);
      } else {
        const result = await invoke<SkillInstallResult>("install_clawhub_skill_zip", {
          input: request.input,
        });
        successText = `技能 ${result.slug} 已安装到本机。`;
      }

      if (!mountedRef.current) {
        return;
      }

      setInstallProgress(null);
      setInstallInput("");
      setActiveTab("installed");
      setFeedback({
        type: "success",
        text: successText,
      });
      void refreshInstalledItems({ keepFeedback: true });
    } catch (error) {
      if (!mountedRef.current || isIgnorableTauriInvokeError(error)) {
        return;
      }

      setInstallProgress(null);
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

  const handleCheckSkillUpdates = async () => {
    const inputs: ClawHubSkillUpdateCheckInput[] = installedItems
      .filter(
        (item): item is InstalledItem & { clawhubSlug: string } =>
          item.kind === "skill" && Boolean(item.clawhubSlug?.trim())
      )
      .map((item) => ({
        slug: item.clawhubSlug.trim(),
        installedVersion: item.installedVersion?.trim() || null,
      }));

    if (inputs.length === 0) {
      setFeedback({
        type: "info",
        text: "当前没有支持在线检查更新的技能。",
      });
      return;
    }

    setActiveAction("check-updates");
    setFeedback(null);
    setInstalledItems((previous) =>
      previous.map((item) =>
        item.kind === "skill" && item.clawhubSlug
          ? {
              ...item,
              updateState: "checking",
              latestVersion: null,
              updateMessage: null,
            }
          : item
      )
    );

    try {
      const results = await invoke<ClawHubSkillUpdateInfo[]>("check_clawhub_skill_updates", {
        inputs,
      });

      if (!mountedRef.current) {
        return;
      }

      const resultBySlug = new Map(
        results
          .filter((entry) => entry.slug?.trim())
          .map((entry) => [entry.slug.trim(), entry])
      );
      const availableCount = results.filter((entry) => entry.updateAvailable).length;
      const errorCount = results.filter((entry) => entry.message?.trim()).length;

      setInstalledItems((previous) =>
        previous.map((item) => {
          if (item.kind !== "skill" || !item.clawhubSlug?.trim()) {
            return item;
          }

          const result = resultBySlug.get(item.clawhubSlug.trim());
          if (!result) {
            return {
              ...item,
              updateState: "error",
              updateMessage: "没有拿到这个技能的更新结果。",
            };
          }

          return {
            ...item,
            latestVersion: result.latestVersion?.trim() || null,
            updateState: result.message?.trim()
              ? "error"
              : result.updateAvailable
              ? "available"
              : "latest",
            updateMessage: result.message?.trim() || null,
          };
        })
      );

      setFeedback({
        type: errorCount > 0 ? "info" : "success",
        text:
          availableCount > 0
            ? `发现 ${availableCount} 个技能有新版本。`
            : errorCount > 0
            ? "更新检查已完成，部分技能暂时未能拿到最新版本信息。"
            : "所有已检查的技能都已经是最新版本。",
      });
    } catch (error) {
      if (!mountedRef.current || isIgnorableTauriInvokeError(error)) {
        return;
      }

      setInstalledItems((previous) =>
        previous.map((item) =>
          item.kind === "skill" && item.clawhubSlug
            ? {
                ...item,
                updateState: "error",
                updateMessage: "检查更新失败，请稍后重试。",
              }
            : item
        )
      );
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

  const handleUpdateSkill = async (item: InstalledItem) => {
    const slug = item.clawhubSlug?.trim();
    if (!slug) {
      setFeedback({
        type: "error",
        text: "这个技能暂时没有可用的在线更新来源。",
      });
      return;
    }

    const actionKey = `update:skill:${item.id}`;
    setActiveAction(actionKey);
    setFeedback(null);
    setInstallProgress({
      progress: 4,
      stage: "正在准备更新技能...",
      slug,
    });

    try {
      const result = await invoke<SkillInstallResult>("install_clawhub_skill_zip", {
        input: slug,
      });

      if (!mountedRef.current) {
        return;
      }

      setInstallProgress(null);
      setFeedback({
        type: "success",
        text: item.latestVersion?.trim()
          ? `技能 ${result.slug} 已更新到 v${item.latestVersion?.trim()}。`
          : `技能 ${result.slug} 已更新。`,
      });
      await refreshInstalledItems({ keepFeedback: true });
    } catch (error) {
      if (!mountedRef.current || isIgnorableTauriInvokeError(error)) {
        return;
      }

      setInstallProgress(null);
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

  const loadSkillDetail = useCallback(async (name: string) => {
    return runOpenClawJson<SkillDetail>(["skills", "info", name, "--json"]);
  }, []);

  const handleToggleItem = async (item: InstalledItem, nextEnabled: boolean) => {
    if (!mountedRef.current) {
      return;
    }

    const actionKey = `toggle:${item.kind}:${item.id}`;
    setActiveAction(actionKey);
    setFeedback(null);

    try {
      let result = "";

      if (item.kind === "plugin") {
        result = await runOpenClawText([
          "plugins",
          nextEnabled ? "enable" : "disable",
          item.id,
        ]);
      } else {
        const detail = await loadSkillDetail(item.name);
        const skillKey = detail.skillKey?.trim() || detail.name.trim();
        result = await runOpenClawText(buildToggleArgs(skillKey, nextEnabled));
      }

      if (!mountedRef.current) {
        return;
      }

      setInstalledItems((previous) =>
        previous.map((entry) =>
          entry.kind === item.kind && entry.id === item.id
            ? { ...entry, enabled: nextEnabled }
            : entry
        )
      );
      setFeedback({
        type: "success",
        text: formatCommandOutput(
          result,
          `${formatKindLabel(item.kind)} ${item.name} 已${nextEnabled ? "启用" : "停用"}。`
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

  const handleUninstallItem = async (item: InstalledItem) => {
    const itemLabel = formatKindLabel(item.kind);
    const confirmed = window.confirm(`确认卸载“${item.name}”这个${itemLabel}吗？`);
    if (!confirmed) {
      return;
    }

    const actionKey = `uninstall:${item.kind}:${item.id}`;
    setActiveAction(actionKey);
    setFeedback(null);

    try {
      if (item.kind === "plugin") {
        await runOpenClawText(["plugins", "uninstall", item.id, "--force"]);
      } else {
        const detail = await loadSkillDetail(item.name);
        const skillKey = detail.skillKey?.trim() || detail.name.trim();
        const baseDir = detail.baseDir?.trim();

        if (!baseDir) {
          throw new Error("没有找到这个技能的安装目录。");
        }

        if (!managedSkillsDir || !isWithinRoot(baseDir, managedSkillsDir)) {
          throw new Error("这个技能不在可管理的安装目录里，已取消卸载。");
        }

        await remove(baseDir, { recursive: true });

        try {
          await runOpenClawText(["config", "unset", `skills.entries.${skillKey}`]);
        } catch {
          // Best effort cleanup. Missing config entries are fine.
        }
      }

      if (!mountedRef.current) {
        return;
      }

      setInstalledItems((previous) =>
        previous.filter((entry) => !(entry.kind === item.kind && entry.id === item.id))
      );
      setStats((previous) => ({
        skills: item.kind === "skill" ? Math.max(previous.skills - 1, 0) : previous.skills,
        plugins:
          item.kind === "plugin" ? Math.max(previous.plugins - 1, 0) : previous.plugins,
      }));
      setFeedback({
        type: "success",
        text: `${itemLabel} ${item.name} 已卸载。`,
      });
      void refreshInstalledItems({ keepFeedback: true });
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

  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as HubView)}
        className="flex min-h-0 flex-1 flex-col gap-4"
      >
        <div className="rounded-[32px] border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(251,146,60,0.2),transparent_32%),linear-gradient(180deg,rgba(24,24,28,0.98),rgba(12,12,14,0.98))] px-5 py-5 shadow-[0_28px_90px_-58px_rgba(249,115,22,0.52)] md:px-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.32em] text-orange-200/80">
                <Sparkles className="h-3.5 w-3.5" />
                ClawHub
              </div>
              <h2 className="mt-2 text-2xl font-semibold text-neutral-50">发现与管理</h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-neutral-400">
                在官方商店挑选技能后，把技能页链接、下载链接或名称贴进来即可安装。安装成功后，这里也能直接启用、停用和卸载。
              </p>
            </div>

            <TabsList className="h-auto gap-2 rounded-2xl border border-white/10 bg-neutral-950/70 p-2">
              <TabsTrigger
                value="discover"
                className="rounded-xl px-4 py-2 data-[state=active]:bg-orange-500/20 data-[state=active]:text-orange-100"
              >
                <Globe className="mr-2 h-4 w-4" />
                发现技能
              </TabsTrigger>
              <TabsTrigger
                value="installed"
                className="rounded-xl px-4 py-2 data-[state=active]:bg-orange-500/20 data-[state=active]:text-orange-100"
              >
                <ShieldCheck className="mr-2 h-4 w-4" />
                我的技能
              </TabsTrigger>
            </TabsList>
          </div>
        </div>

        <TabsContent value="discover" className="mt-0 flex min-h-0 flex-1 flex-col gap-4">
          <div className="rounded-[32px] border border-neutral-800 bg-[radial-gradient(circle_at_top_left,rgba(251,191,36,0.18),transparent_24%),linear-gradient(180deg,rgba(28,18,11,0.98),rgba(11,11,13,0.98))] p-5 shadow-[0_28px_120px_-64px_rgba(249,115,22,0.65)] md:p-6">
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)] xl:items-end">
              <div className="min-w-0">
                <div className="inline-flex items-center gap-2 rounded-full border border-orange-400/20 bg-orange-500/10 px-3 py-1 text-xs font-medium text-orange-100">
                  <WandSparkles className="h-3.5 w-3.5" />
                  一条龙安装
                </div>
                <h3 className="mt-3 text-xl font-semibold text-white">
                  打开技能详情页后，复制链接回来就行
                </h3>
                <p className="mt-2 max-w-3xl text-sm leading-7 text-neutral-300">
                  软件会自动识别技能页面里的 Download zip，完成下载、解压和安装。插件链接也能直接识别，不用自己去研究底层目录结构。
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-200">
                    支持技能详情页链接
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-200">
                    支持 Download zip 链接
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-200">
                    也支持直接输入技能名
                  </span>
                </div>
              </div>

              <div className="rounded-[28px] border border-white/10 bg-black/28 p-4 shadow-[0_18px_60px_-42px_rgba(0,0,0,0.9)]">
                <label
                  htmlFor="clawhub-install-input"
                  className="text-sm font-medium text-neutral-100"
                >
                  一键安装
                </label>
                <div className="mt-3 flex flex-col gap-3">
                  <Input
                    id="clawhub-install-input"
                    value={installInput}
                    onChange={(event) => setInstallInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void handleInstall();
                      }
                    }}
                    placeholder="例如：https://clawhub.ai/skills/self-improving-agent 或 self-improving-agent"
                    className="h-12 border-white/10 bg-black/55 text-neutral-50 placeholder:text-neutral-500"
                  />

                  <Button
                    className="h-12 bg-orange-500 px-6 text-white hover:bg-orange-400"
                    onClick={() => void handleInstall()}
                    disabled={
                      Boolean(activeAction) ||
                      installInput.trim().length === 0 ||
                      Boolean(installPreview.error)
                    }
                  >
                    {activeAction === "install" ? (
                      <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <PackagePlus className="mr-2 h-4 w-4" />
                    )}
                    {installButtonLabel}
                  </Button>
                </div>
                <p className="mt-3 text-xs leading-6 text-neutral-400">
                  技能页链接会自动走 zip 安装；插件页链接或插件安装命令会自动按插件方式处理。
                </p>
              </div>
            </div>

            {installPreview.request ? (
              <div className="mt-4 rounded-[24px] border border-white/10 bg-black/28 px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs font-medium",
                      installPreview.request.kind === "skill"
                        ? "border-orange-400/25 bg-orange-500/10 text-orange-100"
                        : "border-sky-400/25 bg-sky-500/10 text-sky-100"
                    )}
                  >
                    已识别为{formatKindLabel(installPreview.request.kind)}
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-neutral-300">
                    {installPreview.request.sourceLabel}
                  </span>
                </div>
                <p className="mt-3 text-sm leading-7 text-neutral-200">
                  <span className="font-medium text-white">{installPreview.request.label}</span>
                  <span className="text-neutral-400"> · {installPreview.request.summary}</span>
                </p>
              </div>
            ) : installPreview.error ? (
              <div className="mt-4 rounded-[24px] border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {installPreview.error}
              </div>
            ) : (
              <p className="mt-4 text-sm leading-7 text-neutral-400">
                如果你已经在商店里看中某个技能，直接复制当前技能详情页的链接回来粘贴即可。
              </p>
            )}

            {installProgress ? (
              <div className="mt-4 rounded-[24px] border border-white/10 bg-black/28 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white">{installProgress.stage}</p>
                    <p className="mt-1 text-xs text-neutral-400">
                      {installProgress.slug ? `技能：${installProgress.slug}` : "技能安装处理中"}
                    </p>
                  </div>
                  <span className="text-sm font-medium text-orange-100">
                    {Math.round(installProgress.progress)}%
                  </span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-orange-500 via-amber-400 to-yellow-300 transition-all duration-300"
                    style={{ width: `${Math.max(4, installProgress.progress)}%` }}
                  />
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex min-h-[760px] flex-1 flex-col overflow-hidden rounded-[36px] border border-black/10 bg-[radial-gradient(circle_at_top_right,rgba(255,197,136,0.35),transparent_24%),linear-gradient(180deg,rgba(247,238,226,0.98),rgba(233,223,208,0.98))] p-3 shadow-[0_30px_120px_-64px_rgba(249,115,22,0.55)] md:p-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-black/10 bg-white/75 px-4 py-3 backdrop-blur">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-neutral-800">ClawHub 官方商店</p>
                <p className="mt-1 text-xs text-neutral-500">
                  商店里看到喜欢的技能后，复制当前页面链接回来安装。
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="border-black/10 bg-white/70 text-neutral-800 hover:bg-white"
                  onClick={reloadStore}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  重新载入
                </Button>
                <Button
                  variant="outline"
                  className="border-black/10 bg-white/70 text-neutral-800 hover:bg-white"
                  onClick={openStoreExternally}
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  外部打开
                </Button>
              </div>
            </div>

            <div className="relative mt-3 min-h-0 flex-1 overflow-hidden rounded-[28px] border border-black/10 bg-white shadow-[0_30px_80px_-52px_rgba(15,23,42,0.28)]">
              <iframe
                key={iframeKey}
                title="ClawHub Discover"
                src={CLAWHUB_STORE_URL}
                loading="eager"
                allow="clipboard-read; clipboard-write"
                referrerPolicy="strict-origin-when-cross-origin"
                onLoad={() => setIframeState("ready")}
                className="h-full w-full border-0 bg-white"
              />

              {iframeState !== "ready" ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.62),rgba(247,238,226,0.95))]">
                  <div className="rounded-full border border-black/10 bg-white/90 px-4 py-2 text-sm text-neutral-700 shadow-lg backdrop-blur">
                    <span className="inline-flex items-center gap-2">
                      <LoaderCircle className="h-4 w-4 animate-spin text-orange-500" />
                      正在打开 ClawHub 商店...
                    </span>
                  </div>
                </div>
              ) : null}

              {iframeState === "slow" ? (
                <div className="pointer-events-none absolute inset-x-4 bottom-4 flex justify-center">
                  <div className="rounded-full border border-black/10 bg-white/90 px-4 py-2 text-xs text-neutral-700 shadow-lg backdrop-blur">
                    如果页面暂时空白，可以试试“重新载入”或“外部打开”。
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="installed" className="mt-0 flex min-h-0 flex-1 flex-col gap-4">
          <div className="rounded-[28px] border border-neutral-800 bg-[linear-gradient(180deg,rgba(26,26,30,0.98),rgba(16,16,18,0.98))] px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-neutral-100">我的已安装内容</h3>
                <p className="mt-1 text-sm leading-6 text-neutral-400">
                  这里只展示你后来安装的技能和插件，不会把系统自带依赖混进来。
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className="rounded-full border border-orange-500/20 bg-orange-500/10 px-3 py-1 text-xs text-orange-100">
                    {stats.skills} 个技能
                  </span>
                  <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-3 py-1 text-xs text-sky-100">
                    {stats.plugins} 个插件
                  </span>
                  {hiddenSystemCount > 0 ? (
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-400">
                      已自动隐藏 {hiddenSystemCount} 个系统组件
                    </span>
                  ) : null}
                  {installedClawHubSkillCount > 0 ? (
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-300">
                      {installedClawHubSkillCount} 个技能支持在线更新
                    </span>
                  ) : null}
                  {pendingSkillUpdateCount > 0 ? (
                    <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200">
                      {pendingSkillUpdateCount} 个可更新
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="border-neutral-700 bg-neutral-950 text-neutral-100 hover:bg-neutral-900"
                  onClick={() => void handleCheckSkillUpdates()}
                  disabled={installedClawHubSkillCount === 0 || Boolean(activeAction)}
                >
                  <Sparkles
                    className={cn(
                      "mr-2 h-4 w-4",
                      activeAction === "check-updates" ? "animate-pulse" : ""
                    )}
                  />
                  检查更新
                </Button>
                <Button
                  variant="outline"
                  className="border-neutral-700 bg-neutral-950 text-neutral-100 hover:bg-neutral-900"
                  onClick={() => void refreshInstalledItems({ showSuccess: true })}
                  disabled={isRefreshing || Boolean(activeAction)}
                >
                  <RefreshCw
                    className={cn("mr-2 h-4 w-4", isRefreshing ? "animate-spin" : "")}
                  />
                  刷新列表
                </Button>
              </div>
            </div>
          </div>

          {installProgress ? (
            <div className="rounded-[24px] border border-white/10 bg-neutral-950/70 px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white">{installProgress.stage}</p>
                  <p className="mt-1 text-xs text-neutral-400">
                    {installProgress.slug ? `技能：${installProgress.slug}` : "技能处理中"}
                  </p>
                </div>
                <span className="text-sm font-medium text-orange-100">
                  {Math.round(installProgress.progress)}%
                </span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-orange-500 via-amber-400 to-yellow-300 transition-all duration-300"
                  style={{ width: `${Math.max(4, installProgress.progress)}%` }}
                />
              </div>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {isRefreshing && installedItems.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-[24px] border border-dashed border-neutral-800 bg-neutral-900/55">
                <div className="inline-flex items-center gap-2 text-sm text-neutral-300">
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  正在读取本地安装内容...
                </div>
              </div>
            ) : installedItems.length === 0 ? (
              <div className="rounded-[30px] border border-dashed border-neutral-800 bg-[radial-gradient(circle_at_top,rgba(249,115,22,0.12),transparent_26%),rgba(17,17,20,0.92)] px-8 py-14 text-center">
                <p className="text-base font-semibold text-neutral-100">还没有已安装内容</p>
                <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-neutral-400">
                  去“发现技能”里浏览商店，复制技能详情页链接或技能名回来安装。安装成功后，这里可以直接启用、停用和卸载。
                </p>
              </div>
            ) : (
              <div className="grid gap-4 xl:grid-cols-2">
                {installedItems.map((item) => {
                  const toggleActionKey = `toggle:${item.kind}:${item.id}`;
                  const updateActionKey = `update:skill:${item.id}`;
                  const uninstallActionKey = `uninstall:${item.kind}:${item.id}`;
                  const isToggling = activeAction === toggleActionKey;
                  const isUpdating = activeAction === updateActionKey;
                  const isUninstalling = activeAction === uninstallActionKey;
                  const isBusy = Boolean(activeAction);
                  const canUpdate =
                    item.kind === "skill" &&
                    item.updateState === "available" &&
                    Boolean(item.clawhubSlug?.trim());

                  return (
                    <article
                      key={`${item.kind}:${item.id}`}
                      className="rounded-[28px] border border-neutral-800 bg-[linear-gradient(180deg,rgba(24,24,28,0.98),rgba(14,14,17,0.98))] p-5 shadow-[0_22px_80px_-52px_rgba(249,115,22,0.45)]"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start gap-3">
                            <span
                              className={cn(
                                "flex h-11 w-11 items-center justify-center rounded-2xl border",
                                item.kind === "plugin"
                                  ? "border-sky-400/20 bg-sky-500/10 text-sky-200"
                                  : "border-orange-400/20 bg-orange-500/12 text-orange-200"
                              )}
                            >
                              {item.kind === "plugin" ? (
                                <Sparkles className="h-4.5 w-4.5" />
                              ) : (
                                <Puzzle className="h-4.5 w-4.5" />
                              )}
                            </span>

                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <h4 className="truncate text-base font-semibold text-neutral-100">
                                  {item.name}
                                </h4>
                                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-neutral-300">
                                  {formatKindLabel(item.kind)}
                                </span>
                                {item.kind === "skill" && item.installedVersion ? (
                                  <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-neutral-300">
                                    v{item.installedVersion}
                                  </span>
                                ) : null}
                                <span
                                  className={cn(
                                    "rounded-full border px-2.5 py-1 text-xs font-medium",
                                    item.enabled
                                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                      : "border-neutral-700 bg-neutral-800 text-neutral-400"
                                  )}
                                >
                                  {item.enabled ? "已启用" : "已停用"}
                                </span>
                                {item.needsAttention ? (
                                  <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-200">
                                    需补充依赖
                                  </span>
                                ) : null}
                                {item.kind === "skill" && item.updateState === "available" ? (
                                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-200">
                                    可更新到 v{item.latestVersion}
                                  </span>
                                ) : null}
                                {item.kind === "skill" && item.updateState === "latest" ? (
                                  <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-neutral-400">
                                    已是最新
                                  </span>
                                ) : null}
                                {item.kind === "skill" && item.updateState === "checking" ? (
                                  <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-xs text-sky-200">
                                    检查中
                                  </span>
                                ) : null}
                                {item.kind === "skill" && item.updateState === "error" ? (
                                  <span className="rounded-full border border-red-500/25 bg-red-500/10 px-2.5 py-1 text-xs text-red-200">
                                    更新检查失败
                                  </span>
                                ) : null}
                              </div>

                              <p className="mt-3 text-sm leading-7 text-neutral-400">
                                {item.description?.trim() || "暂无说明。"}
                              </p>
                              {item.kind === "skill" && item.updateMessage?.trim() ? (
                                <p className="mt-2 text-xs leading-6 text-neutral-500">
                                  {item.updateMessage}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/6 pt-4">
                        <div className="flex flex-wrap items-center gap-3">
                          {canUpdate ? (
                            <Button
                              variant="outline"
                              className="border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 hover:text-emerald-100"
                              onClick={() => void handleUpdateSkill(item)}
                              disabled={isBusy}
                            >
                              {isUpdating ? (
                                <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <Sparkles className="mr-2 h-4 w-4" />
                              )}
                              更新
                            </Button>
                          ) : null}

                          <div className="flex items-center gap-3">
                            <span className="text-xs font-medium uppercase tracking-[0.18em] text-neutral-500">
                              启用
                            </span>

                            <SkillSwitch
                              checked={item.enabled}
                              disabled={isBusy}
                              onChange={(next) => void handleToggleItem(item, next)}
                            />

                            {isToggling ? (
                              <span className="inline-flex items-center gap-1 text-xs text-neutral-400">
                                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                                更新中
                              </span>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            className="border-red-500/30 bg-transparent text-red-300 hover:bg-red-500/10 hover:text-red-200"
                            onClick={() => void handleUninstallItem(item)}
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
            "rounded-[20px] border px-4 py-3 text-sm",
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
