// Pure (no JSX, no app aliases) so tests can load it directly.

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export type ToolPartView = {
  toolName: string;
  state: string;
  input: Record<string, unknown>;
  output: unknown;
  errorText?: string;
};

/** Normalise a `tool-*` or `dynamic-tool` part into one view, whatever the SDK version shaped it as. */
export function toToolPartView(part: unknown): ToolPartView | null {
  const record = asRecord(part);
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "dynamic-tool") {
    return {
      toolName: typeof record.toolName === "string" ? record.toolName : "unknown",
      state: typeof record.state === "string" ? record.state : "",
      input: asRecord(record.input),
      output: record.output,
      errorText: typeof record.errorText === "string" ? record.errorText : undefined,
    };
  }
  if (type.startsWith("tool-")) {
    return {
      toolName: type.slice("tool-".length),
      state: typeof record.state === "string" ? record.state : "",
      input: asRecord(record.input),
      output: record.output,
      errorText: typeof record.errorText === "string" ? record.errorText : undefined,
    };
  }
  return null;
}
