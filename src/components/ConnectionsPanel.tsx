
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  FileText,
  LoaderCircle,
  LogIn,
  LogOut,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { Button, Input } from "@/components/ui";
import { isIgnorableTauriInvokeError } from "@/lib/tauriErrors";
import { cn } from "@/lib/utils";

type ConnectionsTab = "channels" | "nodes";
type FeedbackType = "info" | "error";
type EditorMode = "add" | "edit";

interface FeedbackState {
  type: FeedbackType;
  text: string;
}

interface CommandModalState {
  title: string;
  content: string;
  hint?: string;
}

interface ChannelRow {
  key: string;
  id: string;
  name: string;
  status?: string;
  detail?: string;
  enabled?: boolean;
  online?: boolean;
  configured?: boolean;
}

interface BasicEntry {
  key: string;
  name: string;
  status?: string;
  detail?: string;
}

const JSON_ARRAY_KEYS = ["data", "items", "list", "channels", "nodes", "devices", "rows", "result"];

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

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
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
    if (["true", "1", "yes", "enabled", "online", "active", "running"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "disabled", "offline", "inactive", "stopped"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function inferBooleanByText(text: string | undefined, truthyKeys: string[], falsyKeys: string[]) {
  if (!text) {
    return undefined;
  }

  const normalized = text.toLowerCase();
  if (falsyKeys.some((key) => normalized.includes(key))) {
    return false;
  }
  if (truthyKeys.some((key) => normalized.includes(key))) {
    return true;
  }
  return undefined;
}

function inferEnabled(text: string | undefined): boolean | undefined {
  return inferBooleanByText(text, ["enabled", "active", "running", "on"], ["disabled", "inactive", "off"]);
}

function inferOnline(text: string | undefined): boolean | undefined {
  return inferBooleanByText(
    text,
    ["online", "connected", "running", "alive"],
    ["offline", "disconnected", "down"]
  );
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

  const hasInlineName =
    asText(parsed.name) ?? asText(parsed.id) ?? asText(parsed.channel) ?? asText(parsed.node);
  if (hasInlineName) {
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

function parseChannelRowsFromText(raw: string): ChannelRow[] {
  const rows = new Map<string, ChannelRow>();
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

    const [nameColumn, statusColumn, ...rest] = columns;
    if (!nameColumn) {
      continue;
    }

    const id = nameColumn;
    const key = normalizeKey(id);
    const detail = rest.join(" ").trim() || undefined;
    const status = statusColumn?.trim();
    const statusText = [status, detail].filter(Boolean).join(" ");

    rows.set(key, {
      key,
      id,
      name: id,
      status,
      detail,
      enabled: inferEnabled(statusText),
      online: inferOnline(statusText),
      configured: inferBooleanByText(statusText, ["configured", "paired", "ready"], ["not configured"]),
    });
  }

  return Array.from(rows.values());
}

function mapRecordToChannelRow(record: Record<string, unknown>): ChannelRow | null {
  const id =
    asText(record.id) ??
    asText(record.name) ??
    asText(record.channel) ??
    asText(record.platform) ??
    asText(record.slug);
  if (!id) {
    return null;
  }

  const name = asText(record.name) ?? id;
  const status = asText(record.status) ?? asText(record.state) ?? asText(record.connection);
  const detail = asText(record.detail) ?? asText(record.description) ?? asText(record.message);
  const merged = [status, detail].filter(Boolean).join(" ");

  const enabled =
    parseBoolean(record.enabled) ??
    parseBoolean(record.active) ??
    parseBoolean(record.is_enabled) ??
    inferEnabled(merged);

  const online =
    parseBoolean(record.online) ??
    parseBoolean(record.connected) ??
    parseBoolean(record.alive) ??
    inferOnline(merged);

  const configured =
    parseBoolean(record.configured) ??
    parseBoolean(record.paired) ??
    parseBoolean(record.setup) ??
    inferBooleanByText(merged, ["configured", "paired", "ready"], ["not configured"]);

  return {
    key: normalizeKey(id),
    id,
    name,
    status,
    detail,
    enabled,
    online,
    configured,
  };
}

function parseChannelRows(raw: string): ChannelRow[] {
  const map = new Map<string, ChannelRow>();
  const jsonRecords = collectJsonRecords(raw);

  for (const record of jsonRecords) {
    const item = mapRecordToChannelRow(record);
    if (!item) {
      continue;
    }
    map.set(item.key, item);
  }

  if (map.size === 0) {
    for (const item of parseChannelRowsFromText(raw)) {
      map.set(item.key, item);
    }
  }

  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function parseBasicEntries(raw: string): BasicEntry[] {
  const fromJson = collectJsonRecords(raw);
  const map = new Map<string, BasicEntry>();

  for (const record of fromJson) {
    const name =
      asText(record.name) ??
      asText(record.id) ??
      asText(record.node) ??
      asText(record.device) ??
      asText(record.host);
    if (!name) {
      continue;
    }

    const status = asText(record.status) ?? asText(record.state) ?? asText(record.health);
    const detail =
      asText(record.detail) ??
      asText(record.description) ??
      asText(record.type) ??
      asText(record.platform);

    map.set(normalizeKey(name), {
      key: normalizeKey(name),
      name,
      status,
      detail,
    });
  }

  if (map.size > 0) {
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (/^[-=]{3,}$/.test(line)) {
      continue;
    }
    const columns = line.includes("|")
      ? line
          .split("|")
          .map((part) => part.trim())
          .filter(Boolean)
      : line.split(/\s{2,}|\t+/).map((part) => part.trim()).filter(Boolean);

    if (columns.length === 0) {
      continue;
    }

    const [name, status, ...rest] = columns;
    if (!name) {
      continue;
    }
    map.set(normalizeKey(name), {
      key: normalizeKey(name),
      name,
      status: status?.trim(),
      detail: rest.join(" ").trim() || undefined,
    });
  }

  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergeChannels(listRows: ChannelRow[], statusRows: ChannelRow[]): ChannelRow[] {
  const merged = new Map<string, ChannelRow>();

  const upsert = (row: ChannelRow) => {
    const existing = merged.get(row.key);
    if (!existing) {
      merged.set(row.key, row);
      return;
    }

    merged.set(row.key, {
      ...existing,
      ...row,
      id: row.id || existing.id,
      name: row.name || existing.name,
      status: row.status ?? existing.status,
      detail: row.detail ?? existing.detail,
      enabled: row.enabled ?? existing.enabled,
      online: row.online ?? existing.online,
      configured: row.configured ?? existing.configured,
    });
  };

  for (const row of listRows) {
    upsert(row);
  }
  for (const row of statusRows) {
    upsert(row);
  }

  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function formatOutput(result: string, fallback: string): string {
  const trimmed = result.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function isAsciiQr(output: string): boolean {
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 3) {
    return false;
  }
  return lines.some((line) => /[█▓▒▀▄]/.test(line)) || lines.filter((line) => line.length > 24).length >= 4;
}

function parseArgsInput(value: string): string[] {
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function ConnectionsPanel() {
  const [activeTab, setActiveTab] = useState<ConnectionsTab>("channels");
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [nodes, setNodes] = useState<BasicEntry[]>([]);
  const [devices, setDevices] = useState<BasicEntry[]>([]);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [isLoadingNodes, setIsLoadingNodes] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [outputModal, setOutputModal] = useState<CommandModalState | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>("add");
  const [editorName, setEditorName] = useState("");
  const [editorArgs, setEditorArgs] = useState("");

  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshChannels = useCallback(async () => {
    if (!mountedRef.current) {
      return;
    }

    setIsLoadingChannels(true);
    setFeedback(null);

    const [listResult, statusResult] = await Promise.allSettled([
      invoke<string>("channels_list"),
      invoke<string>("channels_status"),
    ]);

    if (!mountedRef.current) {
      return;
    }

    const errors: string[] = [];
    const listRows =
      listResult.status === "fulfilled"
        ? parseChannelRows(listResult.value)
        : (() => {
            if (!isIgnorableTauriInvokeError(listResult.reason)) {
              errors.push(`读取渠道列表失败：${String(listResult.reason)}`);
            }
            return [];
          })();

    const statusRows =
      statusResult.status === "fulfilled"
        ? parseChannelRows(statusResult.value)
        : (() => {
            if (!isIgnorableTauriInvokeError(statusResult.reason)) {
              errors.push(`读取渠道状态失败：${String(statusResult.reason)}`);
            }
            return [];
          })();

    setChannels(mergeChannels(listRows, statusRows));

    if (errors.length > 0) {
      setFeedback({ type: "error", text: errors.join(" | ") });
    }

    setIsLoadingChannels(false);
  }, []);

  const refreshNodes = useCallback(async () => {
    if (!mountedRef.current) {
      return;
    }

    setIsLoadingNodes(true);
    setFeedback(null);

    const [nodesResult, devicesResult] = await Promise.allSettled([
      invoke<string>("nodes_list"),
      invoke<string>("devices_list"),
    ]);

    if (!mountedRef.current) {
      return;
    }

    const errors: string[] = [];

    if (nodesResult.status === "fulfilled") {
      setNodes(parseBasicEntries(nodesResult.value));
    } else if (!isIgnorableTauriInvokeError(nodesResult.reason)) {
      errors.push(`读取节点列表失败：${String(nodesResult.reason)}`);
    }

    if (devicesResult.status === "fulfilled") {
      setDevices(parseBasicEntries(devicesResult.value));
    } else if (!isIgnorableTauriInvokeError(devicesResult.reason)) {
      errors.push(`读取设备列表失败：${String(devicesResult.reason)}`);
    }

    if (errors.length > 0) {
      setFeedback({ type: "error", text: errors.join(" | ") });
    }

    setIsLoadingNodes(false);
  }, []);

  useEffect(() => {
    void refreshChannels();
    void refreshNodes();
  }, [refreshChannels, refreshNodes]);

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

  const openAddModal = () => {
    setEditorMode("add");
    setEditorName("");
    setEditorArgs("");
    setEditorOpen(true);
  };

  const openEditModal = (row: ChannelRow) => {
    setEditorMode("edit");
    setEditorName(row.id || row.name);
    setEditorArgs("");
    setEditorOpen(true);
  };

  const submitChannelEditor = async () => {
    const name = editorName.trim();
    if (!name) {
      setFeedback({ type: "error", text: "请先填写渠道标识符" });
      return;
    }

    const args = parseArgsInput(editorArgs);
    const output = await runCommand(
      "channels_add",
      `${editorMode}:channels-add:${name}`,
      { name, args },
      editorMode === "add" ? `渠道 ${name} 已添加` : `渠道 ${name} 配置已更新`
    );

    if (!output || !mountedRef.current) {
      return;
    }

    setEditorOpen(false);
    await refreshChannels();
  };

  const handleLogin = async (row: ChannelRow) => {
    const output = await runCommand(
      "channels_login",
      `channels-login:${row.key}`,
      { name: row.id },
      `已触发 ${row.name} 登录流程`
    );
    if (!output || !mountedRef.current) {
      return;
    }

    setOutputModal({
      title: `登录输出 · ${row.name}`,
      content: output,
      hint: isAsciiQr(output)
        ? "已检测到二维码，请扫码完成登录。"
        : "未检测到二维码字符，若是图形码请查看 OpenClaw 终端日志。",
    });
    await refreshChannels();
  };

  const handleLogout = async (row: ChannelRow) => {
    const output = await runCommand(
      "channels_logout",
      `channels-logout:${row.key}`,
      { name: row.id },
      `${row.name} 已登出`
    );
    if (!output || !mountedRef.current) {
      return;
    }
    await refreshChannels();
  };

  const handleLogs = async (row: ChannelRow) => {
    const output = await runCommand(
      "channels_logs",
      `channels-logs:${row.key}`,
      { name: row.id },
      `${row.name} 日志已获取`
    );
    if (!output || !mountedRef.current) {
      return;
    }

    setOutputModal({
      title: `渠道日志 · ${row.name}`,
      content: output,
    });
  };

  const handleRemove = async (row: ChannelRow) => {
    const output = await runCommand(
      "channels_remove",
      `channels-remove:${row.key}`,
      { name: row.id },
      `${row.name} 已移除`
    );
    if (!output || !mountedRef.current) {
      return;
    }
    await refreshChannels();
  };

  const isBusy = (key: string) => activeAction === key;

  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-neutral-100">渠道与节点</h2>
          <p className="text-sm text-neutral-400">
            全量可视化管理 IM 渠道接入状态、登录链路与物理节点资产。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-800"
            onClick={() => void refreshChannels()}
            disabled={isLoadingChannels || activeAction !== null}
          >
            <RefreshCw className={cn("mr-2 h-4 w-4", isLoadingChannels ? "animate-spin" : "")} />
            刷新渠道
          </Button>
          <Button
            variant="outline"
            className="border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-800"
            onClick={() => void refreshNodes()}
            disabled={isLoadingNodes || activeAction !== null}
          >
            <RefreshCw className={cn("mr-2 h-4 w-4", isLoadingNodes ? "animate-spin" : "")} />
            刷新节点
          </Button>
        </div>
      </header>

      <div className="rounded-xl border border-neutral-800 bg-neutral-800 p-4">
        <div className="mb-4 flex items-center gap-2">
          <button
            type="button"
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm transition",
              activeTab === "channels"
                ? "bg-orange-500/20 text-orange-300"
                : "text-neutral-300 hover:bg-neutral-700"
            )}
            onClick={() => setActiveTab("channels")}
          >
            IM 渠道 (Channels)
          </button>
          <button
            type="button"
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm transition",
              activeTab === "nodes"
                ? "bg-orange-500/20 text-orange-300"
                : "text-neutral-300 hover:bg-neutral-700"
            )}
            onClick={() => setActiveTab("nodes")}
          >
            物理节点 (Nodes)
          </button>
        </div>

        {activeTab === "channels" ? (
          <div className="space-y-3">
            <div className="flex flex-wrap justify-end">
              <Button className="bg-orange-500 text-white hover:bg-orange-400" onClick={openAddModal}>
                <Plus className="mr-2 h-4 w-4" />
                添加渠道
              </Button>
            </div>

            <div className="overflow-x-auto rounded-lg border border-neutral-700">
              <table className="min-w-full border-collapse text-sm">
                <thead className="bg-neutral-900 text-xs text-neutral-400">
                  <tr>
                    <th className="px-3 py-2 text-left">渠道</th>
                    <th className="px-3 py-2 text-left">状态</th>
                    <th className="px-3 py-2 text-left">连接</th>
                    <th className="px-3 py-2 text-left">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((row) => {
                    const statusText = row.status ?? "未知";
                    const onlineText =
                      row.online === true ? "在线" : row.online === false ? "离线" : "未标注";
                    const enabledText =
                      row.enabled === true ? "已启用" : row.enabled === false ? "已禁用" : "未标注";
                    const configuredText =
                      row.configured === true
                        ? "已接入"
                        : row.configured === false
                        ? "未接入"
                        : "未标注";

                    return (
                      <tr key={row.key} className="border-t border-neutral-800">
                        <td className="px-3 py-3">
                          <div className="font-medium text-neutral-100">{row.name}</div>
                          <p className="text-xs text-neutral-500">{row.id}</p>
                        </td>
                        <td className="px-3 py-3">
                          <div className="text-neutral-200">{statusText}</div>
                          <p className="text-xs text-neutral-500">{row.detail ?? "-"}</p>
                        </td>
                        <td className="px-3 py-3">
                          <div className="text-neutral-200">{onlineText}</div>
                          <p className="text-xs text-neutral-500">
                            {enabledText} / {configuredText}
                          </p>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-800"
                              disabled={activeAction !== null}
                              onClick={() => openEditModal(row)}
                            >
                              <Pencil className="mr-1.5 h-3.5 w-3.5" />
                              配置
                            </Button>
                            <Button
                              size="sm"
                              className="bg-orange-500 text-white hover:bg-orange-400"
                              disabled={activeAction !== null}
                              onClick={() => void handleLogin(row)}
                            >
                              {isBusy(`channels-login:${row.key}`) ? (
                                <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <LogIn className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              登录
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-800"
                              disabled={activeAction !== null}
                              onClick={() => void handleLogout(row)}
                            >
                              {isBusy(`channels-logout:${row.key}`) ? (
                                <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <LogOut className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              登出
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-800"
                              disabled={activeAction !== null}
                              onClick={() => void handleLogs(row)}
                            >
                              {isBusy(`channels-logs:${row.key}`) ? (
                                <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <FileText className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              日志
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-red-500/40 bg-neutral-900 text-red-300 hover:bg-red-500/10"
                              disabled={activeAction !== null}
                              onClick={() => void handleRemove(row)}
                            >
                              {isBusy(`channels-remove:${row.key}`) ? (
                                <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              移除
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {channels.length === 0 && !isLoadingChannels ? (
              <div className="rounded-lg border border-dashed border-neutral-700 bg-neutral-900/40 p-6 text-center text-sm text-neutral-400">
                当前未解析到渠道数据，请确认 `openclaw channels list/status` 输出是否正常。
              </div>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-neutral-700 bg-neutral-900/60 p-4">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-100">
                <Network className="h-4 w-4 text-orange-300" />
                节点列表 (`openclaw nodes`)
              </h3>
              <div className="max-h-[420px] space-y-2 overflow-y-auto">
                {nodes.length > 0 ? (
                  nodes.map((entry) => (
                    <div key={entry.key} className="rounded-lg border border-neutral-700 bg-neutral-900 p-3">
                      <p className="text-sm font-medium text-neutral-100">{entry.name}</p>
                      <p className="text-xs text-neutral-400">{entry.status ?? "状态未提供"}</p>
                      {entry.detail ? <p className="text-xs text-neutral-500">{entry.detail}</p> : null}
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-neutral-500">暂无节点数据。</p>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-neutral-700 bg-neutral-900/60 p-4">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-100">
                <Server className="h-4 w-4 text-orange-300" />
                设备列表 (`openclaw devices`)
              </h3>
              <div className="max-h-[420px] space-y-2 overflow-y-auto">
                {devices.length > 0 ? (
                  devices.map((entry) => (
                    <div key={entry.key} className="rounded-lg border border-neutral-700 bg-neutral-900 p-3">
                      <p className="text-sm font-medium text-neutral-100">{entry.name}</p>
                      <p className="text-xs text-neutral-400">{entry.status ?? "状态未提供"}</p>
                      {entry.detail ? <p className="text-xs text-neutral-500">{entry.detail}</p> : null}
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-neutral-500">暂无设备数据。</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {feedback ? (
        <p className={cn("text-sm", feedback.type === "error" ? "text-red-400" : "text-neutral-300")}>
          {feedback.text}
        </p>
      ) : null}

      {editorOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
          <div className="w-full max-w-lg rounded-xl border border-neutral-700 bg-neutral-900 shadow-xl">
            <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
              <h3 className="text-sm font-semibold text-neutral-100">
                {editorMode === "add" ? "添加渠道配置" : "编辑渠道配置"}
              </h3>
              <button
                type="button"
                className="rounded-md p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                onClick={() => setEditorOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 p-4">
              <div>
                <label htmlFor="channel-name" className="mb-1 block text-xs text-neutral-400">
                  渠道标识符
                </label>
                <Input
                  id="channel-name"
                  value={editorName}
                  onChange={(event) => setEditorName(event.target.value)}
                  placeholder="例如: whatsapp / telegram / discord / feishu"
                  className="border-neutral-700 bg-neutral-900 text-neutral-100 placeholder:text-neutral-500"
                />
              </div>
              <div>
                <label htmlFor="channel-args" className="mb-1 block text-xs text-neutral-400">
                  额外参数（可选，空格分隔）
                </label>
                <Input
                  id="channel-args"
                  value={editorArgs}
                  onChange={(event) => setEditorArgs(event.target.value)}
                  placeholder="例如: --token xxx --webhook yyy"
                  className="border-neutral-700 bg-neutral-900 text-neutral-100 placeholder:text-neutral-500"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  className="border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-800"
                  onClick={() => setEditorOpen(false)}
                >
                  取消
                </Button>
                <Button
                  className="bg-orange-500 text-white hover:bg-orange-400"
                  onClick={() => void submitChannelEditor()}
                  disabled={activeAction !== null}
                >
                  {isBusy(`${editorMode}:channels-add:${editorName.trim()}`) ? (
                    <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-2 h-4 w-4" />
                  )}
                  {editorMode === "add" ? "添加渠道" : "保存配置"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {outputModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
          <div className="w-full max-w-3xl rounded-xl border border-neutral-700 bg-neutral-900 shadow-xl">
            <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
              <h3 className="text-sm font-semibold text-neutral-100">{outputModal.title}</h3>
              <button
                type="button"
                className="rounded-md p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                onClick={() => setOutputModal(null)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-2 p-4">
              {outputModal.hint ? <p className="text-xs text-orange-300">{outputModal.hint}</p> : null}
              <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-neutral-800 bg-black p-3 font-mono text-xs text-green-400">
                {outputModal.content}
              </pre>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
