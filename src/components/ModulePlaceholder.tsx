import { cn } from "@/lib/utils";

interface ModulePlaceholderProps {
  title: string;
  description: string;
  className?: string;
}

export function ModulePlaceholder({ title, description, className }: ModulePlaceholderProps) {
  return (
    <section className={cn("flex h-full min-h-[420px] items-center justify-center", className)}>
      <div className="w-full max-w-2xl rounded-2xl border border-neutral-800 bg-neutral-900 p-8 text-center shadow-xl">
        <h2 className="text-2xl font-semibold text-neutral-100">{title}</h2>
        <p className="mt-3 text-sm text-neutral-400">{description}</p>
      </div>
    </section>
  );
}
