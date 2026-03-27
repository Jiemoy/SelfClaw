import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { BaseDirectory, mkdir } from "@tauri-apps/plugin-fs";

const INSTALLER_DIR = "installers";
const NODE_MSI_NAME = "node-v20.11.0-x64.msi";
const OPENCLAW_SETUP_NAME = "OpenClaw-Setup.exe";

async function resolveInstallerPath(fileName: string): Promise<string> {
  await mkdir(INSTALLER_DIR, {
    baseDir: BaseDirectory.AppLocalData,
    recursive: true,
  });

  const appLocalDir = await appLocalDataDir();
  return join(appLocalDir, INSTALLER_DIR, fileName);
}

export async function installNodeJS(
  onProgress: (progress: number, stage: string) => void
): Promise<boolean> {
  try {
    onProgress(0, "准备 Node.js 安装包");

    const downloadUrl =
      "https://npmmirror.com/mirrors/node/v20.11.0/node-v20.11.0-x64.msi";
    const msiPath = await resolveInstallerPath(NODE_MSI_NAME);

    onProgress(10, "下载 Node.js");
    await invoke("run_sys_command", {
      command: "curl",
      args: ["-o", msiPath, "-L", downloadUrl],
    });

    onProgress(80, "安装 Node.js");
    await invoke("run_sys_command", {
      command: "msiexec",
      args: ["/i", msiPath, "/quiet", "/norestart"],
    });

    onProgress(100, "Node.js 安装完成");
    return true;
  } catch (error) {
    console.error("Node.js 安装失败:", error);
    return false;
  }
}

export async function installOpenClaw(
  onProgress: (progress: number, stage: string) => void
): Promise<boolean> {
  try {
    onProgress(0, "准备 OpenClaw 安装包");

    const downloadUrl =
      "https://github.com/OpenClawAI/OpenClaw/releases/latest/download/OpenClaw-Setup.exe";
    const exePath = await resolveInstallerPath(OPENCLAW_SETUP_NAME);

    onProgress(10, "下载 OpenClaw");
    await invoke("run_sys_command", {
      command: "curl",
      args: ["-o", exePath, "-L", downloadUrl],
    });

    onProgress(80, "安装 OpenClaw");
    await invoke("run_sys_command", {
      command: exePath,
      args: ["/S"],
    });

    onProgress(100, "OpenClaw 安装完成");
    return true;
  } catch (error) {
    console.error("OpenClaw 安装失败:", error);
    return false;
  }
}
