import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { BaseDirectory, mkdir } from "@tauri-apps/plugin-fs";

const INSTALLER_DIR = "installers";
const NODE_MSI_NAME = "node-v20.11.0-x64.msi";
const NODE_DOWNLOAD_URL = "https://npmmirror.com/mirrors/node/v20.11.0/node-v20.11.0-x64.msi";
const NODE_MIN_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

async function resolveInstallerPath(fileName: string): Promise<string> {
  await mkdir(INSTALLER_DIR, {
    baseDir: BaseDirectory.AppLocalData,
    recursive: true,
  });

  const appLocalDir = await appLocalDataDir();
  return join(appLocalDir, INSTALLER_DIR, fileName);
}

async function downloadFile(
  url: string,
  outputPath: string,
  onProgress: (progress: number, stage: string) => void
): Promise<void> {
  let unlisten: UnlistenFn | null = null;

  try {
    unlisten = await listen<{
      progress: number;
      stage: string;
    }>("download-progress", (event) => {
      onProgress(event.payload.progress, event.payload.stage);
    });

    const result = await invoke<string>("download_file_with_progress", {
      url,
      outputPath,
    });

    onProgress(85, "下载完成，正在准备安装...");
    console.log("[autoInstaller] 下载完成:", result);
  } finally {
    if (unlisten) {
      unlisten();
    }
  }
}

export async function installNodeJS(
  onProgress: (progress: number, stage: string) => void
): Promise<boolean> {
  try {
    onProgress(0, "准备 Node.js 安装包");

    const msiPath = await resolveInstallerPath(NODE_MSI_NAME);

    onProgress(5, "下载 Node.js...");
    await downloadFile(NODE_DOWNLOAD_URL, msiPath, onProgress);

    // Final size safety check (Rust already validates, but double-check here)
    const { stat } = await import("@tauri-apps/plugin-fs");
    try {
      const info = await stat(msiPath);
      const sizeMB = (info.size / (1024 * 1024)).toFixed(2);
      if (info.size < NODE_MIN_SIZE_BYTES) {
        throw new Error(
          `下载失败：Node.js 安装包体积异常（${sizeMB} MB < 5 MB），可能链接已失效，请手动前往 https://nodejs.org 下载安装。`
        );
      }
    } catch (fsError) {
      if (fsError instanceof Error && fsError.message.includes("下载失败")) {
        throw fsError;
      }
      // stat failed but Rust already validated — ignore
    }

    onProgress(90, "安装 Node.js");
    await invoke("run_sys_command", {
      command: "msiexec",
      args: ["/i", msiPath, "/quiet", "/norestart"],
    });

    onProgress(100, "Node.js 安装完成");
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Node.js 安装失败:", msg);
    if (
      msg.includes("体积异常") ||
      msg.includes("链接已失效") ||
      msg.includes("下载失败")
    ) {
      throw error;
    }
    return false;
  }
}

export async function installOpenClaw(
  onProgress: (progress: number, stage: string) => void
): Promise<boolean> {
  let unlisten: UnlistenFn | null = null;

  try {
    onProgress(0, "准备安装 OpenClaw CLI");

    // Listen for progress events from Rust (npm install with time-based progress)
    unlisten = await listen<{
      progress: number;
      stage: string;
    }>("npm-install-progress", (event) => {
      onProgress(event.payload.progress, event.payload.stage);
    });

    // OpenClaw CLI is an npm global package — install via npm
    const result = await invoke<string>("install_openclaw_cli");

    onProgress(95, "安装完成，验证环境...");
    console.log("[autoInstaller] OpenClaw npm install result:", result);

    onProgress(100, "OpenClaw 安装完成");
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("OpenClaw 安装失败:", msg);
    return false;
  } finally {
    if (unlisten) {
      unlisten();
    }
  }
}
