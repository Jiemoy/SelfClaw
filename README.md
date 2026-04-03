# SelfClaw

[中文](#中文) | [English](#english)

---

## 中文

### 简介

**SelfClaw** 是一个面向 [OpenClaw](https://github.com/openclaw/openclaw) 的本地桌面控制台，基于 **Tauri 2 + React 18 + TypeScript** 构建。

它把 OpenClaw 的本地网关、模型配置、聊天沙盒、ClawHub、记忆、自动化和渠道管理整合到一个桌面应用里，适合把 OpenClaw 当作本地 AI 中枢来使用。

### 当前功能

- 环境检查：检测 Node.js、npm、OpenClaw 是否可用，并在 Windows 上支持一键安装 Node.js / OpenClaw CLI
- 首次向导：自动扫描本地 OpenClaw 配置并完成接入
- 监控大盘：查看网关状态、日志、自愈与重启能力
- 对话沙盒：基于 OpenClaw 网关 WebSocket 协议进行多会话对话，支持流式输出和 Markdown 导出
- ClawHub：管理技能安装与更新检查
- 记忆中枢：查看和操作本地记忆数据
- 自动化：自动化面板入口
- 渠道与节点：IM 渠道、节点、设备等信息管理入口
- 深度设置：模型、Base URL、代理、网关 Token、日志级别、历史消息上限、长期记忆、开机自启等

### 技术栈

- 前端：React 18、TypeScript、Vite 6、Tailwind CSS、Zustand
- 桌面层：Tauri 2
- 后端：Rust、tokio、serde_json、ureq
- 通信：
  - Tauri IPC 用于前端和 Rust 间命令调用
  - WebSocket 用于连接本地 OpenClaw Gateway

### 快速开始

#### 1. 准备环境

确保本机已安装并可运行：

- Node.js
- npm
- OpenClaw

可用以下命令检查：

```bash
node --version
npm --version
openclaw --version
```

#### 2. 安装依赖

```bash
git clone https://github.com/yourusername/selfclaw.git
cd selfclaw
npm install
```

#### 3. 启动开发环境

```bash
npm run dev
```

#### 4. 构建生产包

```bash
npm run build
```

如果要通过 Tauri CLI 启动桌面调试或打包：

```bash
npm run tauri -- dev
npm run tauri -- build
```

### 配置说明

SelfClaw 会优先自动探测本地 OpenClaw 配置，并把数据同步到：

- `~/.openclaw/openclaw.json`
- `~/.openclaw/selfclaw-ui.json`

#### 模型与 Base URL 自动填充

在“深度设置”与首次向导中，切换模型提供商时会自动填充默认 `Base URL`。你仍然可以手动覆盖。

当前内置映射如下：

| Provider | 默认 Base URL |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` |
| Moonshot (Kimi) | `https://api.moonshot.cn/v1` |
| Anthropic (Claude) | `https://api.anthropic.com/v1` |
| Google (Gemini) | `https://generativelanguage.googleapis.com/v1beta/openai` |
| DeepSeek | `https://api.deepseek.com/v1` |
| 通义千问 (Qwen) | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 智谱 / Z.AI | `https://open.bigmodel.cn/api/paas/v4` |

#### 主要配置项

| 配置项 | 说明 |
| --- | --- |
| Provider | 模型提供商 |
| Model | 当前默认模型 |
| API Key | 模型服务密钥 |
| Base URL | 自动填充的默认接口地址，可手动覆盖 |
| System Prompt | 全局系统提示词 |
| HTTP / SOCKS5 Proxy | 请求代理 |
| Gateway Port | 本地网关端口，默认 `18789` |
| Gateway Token | 网关认证 Token |
| Log Level | `info` / `debug` / `error` |
| History Message Limit | 历史消息携带上限 |
| Long-term Memory | 是否启用长期记忆 |
| Autostart | 是否开机自启 |

### 运行脚本

```bash
npm run dev
npm run build
npm run lint
npm run preview
npm run tauri -- dev
npm run tauri -- build
```

### 项目结构

```text
selfclaw/
├─ src/
│  ├─ components/
│  │  ├─ DashboardPanel.tsx
│  │  ├─ ChatSandbox.tsx
│  │  ├─ ClawHubPanel.tsx
│  │  ├─ MemoryCenter.tsx
│  │  ├─ AutomationPanel.tsx
│  │  ├─ ConnectionsPanel.tsx
│  │  ├─ SettingsPanel.tsx
│  │  ├─ Onboarding.tsx
│  │  └─ EnvironmentCheck.tsx
│  ├─ lib/
│  │  ├─ openclaw.ts
│  │  ├─ autoInstaller.ts
│  │  ├─ models.ts
│  │  └─ utils.ts
│  ├─ store/
│  │  ├─ appStore.ts
│  │  └─ indexedDbStorage.ts
│  └─ App.tsx
├─ src-tauri/
│  ├─ src/main.rs
│  ├─ Cargo.toml
│  └─ tauri.conf.json
└─ README.md
```

### 已验证

- `npm run build` 可通过

### 说明

- 项目当前偏 Windows 本地使用场景，尤其是环境检查和自动安装流程
- `npm run lint` 目前仍有仓库内历史问题，主要不在本次改动涉及的文件中

---

## English

### Overview

**SelfClaw** is a local desktop console for [OpenClaw](https://github.com/openclaw/openclaw), built with **Tauri 2 + React 18 + TypeScript**.

It provides a GUI for:

- local OpenClaw setup detection
- gateway monitoring and recovery
- chat sandbox over the native gateway WebSocket protocol
- ClawHub skill management
- memory and automation panels
- deep model/network/runtime settings

### Quick Start

```bash
git clone https://github.com/yourusername/selfclaw.git
cd selfclaw
npm install
npm run dev
```

Build:

```bash
npm run build
```

### Base URL Autofill

When you switch the model provider in onboarding or settings, SelfClaw now auto-fills the provider's default `Base URL`, while still allowing manual override.

Built-in defaults:

- OpenAI: `https://api.openai.com/v1`
- Moonshot: `https://api.moonshot.cn/v1`
- Anthropic: `https://api.anthropic.com/v1`
- Google Gemini: `https://generativelanguage.googleapis.com/v1beta/openai`
- DeepSeek: `https://api.deepseek.com/v1`
- Qwen: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Z.AI: `https://open.bigmodel.cn/api/paas/v4`

### Verified

- `npm run build` passes
