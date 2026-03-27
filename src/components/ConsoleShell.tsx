import { useEffect, useMemo, useState } from "react";
import { AutomationPanel } from "@/components/AutomationPanel";
import { ChatSandbox } from "@/components/ChatSandbox";
import { ClawHubPanel } from "@/components/ClawHubPanel";
import { ConnectionsPanel } from "@/components/ConnectionsPanel";
import { DashboardPanel } from "@/components/DashboardPanel";
import { MemoryCenter } from "@/components/MemoryCenter";
import { SettingsPanel } from "@/components/SettingsPanel";
import { Sidebar, type ConsoleTab } from "@/components/Sidebar";

export function ConsoleShell() {
  const [activeTab, setActiveTab] = useState<ConsoleTab>("dashboard");
  const [renderedTab, setRenderedTab] = useState<ConsoleTab>("dashboard");
  const [isFading, setIsFading] = useState(false);

  useEffect(() => {
    if (activeTab === renderedTab) {
      return;
    }

    setIsFading(true);
    const timer = window.setTimeout(() => {
      setRenderedTab(activeTab);
      setIsFading(false);
    }, 140);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeTab, renderedTab]);

  const content = useMemo(() => {
    if (renderedTab === "dashboard") {
      return <DashboardPanel />;
    }
    if (renderedTab === "chat") {
      return <ChatSandbox />;
    }
    if (renderedTab === "clawhub") {
      return <ClawHubPanel />;
    }
    if (renderedTab === "memory") {
      return <MemoryCenter />;
    }
    if (renderedTab === "automation") {
      return <AutomationPanel />;
    }
    if (renderedTab === "connections") {
      return <ConnectionsPanel />;
    }
    return <SettingsPanel />;
  }, [renderedTab]);

  return (
    <div className="flex h-full overflow-hidden bg-neutral-900 text-neutral-100">
      <Sidebar activeTab={activeTab} onChange={setActiveTab} />

      <main className="flex-1 overflow-auto bg-neutral-900 p-6">
        <div
          className={`h-full transition-opacity duration-150 ${
            isFading ? "opacity-0" : "opacity-100"
          }`}
        >
          {content}
        </div>
      </main>
    </div>
  );
}
