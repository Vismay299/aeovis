"use client";

/**
 * A workspace-memory read or write. `get_project_context` returns the memory
 * sections; `update_project_context` returns a short summary. Scalars render
 * as key-value rows, arrays as their item count, nested objects as JSON.
 */
export function ContextResult({ data }: { data: unknown }) {
  const record =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const summary = typeof record.summary === "string" ? record.summary : null;
  const entries = Object.entries(record).filter(([key]) => key !== "summary");
  return (
    <div className="space-y-1.5">
      {summary ? <p className="text-sm text-foreground/90">{summary}</p> : null}
      {entries.length > 0 ? (
        <dl className="divide-y divide-border rounded-lg border border-border">
          {entries.map(([key, value]) => (
            <div key={key} className="flex items-baseline justify-between gap-4 px-3 py-1.5">
              <dt className="shrink-0 text-xs text-muted-foreground">{humanizeKey(key)}</dt>
              <dd className="min-w-0 text-right text-xs break-words">
                {Array.isArray(value)
                  ? `${value.length} item${value.length === 1 ? "" : "s"}`
                  : value === null || value === undefined
                    ? "—"
                    : typeof value === "object"
                      ? JSON.stringify(value).slice(0, 160)
                      : String(value).slice(0, 160)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
