import { readTextFile, exists, readDir } from "@tauri-apps/plugin-fs";

// 扩展 Window 接口以包含 __TAURI__ 属性
declare global {
  interface Window {
    __TAURI__?: unknown;
  }
}

// 检查是否在 Tauri 环境中运行
const isTauri = typeof window !== 'undefined' && window.__TAURI__;

interface SoulConfig {
  name: string;
  personality: string;
  traits: string[];
}

interface UserConfig {
  name: string;
  preferences: Record<string, string>;
  honorifics: {
    user: string;
    assistant: string;
  };
}

interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  files?: string[];
}

interface Session {
  id: string;
  title: string;
  messages: SessionMessage[];
  createdAt: number;
  updatedAt: number;
}

interface RawSessionMessage {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  files?: unknown;
}

interface RawSessionData {
  id?: unknown;
  title?: unknown;
  messages?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export async function readOpenClawConfig(workDir: string): Promise<{ soul?: SoulConfig; user?: UserConfig }> {
  try {
    if (!isTauri) {
      return {};
    }
    
    const soulPath = `${workDir}/SOUL.md`;
    const userPath = `${workDir}/USER.md`;
    
    const config: { soul?: SoulConfig; user?: UserConfig } = {};
    
    // 读取 SOUL.md
    if (await exists(soulPath)) {
      const soulContent = await readTextFile(soulPath);
      config.soul = parseSoulConfig(soulContent);
    }
    
    // 读取 USER.md
    if (await exists(userPath)) {
      const userContent = await readTextFile(userPath);
      config.user = parseUserConfig(userContent);
    }
    
    return config;
  } catch (error) {
    console.error('读取 OpenClaw 配置失败:', error);
    return {};
  }
}

function parseSoulConfig(content: string): SoulConfig {
  const lines = content.split('\n');
  const config: SoulConfig = {
    name: "SelfClaw",
    personality: "",
    traits: []
  };
  
  let inPersonality = false;
  let inTraits = false;
  
  for (const line of lines) {
    if (line.startsWith('# ')) {
      continue;
    }
    
    if (line.startsWith('name:')) {
      config.name = line.replace('name:', '').trim();
    } else if (line.startsWith('personality:')) {
      inPersonality = true;
      inTraits = false;
      config.personality = line.replace('personality:', '').trim();
    } else if (line.startsWith('traits:')) {
      inPersonality = false;
      inTraits = true;
    } else if (inPersonality) {
      config.personality += ' ' + line.trim();
    } else if (inTraits && line.trim()) {
      if (line.startsWith('- ')) {
        config.traits.push(line.replace('- ', '').trim());
      }
    }
  }
  
  return config;
}

function parseUserConfig(content: string): UserConfig {
  const lines = content.split('\n');
  const config: UserConfig = {
    name: "用户",
    preferences: {},
    honorifics: {
      user: "你",
      assistant: "我"
    }
  };
  
  let inPreferences = false;
  let inHonorifics = false;
  
  for (const line of lines) {
    if (line.startsWith('# ')) {
      continue;
    }
    
    if (line.startsWith('name:')) {
      config.name = line.replace('name:', '').trim();
    } else if (line.startsWith('preferences:')) {
      inPreferences = true;
      inHonorifics = false;
    } else if (line.startsWith('honorifics:')) {
      inPreferences = false;
      inHonorifics = true;
    } else if (inPreferences && line.includes(':')) {
      const [key, value] = line.split(':', 2).map(item => item.trim());
      config.preferences[key] = value;
    } else if (inHonorifics) {
      if (line.startsWith('user:')) {
        config.honorifics.user = line.replace('user:', '').trim();
      } else if (line.startsWith('assistant:')) {
        config.honorifics.assistant = line.replace('assistant:', '').trim();
      }
    }
  }
  
  return config;
}

export async function syncWithOpenClawConfig(workDir: string) {
  return readOpenClawConfig(workDir);
}

export async function importOpenClawSessions(workDir: string): Promise<Session[]> {
  try {
    if (!isTauri) {
      return [];
    }
    
    const workspacePath = `${workDir}/.openclaw/workspace`;
    
    if (!(await exists(workspacePath))) {
      console.warn(`工作目录不存在: ${workspacePath}`);
      return [];
    }
    
    const files = await readDir(workspacePath);
    const sessionsById = new Map<string, Session>();

    for (const file of files) {
      const fileName = file.name ?? "";
      if (!file.isFile || !fileName.endsWith(".json")) {
        continue;
      }

      const sessionPath = `${workspacePath}/${fileName}`;
      try {
        const sessionContent = await readTextFile(sessionPath);
        const sessionData = JSON.parse(sessionContent) as RawSessionData;

        const fallbackSessionId = fileName.replace(/\.json$/i, "");
        const sessionId =
          typeof sessionData.id === "string" && sessionData.id.trim()
            ? sessionData.id.trim()
            : fallbackSessionId;

        const rawMessages = Array.isArray(sessionData.messages)
          ? (sessionData.messages as RawSessionMessage[])
          : [];

        const createdAt =
          typeof sessionData.createdAt === "number"
            ? sessionData.createdAt
            : Date.now();

        const updatedAt =
          typeof sessionData.updatedAt === "number"
            ? sessionData.updatedAt
            : createdAt;

        const session: Session = {
          id: sessionId,
          title:
            typeof sessionData.title === "string" && sessionData.title.trim()
              ? sessionData.title.trim()
              : "未命名会话",
          messages: rawMessages.map((msg, index) => ({
            id:
              typeof msg.id === "string" && msg.id.trim()
                ? msg.id.trim()
                : `${sessionId}-msg-${index}`,
            role:
              msg.role === "assistant" || msg.role === "system"
                ? msg.role
                : "user",
            content: typeof msg.content === "string" ? msg.content : "",
            timestamp:
              typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
            files: Array.isArray(msg.files)
              ? msg.files.filter((item): item is string => typeof item === "string")
              : undefined,
          })),
          createdAt,
          updatedAt,
        };

        const existing = sessionsById.get(session.id);
        if (!existing || session.updatedAt > existing.updatedAt) {
          sessionsById.set(session.id, session);
        }
      } catch (error) {
        console.error(`解析会话文件 ${fileName} 失败:`, error);
      }
    }

    return Array.from(sessionsById.values()).sort(
      (a, b) => b.updatedAt - a.updatedAt
    );
  } catch (error) {
    console.error('导入 OpenClaw 会话失败:', error);
    return [];
  }
}
