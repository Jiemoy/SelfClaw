import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, getProviderBaseUrl } from "@/lib/models";
import { indexedDbStorage } from "@/store/indexedDbStorage";

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  files?: string[];
  tokenUsage?: number;
}

export interface Session {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface OpenClawConfig {
  installed: boolean;
  version?: string;
  workDir?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  defaultModel?: string;
  customName?: string;
  provider?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  httpProxy?: string;
  socks5Proxy?: string;
  gatewayPort?: number;
  logLevel?: "info" | "debug" | "error";
  historyMessageLimit?: number;
  longTermMemoryEnabled?: boolean;
  autostartEnabled?: boolean;
  gatewayToken?: string;
}

// 默认配置
const DEFAULT_OPENCLAW_CONFIG: OpenClawConfig = {
  installed: false,
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
  defaultModel: DEFAULT_MODEL,
  baseUrl: getProviderBaseUrl(DEFAULT_PROVIDER),
  systemPrompt: "",
  temperature: 1,
  maxTokens: 4096,
  httpProxy: "",
  socks5Proxy: "",
  gatewayPort: 18789,
  logLevel: "info",
  historyMessageLimit: 10,
  longTermMemoryEnabled: false,
  autostartEnabled: false,
};

export interface AppSettings {
  theme: "light" | "dark" | "system";
  language: string;
  checkUpdates?: boolean;
  globalShortcut?: string;
}

export type GatewayRuntimeStatus = "offline" | "running" | "starting" | "stopping";

interface AppState {
  openclaw: OpenClawConfig;
  detectedConfig: Partial<OpenClawConfig> | null;
  sessions: Session[];
  currentSessionId: string | null;
  settings: AppSettings;
  envChecked: boolean;
  onboardingComplete: boolean;
  isGatewayRunning: boolean;
  gatewayStatus: GatewayRuntimeStatus;
  gatewayLogs: string[];
  
  setOpenClawConfig: (config: Partial<OpenClawConfig>) => void;
  setDetectedConfig: (config: Partial<OpenClawConfig> | null) => void;
  addSession: (session: Session) => void;
  mergeSessions: (incomingSessions: Session[]) => void;
  updateSession: (id: string, updates: Partial<Session>) => void;
  deleteSession: (id: string) => void;
  setCurrentSession: (id: string | null) => void;
  addMessage: (sessionId: string, message: Message) => void;
  updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => void;
  updateSettings: (settings: Partial<AppSettings>) => void;
  setEnvChecked: (val: boolean) => void;
  completeOnboarding: () => void;
  setOnboardingComplete: (completed: boolean) => void;
  setGatewayRunning: (status: boolean) => void;
  setGatewayStatus: (status: GatewayRuntimeStatus) => void;
  appendGatewayLog: (line: string) => void;
  clearGatewayLogs: () => void;
  resetAll: () => void;
  reset: () => void;
}

const initialState = {
  openclaw: DEFAULT_OPENCLAW_CONFIG,
  detectedConfig: null,
  sessions: [],
  currentSessionId: null,
  settings: {
    theme: "system" as const,
    language: "zh-CN",
  },
  envChecked: false,
  onboardingComplete: false,
  isGatewayRunning: false,
  gatewayStatus: "offline" as GatewayRuntimeStatus,
  gatewayLogs: [],
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      ...initialState,

      setOpenClawConfig: (config) =>
        set((state) => {
          const normalizedConfig: Partial<OpenClawConfig> = { ...config };
          if (normalizedConfig.model && !normalizedConfig.defaultModel) {
            normalizedConfig.defaultModel = normalizedConfig.model;
          }
          if (normalizedConfig.defaultModel && !normalizedConfig.model) {
            normalizedConfig.model = normalizedConfig.defaultModel;
          }

          return {
            openclaw: { ...state.openclaw, ...normalizedConfig },
          };
        }),

      setDetectedConfig: (config) =>
        set({ detectedConfig: config }),

      addSession: (session) =>
        set((state) => ({
          sessions: [session, ...state.sessions],
          currentSessionId: session.id,
        })),

      mergeSessions: (incomingSessions) =>
        set((state) => {
          if (incomingSessions.length === 0) {
            return {};
          }

          const sessionsById = new Map<string, Session>(
            state.sessions.map((session) => [session.id, session])
          );

          for (const incoming of incomingSessions) {
            const existing = sessionsById.get(incoming.id);
            if (!existing || incoming.updatedAt > existing.updatedAt) {
              sessionsById.set(incoming.id, incoming);
            }
          }

          const mergedSessions = Array.from(sessionsById.values()).sort(
            (a, b) => b.updatedAt - a.updatedAt
          );

          const currentSessionId =
            state.currentSessionId && sessionsById.has(state.currentSessionId)
              ? state.currentSessionId
              : mergedSessions[0]?.id ?? null;

          return {
            sessions: mergedSessions,
            currentSessionId,
          };
        }),

      updateSession: (id, updates) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id ? { ...s, ...updates, updatedAt: Date.now() } : s
          ),
        })),

      deleteSession: (id) =>
        set((state) => ({
          sessions: state.sessions.filter((s) => s.id !== id),
          currentSessionId:
            state.currentSessionId === id ? null : state.currentSessionId,
        })),

      setCurrentSession: (id) =>
        set({ currentSessionId: id }),

      addMessage: (sessionId, message) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  messages: [...s.messages, message],
                  updatedAt: Date.now(),
                  title: s.messages.length === 0 && message.role === "user" 
                    ? message.content.slice(0, 30) + (message.content.length > 30 ? "..." : "")
                    : s.title,
                }
              : s
          ),
        })),

      updateMessage: (sessionId, messageId, updates) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  messages: s.messages.map((msg) =>
                    msg.id === messageId ? { ...msg, ...updates } : msg
                  ),
                  updatedAt: Date.now(),
                }
              : s
          ),
        })),

      updateSettings: (newSettings) =>
        set((state) => ({
          settings: { ...state.settings, ...newSettings },
        })),

      setEnvChecked: (val) =>
        set({ envChecked: val }),

      completeOnboarding: () =>
        set({ onboardingComplete: true }),

      setOnboardingComplete: (completed) =>
        set({ onboardingComplete: completed }),

      setGatewayRunning: (status) =>
        set({
          isGatewayRunning: status,
          gatewayStatus: status ? "running" : "offline",
        }),

      setGatewayStatus: (status) =>
        set({
          gatewayStatus: status,
          isGatewayRunning: status === "running",
        }),

      appendGatewayLog: (line) =>
        set((state) => {
          const normalized = line.replace(/\r\n/g, "\n");
          const lines = normalized
            .split("\n")
            .map((entry) => entry.trimEnd())
            .filter((entry) => entry.length > 0);

          if (lines.length === 0) {
            return {};
          }

          return {
            gatewayLogs: [...state.gatewayLogs, ...lines].slice(-500),
          };
        }),

      clearGatewayLogs: () => set({ gatewayLogs: [] }),

      resetAll: () => set(initialState),

      reset: () => set(initialState),
    }),
    {
      name: "selfclaw-storage-v2",
      storage: createJSONStorage(() => indexedDbStorage),
      version: 7,
      migrate: (persistedState: unknown) => {
        if (!persistedState || typeof persistedState !== "object") {
          return persistedState;
        }

        const state = persistedState as {
          openclaw?: Partial<OpenClawConfig>;
          onboardingComplete?: boolean;
          isOnboardingComplete?: boolean;
          envChecked?: boolean;
          hasCompletedEnvCheck?: boolean;
          gatewayStatus?: GatewayRuntimeStatus;
          gatewayLogs?: string[];
          isGatewayRunning?: boolean;
        };
        if (state.openclaw && typeof state.openclaw === "object") {
          delete state.openclaw.apiKey;
          state.openclaw = { ...DEFAULT_OPENCLAW_CONFIG, ...state.openclaw };
          state.openclaw.baseUrl =
            typeof state.openclaw.baseUrl === "string" && state.openclaw.baseUrl.trim()
              ? state.openclaw.baseUrl.trim()
              : getProviderBaseUrl(state.openclaw.provider);
          if (
            typeof state.openclaw.gatewayPort !== "number" ||
            !Number.isFinite(state.openclaw.gatewayPort) ||
            state.openclaw.gatewayPort <= 0 ||
            state.openclaw.gatewayPort === 8000
          ) {
            state.openclaw.gatewayPort = 18789;
          }
          if (!state.openclaw.model && state.openclaw.defaultModel) {
            state.openclaw.model = state.openclaw.defaultModel;
          }
          if (!state.openclaw.defaultModel && state.openclaw.model) {
            state.openclaw.defaultModel = state.openclaw.model;
          }
        }

        if (typeof state.onboardingComplete !== "boolean") {
          state.onboardingComplete = Boolean(state.isOnboardingComplete);
        }
        delete state.isOnboardingComplete;

        if (typeof state.envChecked !== "boolean") {
          state.envChecked = Boolean(state.hasCompletedEnvCheck);
        }
        delete state.hasCompletedEnvCheck;

        if (
          state.gatewayStatus !== "offline" &&
          state.gatewayStatus !== "running" &&
          state.gatewayStatus !== "starting" &&
          state.gatewayStatus !== "stopping"
        ) {
          state.gatewayStatus = state.isGatewayRunning ? "running" : "offline";
        }

        if (!Array.isArray(state.gatewayLogs)) {
          state.gatewayLogs = [];
        } else {
          state.gatewayLogs = state.gatewayLogs
            .filter((line) => typeof line === "string")
            .slice(-500);
        }

        return state;
      },
      partialize: (state) => {
        const { apiKey: _apiKey, ...safeOpenClaw } = state.openclaw;
        return {
          openclaw: safeOpenClaw,
          sessions: state.sessions,
          currentSessionId: state.currentSessionId,
          settings: state.settings,
          envChecked: state.envChecked,
          onboardingComplete: state.onboardingComplete,
          isGatewayRunning: state.isGatewayRunning,
          gatewayStatus: state.gatewayStatus,
          gatewayLogs: state.gatewayLogs,
        };
      },
    }
  )
);
