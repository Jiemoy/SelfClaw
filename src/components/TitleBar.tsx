import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, SquareStack, X } from "lucide-react";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const appWindow = useMemo(() => {
    if (!isTauriRuntime()) {
      return null;
    }
    return getCurrentWindow();
  }, []);

  const syncWindowState = useCallback(async () => {
    if (!appWindow) {
      return;
    }

    try {
      const maximized = await appWindow.isMaximized();
      setIsMaximized(maximized);
    } catch {
      setIsMaximized(false);
    }
  }, [appWindow]);

  useEffect(() => {
    if (!appWindow) {
      return;
    }

    void syncWindowState();
    let unlisten: (() => void) | undefined;

    void appWindow
      .onResized(() => {
        void syncWindowState();
      })
      .then((dispose) => {
        unlisten = dispose;
      });

    return () => {
      unlisten?.();
    };
  }, [appWindow, syncWindowState]);

  const minimize = async () => {
    if (!appWindow) {
      return;
    }
    await appWindow.minimize();
  };

  const toggleMaximize = async () => {
    if (!appWindow) {
      return;
    }
    await appWindow.toggleMaximize();
    await syncWindowState();
  };

  const close = async () => {
    if (!appWindow) {
      return;
    }
    await appWindow.close();
  };

  return (
    <header className="fixed inset-x-0 top-0 z-50 h-8 border-b border-neutral-800 bg-neutral-900/95 backdrop-blur">
      <div className="flex h-full items-center justify-between">
        <div className="flex h-full flex-1 items-center px-3" data-tauri-drag-region>
          <div className="flex items-center gap-2 text-xs text-neutral-300">
            <span className="font-semibold text-orange-400">SelfClaw</span>
            <span className="text-neutral-500">本地 AI 网关控制台</span>
          </div>
        </div>

        <div className="flex h-full items-stretch">
          <button
            type="button"
            onClick={() => void minimize()}
            className="flex h-full w-10 items-center justify-center text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100"
            aria-label="最小化"
            title="最小化"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void toggleMaximize()}
            className="flex h-full w-10 items-center justify-center text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100"
            aria-label={isMaximized ? "还原窗口" : "最大化窗口"}
            title={isMaximized ? "还原窗口" : "最大化窗口"}
          >
            {isMaximized ? (
              <SquareStack className="h-3.5 w-3.5" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => void close()}
            className="flex h-full w-10 items-center justify-center text-neutral-400 transition hover:bg-red-600 hover:text-white"
            aria-label="关闭窗口"
            title="关闭窗口"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}
