export const PROVIDERS = [
  { id: "openai", name: "OpenAI" },
  { id: "moonshot", name: "Moonshot（Kimi）" },
  { id: "anthropic", name: "Anthropic（Claude）" },
  { id: "google", name: "Google（Gemini）" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "qwen", name: "通义千问（Qwen）" },
  { id: "zai", name: "智谱（Z.AI）" },
];

export const PROVIDER_MODELS: Record<string, { id: string; name: string }[]> = {
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
