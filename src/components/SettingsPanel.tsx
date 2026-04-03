import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, RotateCcw, Save } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  PROVIDERS,
  getDefaultModelForProvider,
  getProviderBaseUrl,
  getProviderModels,
  resolveBaseUrl,
} from "@/lib/models";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";

type SettingsTab = "model" | "network" | "memory" | "advanced";
type LogLevel = "info" | "debug" | "error";

const DEFAULT_GATEWAY_PORT = 18789;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_HISTORY_LIMIT = 10;

export function SettingsPanel() {
  const { openclaw, settings, setOpenClawConfig } = useAppStore();

  const [activeTab, setActiveTab] = useState<SettingsTab>("model");
  const [provider, setProvider] = useState(openclaw.provider ?? DEFAULT_PROVIDER);
  const [model, setModel] = useState(openclaw.model ?? DEFAULT_MODEL);
  const [apiKey, setApiKey] = useState(openclaw.apiKey ?? "");
  const [baseUrl, setBaseUrl] = useState(
    resolveBaseUrl(openclaw.provider ?? DEFAULT_PROVIDER, openclaw.baseUrl)
  );
  const [systemPrompt, setSystemPrompt] = useState(openclaw.systemPrompt ?? "");
  const [temperature, setTemperature] = useState(openclaw.temperature ?? 1);
  const [maxTokens, setMaxTokens] = useState(openclaw.maxTokens ?? DEFAULT_MAX_TOKENS);
  const [httpProxy, setHttpProxy] = useState(openclaw.httpProxy ?? "");
  const [socks5Proxy, setSocks5Proxy] = useState(openclaw.socks5Proxy ?? "");
  const [gatewayPort, setGatewayPort] = useState(
    openclaw.gatewayPort ?? DEFAULT_GATEWAY_PORT
  );
  const [gatewayToken, setGatewayToken] = useState(openclaw.gatewayToken ?? "");
  const [logLevel, setLogLevel] = useState<LogLevel>(openclaw.logLevel ?? "info");
  const [historyMessageLimit, setHistoryMessageLimit] = useState(
    openclaw.historyMessageLimit ?? DEFAULT_HISTORY_LIMIT
  );
  const [longTermMemoryEnabled, setLongTermMemoryEnabled] = useState(
    openclaw.longTermMemoryEnabled ?? false
  );
  const [autostartEnabled, setAutostartEnabled] = useState(
    openclaw.autostartEnabled ?? false
  );
  const [autostartWorking, setAutostartWorking] = useState(false);
  const [saveWorking, setSaveWorking] = useState(false);
  const [resetWorking, setResetWorking] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [status, setStatus] = useState("");

  const availableModels = useMemo(() => getProviderModels(provider), [provider]);

  useEffect(() => {
    const nextProvider = openclaw.provider ?? DEFAULT_PROVIDER;

    setProvider(nextProvider);
    setModel(openclaw.model ?? getDefaultModelForProvider(nextProvider));
    setApiKey(openclaw.apiKey ?? "");
    setBaseUrl(resolveBaseUrl(nextProvider, openclaw.baseUrl));
    setSystemPrompt(openclaw.systemPrompt ?? "");
    setTemperature(openclaw.temperature ?? 1);
    setMaxTokens(openclaw.maxTokens ?? DEFAULT_MAX_TOKENS);
    setHttpProxy(openclaw.httpProxy ?? "");
    setSocks5Proxy(openclaw.socks5Proxy ?? "");
    setGatewayPort(openclaw.gatewayPort ?? DEFAULT_GATEWAY_PORT);
    setGatewayToken(openclaw.gatewayToken ?? "");
    setLogLevel(openclaw.logLevel ?? "info");
    setHistoryMessageLimit(openclaw.historyMessageLimit ?? DEFAULT_HISTORY_LIMIT);
    setLongTermMemoryEnabled(openclaw.longTermMemoryEnabled ?? false);
    setAutostartEnabled(openclaw.autostartEnabled ?? false);
  }, [openclaw]);

  useEffect(() => {
    let isMounted = true;

    invoke<boolean>("get_autostart_enabled")
      .then((enabled) => {
        if (!isMounted) {
          return;
        }

        setAutostartEnabled(enabled);
        setOpenClawConfig({ autostartEnabled: enabled });
      })
      .catch(() => {
        // Ignore unsupported platforms or permission issues.
      });

    return () => {
      isMounted = false;
    };
  }, [setOpenClawConfig]);

  const save = async () => {
    const normalizedTemperature = Math.min(2, Math.max(0, Number(temperature) || 0));
    const normalizedMaxTokens = Math.max(1, Math.floor(Number(maxTokens) || 1));
    const normalizedGatewayPort = Math.min(
      65535,
      Math.max(1, Math.floor(Number(gatewayPort) || 1))
    );
    const normalizedHistoryLimit = Math.max(
      1,
      Math.floor(Number(historyMessageLimit) || 1)
    );

    const trimmedApiKey = apiKey.trim();
    const trimmedBaseUrl = resolveBaseUrl(provider, baseUrl);
    const trimmedSystemPrompt = systemPrompt.trim();
    const trimmedHttpProxy = httpProxy.trim();
    const trimmedSocks5Proxy = socks5Proxy.trim();
    const trimmedGatewayToken = gatewayToken.trim();
    const trimmedCustomName = openclaw.customName?.trim();

    const nextConfig = {
      provider,
      model,
      apiKey: trimmedApiKey,
      baseUrl: trimmedBaseUrl,
      systemPrompt: trimmedSystemPrompt,
      temperature: normalizedTemperature,
      maxTokens: normalizedMaxTokens,
      httpProxy: trimmedHttpProxy,
      socks5Proxy: trimmedSocks5Proxy,
      gatewayPort: normalizedGatewayPort,
      gatewayToken: trimmedGatewayToken,
      logLevel,
      historyMessageLimit: normalizedHistoryLimit,
      longTermMemoryEnabled,
      autostartEnabled,
    } as const;

    setSaveWorking(true);

    try {
      let timeoutId: number | undefined;

      try {
        await Promise.race([
          invoke<string>("update_openclaw_config", {
            payload: {
              provider,
              model,
              defaultModel: model,
              apiKey: trimmedApiKey,
              baseUrl: trimmedBaseUrl,
              systemPrompt: trimmedSystemPrompt,
              temperature: normalizedTemperature,
              maxTokens: normalizedMaxTokens,
              httpProxy: trimmedHttpProxy,
              socks5Proxy: trimmedSocks5Proxy,
              gatewayPort: normalizedGatewayPort,
              gatewayToken: trimmedGatewayToken,
              logLevel,
              historyMessageLimit: normalizedHistoryLimit,
              longTermMemoryEnabled,
              autostartEnabled,
              customName: trimmedCustomName,
              theme: settings.theme,
            },
          }),
          new Promise<never>((_, reject) => {
            timeoutId = window.setTimeout(() => {
              reject(new Error("保存超时（10s），请重试"));
            }, 10000);
          }),
        ]);
      } finally {
        if (timeoutId !== undefined) {
          window.clearTimeout(timeoutId);
        }
      }

      setOpenClawConfig(nextConfig);
      setStatus(
        "设置已保存：底层配置写入 ~/.openclaw/openclaw.json，UI 偏好写入 ~/.openclaw/selfclaw-ui.json"
      );
    } catch (error) {
      setStatus(`设置保存失败：${String(error)}`);
    } finally {
      setSaveWorking(false);
    }
  };

  const toggleAutostart = async () => {
    const next = !autostartEnabled;

    setAutostartWorking(true);
    try {
      const enabled = await invoke<boolean>("set_autostart_enabled", { enabled: next });
      setAutostartEnabled(enabled);
      setOpenClawConfig({ autostartEnabled: enabled });
      setStatus(enabled ? "已开启开机自启" : "已关闭开机自启");
    } catch (error) {
      setStatus(`设置开机自启失败：${String(error)}`);
    } finally {
      setAutostartWorking(false);
    }
  };

  const confirmResetClient = async () => {
    setResetWorking(true);

    try {
      await useAppStore.persist.clearStorage();
      window.localStorage.clear();
      window.sessionStorage.clear();
      setShowResetModal(false);

      useAppStore.getState().resetAll();
      useAppStore.getState().setOpenClawConfig({
        installed: false,
        apiKey: undefined,
        baseUrl: undefined,
      });
      useAppStore.getState().setEnvChecked(false);
      useAppStore.getState().setOnboardingComplete(false);
    } catch (error) {
      setStatus(`重置失败：${String(error)}`);
      setShowResetModal(false);
    } finally {
      setResetWorking(false);
    }
  };

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-neutral-100">设置</h2>
          <p className="text-sm text-neutral-400">
            按模块管理模型、网络、记忆与系统级行为。
          </p>
        </div>

        <button
          type="button"
          onClick={() => void save()}
          disabled={saveWorking}
          className="inline-flex h-10 items-center rounded-lg bg-orange-500 px-4 text-sm font-medium text-white transition hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Save className="mr-2 h-4 w-4" />
          {saveWorking ? "保存中..." : "保存设置"}
        </button>
      </header>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SettingsTab)}>
        <TabsList className="h-auto w-full flex-wrap justify-start gap-2 rounded-xl border border-neutral-800 bg-neutral-800 p-2">
          <TabsTrigger
            value="model"
            data-active={activeTab === "model"}
            className="rounded-lg bg-neutral-900 px-3 py-2 text-sm text-neutral-300 data-[active=true]:bg-orange-500/20 data-[active=true]:text-orange-300"
          >
            大模型与路由
          </TabsTrigger>
          <TabsTrigger
            value="network"
            data-active={activeTab === "network"}
            className="rounded-lg bg-neutral-900 px-3 py-2 text-sm text-neutral-300 data-[active=true]:bg-orange-500/20 data-[active=true]:text-orange-300"
          >
            网关与网络环境
          </TabsTrigger>
          <TabsTrigger
            value="memory"
            data-active={activeTab === "memory"}
            className="rounded-lg bg-neutral-900 px-3 py-2 text-sm text-neutral-300 data-[active=true]:bg-orange-500/20 data-[active=true]:text-orange-300"
          >
            记忆与上下文
          </TabsTrigger>
          <TabsTrigger
            value="advanced"
            data-active={activeTab === "advanced"}
            className="rounded-lg bg-neutral-900 px-3 py-2 text-sm text-neutral-300 data-[active=true]:bg-orange-500/20 data-[active=true]:text-orange-300"
          >
            高级与风险操作
          </TabsTrigger>
        </TabsList>

        <TabsContent value="model" className="mt-4">
          <div className="grid gap-4 rounded-xl border border-neutral-800 bg-neutral-800 p-5 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-neutral-400">
                服务提供商
              </label>
              <select
                value={provider}
                onChange={(event) => {
                  const nextProvider = event.target.value;
                  setProvider(nextProvider);
                  setModel(getDefaultModelForProvider(nextProvider));
                  setBaseUrl(getProviderBaseUrl(nextProvider));
                }}
                className="h-10 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2"
              >
                {PROVIDERS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-neutral-400">模型</label>
              <select
                value={model}
                onChange={(event) => {
                  setModel(event.target.value);
                  setBaseUrl((current) => current.trim() || getProviderBaseUrl(provider));
                }}
                className="h-10 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2"
              >
                {availableModels.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <label className="text-xs uppercase tracking-wide text-neutral-400">API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-..."
                className="h-10 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2"
              />
            </div>

            <div className="space-y-2 sm:col-span-2">
              <label className="text-xs uppercase tracking-wide text-neutral-400">Base URL</label>
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={getProviderBaseUrl(provider)}
                className="h-10 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2"
              />
              <p className="text-xs text-neutral-500">
                切换提供商时会自动填充默认地址，仍可手动覆盖。
              </p>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <label className="text-xs uppercase tracking-wide text-neutral-400">
                全局 System Prompt
              </label>
              <textarea
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                rows={4}
                placeholder="你是一个严谨、可靠的本地网关助手..."
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-neutral-400">
                Temperature: {temperature.toFixed(1)}
              </label>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(event) => setTemperature(Number(event.target.value))}
                className="w-full accent-orange-500"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-neutral-400">
                Max Tokens
              </label>
              <input
                type="number"
                min={1}
                value={maxTokens}
                onChange={(event) => setMaxTokens(Number(event.target.value))}
                className="h-10 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2"
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="network" className="mt-4">
          <div className="grid gap-4 rounded-xl border border-neutral-800 bg-neutral-800 p-5 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <label className="text-xs uppercase tracking-wide text-neutral-400">
                HTTP 代理
              </label>
              <input
                value={httpProxy}
                onChange={(event) => setHttpProxy(event.target.value)}
                placeholder="http://127.0.0.1:7890"
                className="h-10 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2"
              />
            </div>

            <div className="space-y-2 sm:col-span-2">
              <label className="text-xs uppercase tracking-wide text-neutral-400">
                SOCKS5 代理
              </label>
              <input
                value={socks5Proxy}
                onChange={(event) => setSocks5Proxy(event.target.value)}
                placeholder="socks5://127.0.0.1:1080"
                className="h-10 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-neutral-400">
                网关本地端口
              </label>
              <input
                type="number"
                min={1}
                max={65535}
                value={gatewayPort}
                onChange={(event) => setGatewayPort(Number(event.target.value))}
                className="h-10 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-neutral-400">
                日志级别
              </label>
              <select
                value={logLevel}
                onChange={(event) => setLogLevel(event.target.value as LogLevel)}
                className="h-10 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2"
              >
                <option value="info">Info</option>
                <option value="debug">Debug</option>
                <option value="error">Error</option>
              </select>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <label className="text-xs uppercase tracking-wide text-neutral-400">
                网关认证 Token
              </label>
              <input
                type="password"
                value={gatewayToken}
                onChange={(event) => setGatewayToken(event.target.value)}
                placeholder="留空则优先使用 API Key"
                className="h-10 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2"
              />
              <p className="text-xs text-neutral-500">
                用于 WebSocket 认证，可从 ~/.openclaw/openclaw.json 的
                gateway.auth.token 获取。
              </p>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="memory" className="mt-4">
          <div className="grid gap-4 rounded-xl border border-neutral-800 bg-neutral-800 p-5">
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-neutral-400">
                历史消息携带上限
              </label>
              <input
                type="number"
                min={1}
                value={historyMessageLimit}
                onChange={(event) => setHistoryMessageLimit(Number(event.target.value))}
                className="h-10 w-full max-w-xs rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-700 bg-neutral-900 p-3">
              <div>
                <p className="text-sm font-medium text-neutral-100">长期记忆</p>
                <p className="text-xs text-neutral-400">
                  开启后会把对话写入本地向量库或 SQLite 存储。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setLongTermMemoryEnabled((previous) => !previous)}
                className={cn(
                  "inline-flex h-9 min-w-24 items-center justify-center rounded-lg px-3 text-sm font-medium transition",
                  longTermMemoryEnabled
                    ? "bg-orange-500 text-white hover:bg-orange-400"
                    : "bg-neutral-700 text-neutral-200 hover:bg-neutral-600"
                )}
              >
                {longTermMemoryEnabled ? "已开启" : "已关闭"}
              </button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="advanced" className="mt-4 space-y-4">
          <div className="rounded-xl border border-neutral-800 bg-neutral-800 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-700 bg-neutral-900 p-3">
              <div>
                <p className="text-sm font-medium text-neutral-100">开机自启</p>
                <p className="text-xs text-neutral-400">
                  系统启动后自动拉起 SelfClaw 客户端。
                </p>
              </div>
              <button
                type="button"
                onClick={() => void toggleAutostart()}
                disabled={autostartWorking}
                className={cn(
                  "inline-flex h-9 min-w-24 items-center justify-center rounded-lg px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60",
                  autostartEnabled
                    ? "bg-orange-500 text-white hover:bg-orange-400"
                    : "bg-neutral-700 text-neutral-200 hover:bg-neutral-600"
                )}
              >
                {autostartWorking
                  ? "处理中..."
                  : autostartEnabled
                    ? "已开启"
                    : "已关闭"}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-red-900/70 bg-red-950/40 p-5">
            <div className="mb-3 flex items-center gap-2 text-red-300">
              <AlertTriangle className="h-4 w-4" />
              <h3 className="font-semibold">重置 SelfClaw</h3>
            </div>
            <p className="mb-4 text-sm text-red-200/80">
              这会清除当前客户端的本地配置并恢复初始状态，不会删除底层 OpenClaw
              工作区数据。
            </p>
            <button
              type="button"
              onClick={() => setShowResetModal(true)}
              disabled={resetWorking}
              className="inline-flex h-10 items-center rounded-lg bg-red-600 px-4 text-sm font-medium text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              {resetWorking ? "重置中..." : "重置客户端"}
            </button>
          </div>
        </TabsContent>
      </Tabs>

      {status ? <p className="text-sm text-neutral-300">{status}</p> : null}

      {showResetModal ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 px-4">
          <div className="w-full max-w-md rounded-2xl border border-neutral-700 bg-neutral-900 p-5 shadow-2xl">
            <h4 className="text-lg font-semibold text-neutral-100">重置 SelfClaw</h4>
            <p className="mt-2 text-sm text-neutral-300">
              这会清除当前客户端的本地配置，不会影响底层 OpenClaw 工作区数据。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowResetModal(false)}
                disabled={resetWorking}
                className="inline-flex h-10 items-center rounded-lg border border-neutral-700 bg-neutral-800 px-4 text-sm text-neutral-200 transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmResetClient()}
                disabled={resetWorking}
                className="inline-flex h-10 items-center rounded-lg bg-orange-500 px-4 text-sm font-medium text-white transition hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {resetWorking ? "执行中..." : "确认重置"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
