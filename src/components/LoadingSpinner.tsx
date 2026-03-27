interface LoadingSpinnerProps {
  text?: string;
  fullscreen?: boolean;
}

export function LoadingSpinner({
  text = "正在加载...",
  fullscreen = false,
}: LoadingSpinnerProps) {
  const containerClass = fullscreen
    ? "fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    : "flex items-center justify-center py-8";

  return (
    <div className={containerClass}>
      <div className="rounded-lg bg-white px-6 py-4 shadow-lg border border-gray-200 flex items-center gap-3">
        <div className="h-4 w-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
        <span className="text-sm text-gray-700">{text}</span>
      </div>
    </div>
  );
}

