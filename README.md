# SelfClaw

[English](#english) | 中文

---

## 中文

### 简介

**SelfClaw** 是一款面向 [OpenClaw](https://github.com/openclaw/openclaw) 的本地桌面客户端，基于 **Tauri 2 + React 18 + TypeScript** 构建，提供直观的图形界面来管理网关、对话沙盒、记忆中心、自动化流程等核心功能。

> SelfClaw 会**自动检测**本机已安装的 OpenClaw 配置（API Key、模型、提供商、网关端口等），实现零配置接入。

### 核心功能

| 功能模块 | 说明 |
|---------|------|
| **控制大盘（Dashboard）** | 启动/停止 OpenClaw 网关、查看实时日志、内嵌监控指标 |
| **对话沙盒（Chat Sandbox）** | 多会话管理、WebSocket 原生协议与网关直连、流式 AI 回复、会话导出为 Markdown |
| **记忆中心（Memory Center）** | 管理 OpenClaw 长期记忆，支持向量检索 |
| **自动化面板（Automation）** | 编排自动化工作流，配置触发器与动作链 |
| **连接管理（Connections）** | 管理 IM 渠道（Slack、Discord、Telegram 等）连接状态 |
| **配置面板（Settings）** | 模型选择、API Key、代理（HTTP/SOCKS5）、网关 Token、日志级别等全部可配置 |
| **引导向导（Onboarding）** | 首次启动自动检测本地 OpenClaw 配置，引导完成接入 |

### 技术架构

```
┌─────────────────────────────────────────────────────────┐
│                    SelfClaw 桌面客户端                    │
├──────────────────────┬──────────────────────────────────┤
│     React 18 + TS    │        Tauri 2 (Rust)            │
│  ┌─────────────────┐ │  ┌──────────────────────────┐   │
│  │  Chat Sandbox   │ │  │  网关进程管理             │   │
│  │  Dashboard      │ │  │  配置读写 (auto_detect)   │   │
│  │  Memory Center  │ │  │  系统命令执行              │   │
│  │  Automation     │ │  │  WebSocket → HTTP 桥接    │   │
│  │  Settings       │ │  │  Tauri IPC / 事件推送     │   │
│  └─────────────────┘ │  └──────────────────────────┘   │
├──────────────────────┴──────────────────────────────────┤
│              OpenClaw Gateway (本机进程)                  │
│  WebSocket 控制面 + 70+ 方法 (agent/chat/sessions...)    │
└─────────────────────────────────────────────────────────┘
```

**前端技术栈**
- React 18 + TypeScript（严格模式）
- Vite 6 构建工具
- Tailwind CSS 样式
- Zustand 状态管理（持久化到 IndexedDB）
- Lucide React 图标

**后端技术栈**
- Tauri 2（Rust）
- tokio 异步运行时
- ureq HTTP 客户端
- serde_json 配置序列化

**通信方式**
- **WebSocket**：与 OpenClaw 网关的原生协议连接（`connect` → `agent` 流式响应）
- **Tauri IPC**：前端 ↔ Rust 后端的命令调用
- **HTTP Fallback**：WebSocket 不可用时自动降级到 HTTP 直连

### 系统要求

- **操作系统**：Windows 10/11（当前主要测试平台），macOS / Linux 理论上兼容（Tauri 2 支持）
- **OpenClaw**：已安装并可本地运行（`openclaw gateway` 即可启动）
- **Node.js**：v18+（仅开发构建时需要）
- **Rust**：stable（仅开发构建时需要，`rustup default stable`）

### 快速开始

#### 前置依赖

确保本机已安装 **OpenClaw** 并可以正常启动网关：

```bash
openclaw --version      # 查看 OpenClaw 版本
openclaw gateway        # 启动网关（默认监听 18789 端口）
```

#### 安装

```bash
git clone https://github.com/yourusername/selfclaw.git
cd selfclaw
npm install
```

#### 开发模式

```bash
npm run dev
```

#### 生产构建

```bash
npm run build
```

构建产物位于 `src-tauri/target/release/selfclaw.exe`（Windows）或 `src-tauri/target/release/selfclaw`（macOS/Linux）。

#### 使用 Tauri CLI（可选）

```bash
npm run tauri dev      # 开发模式（含调试工具）
npm run tauri build    # 生产构建
```

### 配置说明

SelfClaw 启动时会自动检测以下 OpenClaw 配置来源（优先级从高到低）：

1. **Rust 后端**（`auto_detect_openclaw_config` Tauri 命令）— 读取 OpenClaw 磁盘配置文件
2. **环境变量**（`OPENCLAW_API_KEY`、`OPENCLAW_BASE_URL` 等）
3. **用户手动配置**（Settings 面板）

**常用配置项**

| 配置项 | 说明 | 默认值 |
|-------|------|--------|
| API Key | LLM 提供商密钥 | — |
| Base URL | API 端点（自定义模型时填写） | — |
| 模型 | 模型名称 | `codex-mini-latest` |
| 提供商 | `openai` / `anthropic` / `azure` 等 | `openai` |
| 网关端口 | OpenClaw 网关监听端口 | `18789` |
| 网关 Token | 网关认证令牌（见 `OPENCLAW_GATEWAY_TOKEN`） | — |
| System Prompt | 系统提示词 | — |
| HTTP 代理 | 代理地址（可选） | — |
| 日志级别 | `info` / `debug` / `error` | `info` |

### 项目结构

```
selfclaw/
├── src/                          # React 前端源码
│   ├── App.tsx                   # 应用入口、启动检测、路由
│   ├── main.tsx                  # React DOM 入口
│   ├── components/               # UI 组件
│   │   ├── ChatSandbox.tsx       # 对话沙盒
│   │   ├── DashboardPanel.tsx    # 控制大盘
│   │   ├── SettingsPanel.tsx     # 配置面板
│   │   ├── MemoryCenter.tsx      # 记忆中心
│   │   ├── AutomationPanel.tsx   # 自动化面板
│   │   ├── ConnectionsPanel.tsx  # 连接管理
│   │   ├── Onboarding.tsx        # 引导向导
│   │   ├── EnvironmentCheck.tsx  # 环境检测
│   │   ├── ConsoleShell.tsx      # 主控制台布局
│   │   ├── Sidebar.tsx           # 侧边栏导航
│   │   ├── TitleBar.tsx          # 自定义标题栏
│   │   └── ui/                   # 基础 UI 组件（Button、Input、Tabs 等）
│   ├── lib/
│   │   ├── openclaw.ts           # OpenClaw WebSocket 协议客户端
│   │   ├── autoInstaller.ts      # OpenClaw 自动安装器
│   │   ├── tauriErrors.ts        # Tauri 错误处理
│   │   ├── models.ts             # 模型与提供商映射
│   │   └── utils.ts              # 工具函数
│   └── store/
│       └── appStore.ts            # Zustand 全局状态（含 IndexedDB 持久化）
├── src-tauri/                    # Tauri 2 Rust 后端
│   ├── src/
│   │   ├── lib.rs                # 库入口
│   │   └── main.rs               # 命令注册（Tauri 命令）
│   ├── Cargo.toml                # Rust 依赖
│   ├── tauri.conf.json           # Tauri 配置（窗口、权限等）
│   └── capabilities/
│       └── default.json           # Tauri 能力权限配置
├── public/                       # 静态资源
├── tailwind.config.js            # Tailwind CSS 配置
├── vite.config.ts                # Vite 构建配置
├── tsconfig.json                 # TypeScript 配置
├── package.json                  # Node 依赖
└── README.md                     # 本文件
```

### WebSocket 协议说明

SelfClaw 通过 OpenClaw 网关的 **WebSocket 协议**（Protocol v3）进行通信，主要流程：

```
Client  ──req (connect)──▶  Gateway
Client  ◀──event (challenge)──  Gateway    ← 网关下发 nonce
Client  ──req (connect)──▶  Gateway          ← 用 nonce + 设备签名完成握手
Client  ◀──res (hello-ok)───  Gateway         ← 握手成功
Client  ──req (agent)───▶  Gateway            ← 发送 AI 请求
Client  ◀──event (agent.text)──  Gateway     ← 流式文本片段
Client  ◀──event (agent.done)───  Gateway     ← 完成
```

> **注意**：发送 `agent` 请求时，参数严格遵循 OpenClaw `AgentParamsSchema`（`message` + `idempotencyKey` + 可选字段），不支持 OpenAI 兼容格式的 `messages` / `baseUrl` / `stream`。

### 常见问题

**Q: 启动时报"无法连接本地网关 WebSocket"**

确保 OpenClaw 网关已在运行：

```bash
openclaw gateway
```

如果网关在其他端口启动，请在 Settings → Advanced 中修改**网关端口**。

**Q: 对话报 "device identity mismatch"**

本地网关开启了 `allowInsecureAuth`，SelfClaw 会自动优先使用**仅 Token** 的连接方式，跳过设备身份验证。如果仍出现此错误，请确认网关配置中的 Token 与 SelfClaw Settings 中的 **Gateway Token** 一致。

**Q: HTTP Fallback 404**

WebSocket 连接失败后会自动降级到 HTTP 直连。如果两个端点均 404，说明网关未启动或端口配置有误。

**Q: 如何自定义模型？**

在 Settings → Model 中选择提供商，并在 Base URL 中填写自定义 API 端点（例如 OpenAI 兼容接口）。

### 开发指南

**代码规范**
- TypeScript 严格模式，禁止 `@ts-ignore`（除 noble/ed25519 的 ESM 兼容问题外）
- ESLint + Prettier 格式化
- Tailwind CSS 原子化样式

**调试**
- 开发模式下 `F12` 打开 Tauri 调试工具
- 网关日志实时显示在 Dashboard 的日志面板中
- `src/lib/openclaw.ts` 中所有 `console.log` 标注了 `[openclaw]` 前缀，便于过滤

**状态持久化**
- 用户配置存储在 **IndexedDB**（通过 Zustand `persist` 中间件）
- 对话会话、会话历史在 IndexedDB 中自动保存，刷新后恢复

---

## English

### Overview

**SelfClaw** is a local desktop client for [OpenClaw](https://github.com/openclaw/openclaw), built with **Tauri 2 + React 18 + TypeScript**. It provides an intuitive GUI for managing the gateway, chat sandbox, memory center, automation workflows, and more.

> SelfClaw automatically detects your local OpenClaw installation (API Key, model, provider, gateway port, etc.) and connects with zero manual configuration.

### Key Features

| Module | Description |
|--------|-------------|
| **Dashboard** | Start/stop OpenClaw gateway, real-time log viewer, embedded monitoring |
| **Chat Sandbox** | Multi-session management, native WebSocket protocol, streaming AI responses, export sessions to Markdown |
| **Memory Center** | Manage OpenClaw long-term memory with vector search |
| **Automation Panel** | Orchestrate automation workflows with triggers and action chains |
| **Connections** | Manage IM channel connections (Slack, Discord, Telegram, etc.) |
| **Settings** | Full configuration: model selection, API Key, proxies, gateway token, log level |
| **Onboarding** | First-launch wizard auto-detects local OpenClaw setup |

### Tech Stack

- **Frontend**: React 18 + TypeScript, Vite 6, Tailwind CSS, Zustand
- **Backend**: Tauri 2 (Rust), tokio, ureq, serde_json
- **Communication**: WebSocket (gateway native protocol), Tauri IPC, HTTP fallback

### Quick Start

```bash
# Clone
git clone https://github.com/yourusername/selfclaw.git
cd selfclaw

# Install dependencies
npm install

# Development
npm run dev

# Production build
npm run build
```

> **Prerequisite**: OpenClaw must be installed and `openclaw gateway` must be able to run locally.

### License

MIT
