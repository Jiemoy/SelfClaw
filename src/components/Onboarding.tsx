import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui";
import { PROVIDERS, PROVIDER_MODELS } from "@/lib/models";
import { isIgnorableTauriInvokeError } from "@/lib/tauriErrors";
import { type OpenClawConfig, useAppStore } from "@/store/appStore";

interface OnboardingProps {
  onComplete: () => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readStringField(
  payload: Record<string, unknown>,
  fieldNames: string[]
): string | undefined {
  for (const fieldName of fieldNames) {
    const value = payload[fieldName];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

export function Onboarding({ onComplete }: OnboardingProps) {
  const { openclaw, setOpenClawConfig } = useAppStore();

  const [provider, setProvider] = useState(openclaw.provider ?? "openai");
  const [model, setModel] = useState(openclaw.model ?? "codex-mini-latest");
  const [apiKey, setApiKey] = useState(openclaw.apiKey ?? "");
  const [baseUrl, setBaseUrl] = useState(openclaw.baseUrl ?? "");
  const [customName, setCustomName] = useState(openclaw.customName ?? "SelfClaw");
  const [detectedConfig, setDetectedConfig] = useState<Partial<OpenClawConfig> | null>(null);
  const [isDetecting, setIsDetecting] = useState(true);
  const [showSkipHint, setShowSkipHint] = useState(false);

  useEffect(() => {
    let isMounted = true;

    invoke<Record<string, unknown>>("auto_detect_openclaw_config")
      .then((payload) => {
        if (!isMounted) {
          return;
        }
        console.log("[Onboarding] 嗅探结果:", payload);

        const targetData = asRecord(payload.data) ?? asRecord(payload.config) ?? payload;
        const nextApiKey =
          readStringField(targetData, ["apiKey", "api_key", "API_KEY"]) ??
          readStringField(payload, ["apiKey", "api_key", "API_KEY"]);
        const nextBaseUrl =
          readStringField(targetData, ["baseUrl", "base_url", "BASE_URL"]) ??
          readStringField(payload, ["baseUrl", "base_url", "BASE_URL"]);
        const nextModel =
          readStringField(targetData, [
            "defaultModel",
            "default_model",
            "DEFAULT_MODEL",
            "model",
            "MODEL",
          ]) ??
          readStringField(payload, [
            "defaultModel",
            "default_model",
            "DEFAULT_MODEL",
            "model",
            "MODEL",
          ]);
        const nextProvider =
          readStringField(targetData, ["provider", "PROVIDER"]) ??
          readStringField(payload, ["provider", "PROVIDER"]);

        const hasDetectedConfig = Boolean(nextApiKey || nextBaseUrl);
        if (!hasDetectedConfig) {
          setDetectedConfig(null);
          return;
        }

        const parsedConfig: Partial<OpenClawConfig> = {
          installed: true,
          apiKey: nextApiKey,
          baseUrl: nextBaseUrl,
          model: nextModel ?? openclaw.model ?? "codex-mini-latest",
          provider: nextProvider ?? openclaw.provider ?? "openai",
        };

        setDetectedConfig(parsedConfig);
        setProvider(parsedConfig.provider ?? "openai");
        setModel(parsedConfig.model ?? "codex-mini-latest");
        setApiKey(parsedConfig.apiKey ?? "");
        setBaseUrl(parsedConfig.baseUrl ?? "");
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }

        if (!isIgnorableTauriInvokeError(error)) {
          console.error("向导嗅探本地配置失败：", error);
        }
        setDetectedConfig(null);
      })
      .finally(() => {
        if (!isMounted) {
          return;
        }
        setIsDetecting(false);
      });

    return () => {
      isMounted = false;
    };
  }, [openclaw.model, openclaw.provider]);

  const availableModels = useMemo(() => {
    return PROVIDER_MODELS[provider] ?? [];
  }, [provider]);

  const disableForm = Boolean(detectedConfig);

  const saveConfigToDisk = async (config: Partial<OpenClawConfig>) => {
    try {
      await invoke<string>("update_openclaw_config", {
        payload: {
          provider: config.provider,
          model: config.model,
          defaultModel: config.model,
          apiKey: config.apiKey ?? "",
          baseUrl: config.baseUrl ?? "",
          customName: config.customName ?? "SelfClaw",
        },
      });
    } catch (err) {
      if (!isIgnorableTauriInvokeError(err)) {
        console.error("[Onboarding] 保存配置到磁盘失败:", err);
      }
    }
  };

  const saveAndContinue = () => {
    const config: Partial<OpenClawConfig> = {
      installed: true,
      provider,
      model,
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      customName: customName.trim(),
    };
    setOpenClawConfig(config);
    void saveConfigToDisk(config);
    onComplete();
  };

  const applyDetectedConfig = () => {
    if (!detectedConfig) {
      return;
    }

    const config: Partial<OpenClawConfig> = {
      installed: true,
      provider: detectedConfig.provider ?? provider,
      model: detectedConfig.model ?? model,
      apiKey: (detectedConfig.apiKey ?? apiKey).trim(),
      baseUrl: (detectedConfig.baseUrl ?? baseUrl).trim(),
      customName: customName.trim(),
    };
    setOpenClawConfig(config);
    void saveConfigToDisk(config);
    onComplete();
  };

  const switchToManualConfig = () => {
    setDetectedConfig(null);
  };

  const handleSkipWizard = () => {
    const config: Partial<OpenClawConfig> = {
      installed: true,
      provider,
      model,
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      customName: customName.trim(),
    };
    setOpenClawConfig(config);
    void saveConfigToDisk(config);
    onComplete();
  };

  const controlClass = `h-10 w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 text-sm text-neutral-100 outline-none ring-orange-500 focus:ring-2 ${
    disableForm ? "cursor-not-allowed opacity-50" : ""
  }`;

  return (
    <div className="flex h-full items-center justify-center bg-neutral-950 px-4 text-neutral-100">
      <div className="w-full max-w-2xl rounded-2xl border border-neutral-800 bg-neutral-900 p-6 shadow-2xl">
        <h1 className="text-2xl font-semibold">欢迎使用 SelfClaw</h1>
        <p className="mt-2 text-sm text-neutral-400">
          进入控制台前，请先完成模型访问配置。
        </p>

        <div className="mt-6">
          {isDetecting ? (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-800/60 px-3 py-2 text-sm text-neutral-300">
              <LoaderCircle className="h-4 w-4 animate-spin text-orange-400" />
              正在扫描本地环境...
            </div>
          ) : null}

          {!isDetecting && detectedConfig ? (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-sm text-orange-200">
              <Sparkles className="h-4 w-4" />
              检测到本地已存在 OpenClaw 配置。
            </div>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wide text-neutral-400">
              服务提供商
            </label>
            <select
              value={provider}
              disabled={disableForm}
              onChange={(event) => {
                const nextProvider = event.target.value;
                setProvider(nextProvider);
                const defaultModel = PROVIDER_MODELS[nextProvider]?.[0]?.id;
                if (defaultModel) {
                  setModel(defaultModel);
                }
              }}
              className={controlClass}
            >
              {PROVIDERS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wide text-neutral-400">
              模型
            </label>
            <select
              value={model}
              disabled={disableForm}
              onChange={(event) => setModel(event.target.value)}
              className={controlClass}
            >
              {availableModels.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2 sm:col-span-2">
            <label className="text-xs uppercase tracking-wide text-neutral-400">
              API Key
            </label>
            <input
              type="password"
              value={apiKey}
              disabled={disableForm}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-..."
              className={controlClass}
            />
          </div>

          <div className="space-y-2 sm:col-span-2">
            <label className="text-xs uppercase tracking-wide text-neutral-400">
              Base URL（可选）
            </label>
            <input
              value={baseUrl}
              disabled={disableForm}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.openai.com/v1"
              className={controlClass}
            />
          </div>

          <div className="space-y-2 sm:col-span-2">
            <label className="text-xs uppercase tracking-wide text-neutral-400">
              助手名称
            </label>
            <input
              value={customName}
              disabled={disableForm}
              onChange={(event) => setCustomName(event.target.value)}
              placeholder="SelfClaw"
              className={controlClass}
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          {detectedConfig ? (
            <>
              <Button
                variant="outline"
                className="border-neutral-700 bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
                onClick={switchToManualConfig}
              >
                手动配置
              </Button>
              <Button
                className="bg-orange-500 text-white hover:bg-orange-400"
                onClick={applyDetectedConfig}
              >
                一键应用本地配置
              </Button>
            </>
          ) : (
            <div className="flex flex-col items-end gap-2">
              {!isDetecting ? (
                <p className="text-xs text-neutral-500">
                  ✓ 已完成本地扫描：未检测到既有配置，请手动输入。
                </p>
              ) : null}
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  className="border-neutral-600 bg-neutral-800 text-neutral-400 hover:border-neutral-500 hover:bg-neutral-700 hover:text-neutral-200"
                  onClick={handleSkipWizard}
                  disabled={isDetecting}
                >
                  我已手动安装 / 强制跳过向导
                </Button>
                <Button
                  className="bg-orange-500 text-white hover:bg-orange-400"
                  onClick={saveAndContinue}
                  disabled={isDetecting}
                >
                  {isDetecting ? "正在扫描..." : "完成设置"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
