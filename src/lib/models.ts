export interface ProviderOption {
  id: string;
  name: string;
  baseUrl: string;
}

export interface ProviderModelOption {
  id: string;
  name: string;
}

export const DEFAULT_PROVIDER = "openai";
export const DEFAULT_MODEL = "codex-mini-latest";

export const PROVIDERS: ProviderOption[] = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "moonshot", name: "Moonshot（Kimi）", baseUrl: "https://api.moonshot.cn/v1" },
  {
    id: "anthropic",
    name: "Anthropic（Claude）",
    baseUrl: "https://api.anthropic.com/v1",
  },
  {
    id: "google",
    name: "Google（Gemini）",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  {
    id: "qwen",
    name: "通义千问（Qwen）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "zai",
    name: "智谱（Z.AI）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
];

export const PROVIDER_MODELS: Record<string, ProviderModelOption[]> = {
  openai: [
    { id: "codex-mini-latest", name: "codex-mini-latest" },
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o mini" },
  ],
  moonshot: [
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "kimi-k2", name: "Kimi K2" },
  ],
  anthropic: [
    { id: "claude-3-5-sonnet-latest", name: "Claude 3.5 Sonnet" },
    { id: "claude-3-7-sonnet-latest", name: "Claude 3.7 Sonnet" },
  ],
  google: [
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
    { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro" },
  ],
  deepseek: [
    { id: "deepseek-chat", name: "DeepSeek Chat" },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
  ],
  qwen: [
    { id: "qwen-max", name: "Qwen Max" },
    { id: "qwen-plus", name: "Qwen Plus" },
  ],
  zai: [
    { id: "glm-5", name: "GLM-5" },
    { id: "glm-4.7", name: "GLM-4.7" },
  ],
};

export function getProviderBaseUrl(provider?: string): string {
  return (
    PROVIDERS.find((item) => item.id === provider)?.baseUrl ??
    PROVIDERS.find((item) => item.id === DEFAULT_PROVIDER)?.baseUrl ??
    "https://api.openai.com/v1"
  );
}

export function getProviderModels(provider?: string): ProviderModelOption[] {
  return PROVIDER_MODELS[provider ?? DEFAULT_PROVIDER] ?? PROVIDER_MODELS[DEFAULT_PROVIDER] ?? [];
}

export function getDefaultModelForProvider(provider?: string): string {
  return getProviderModels(provider)[0]?.id ?? DEFAULT_MODEL;
}

export function resolveBaseUrl(provider?: string, baseUrl?: string): string {
  const trimmedBaseUrl = baseUrl?.trim();
  return trimmedBaseUrl || getProviderBaseUrl(provider);
}
