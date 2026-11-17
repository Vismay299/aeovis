"use client";

function preview(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2) ?? "null";
    return text.length > 4000 ? text.slice(0, 3999) + "…" : text;
  } catch {
    return String(value).slice(0, 4000);
  }
}

/**
 * The fallback renderer: the tool output as JSON in a scrollable block, for
 * tools with no curated card. Keys stay readable; nothing is a link.
 */
export function JsonResult({ data }: { data: unknown }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs break-words whitespace-pre-wrap text-foreground/90">
      {preview(data)}
    </pre>
  );
}
