export function isIgnorableTauriInvokeError(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error ?? "");

  const normalized = message.toLowerCase();

  return (
    normalized.includes("couldn't find callback id") ||
    normalized.includes("could not find callback id") ||
    (normalized.includes("callback id") && normalized.includes("not found")) ||
    normalized.includes("channel closed") ||
    normalized.includes("ipc channel closed") ||
    normalized.includes("webview not found") ||
    normalized.includes("window is closed")
  );
}
