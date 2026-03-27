import { type ReactNode } from "react";

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <div className="h-screen flex flex-col bg-neutral-900 text-neutral-100 overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
