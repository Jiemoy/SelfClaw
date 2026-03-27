import {
  Activity,
  Brain,
  Clock3,
  MessageSquare,
  Network,
  Puzzle,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type ConsoleTab =
  | "dashboard"
  | "chat"
  | "clawhub"
  | "memory"
  | "automation"
  | "connections"
  | "settings";

interface SidebarItem {
  id: ConsoleTab;
  label: string;
  icon: LucideIcon;
}

const SIDEBAR_ITEMS: SidebarItem[] = [
  { id: "dashboard", label: "监控大盘", icon: Activity },
  { id: "chat", label: "对话沙盒", icon: MessageSquare },
  { id: "clawhub", label: "ClawHub", icon: Puzzle },
  { id: "memory", label: "记忆中枢", icon: Brain },
  { id: "automation", label: "自动化", icon: Clock3 },
  { id: "connections", label: "渠道与节点", icon: Network },
  { id: "settings", label: "深度设置", icon: Settings },
];

interface SidebarProps {
  activeTab: ConsoleTab;
  onChange: (tab: ConsoleTab) => void;
}

export function Sidebar({ activeTab, onChange }: SidebarProps) {
  return (
    <aside className="flex h-full w-[260px] flex-col border-r border-neutral-800 bg-neutral-900 px-3 py-4">
      <div className="mb-6 flex items-center gap-3 px-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-500 text-white">
          SC
        </div>
        <div>
          <p className="text-sm font-semibold text-neutral-100">SelfClaw</p>
          <p className="text-xs text-neutral-400">OpenClaw 可视化指挥中心</p>
        </div>
      </div>

      <nav className="space-y-1">
        {SIDEBAR_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.id === activeTab;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onChange(item.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors duration-200",
                active
                  ? "bg-orange-500/15 text-orange-300"
                  : "text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{item.label}</span>
              {active ? <span className="ml-auto h-2 w-1 rounded bg-orange-500" /> : null}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
