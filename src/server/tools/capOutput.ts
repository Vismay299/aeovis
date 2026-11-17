// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/sam/samToolOutput.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

const SAM_MAX_TOOL_OUTPUT_CHARS = 32_000;
const MAX_STRING_CHARS = 8_000;
const MIN_STRING_CHARS = 500;
const NOTE_BUDGET_CHARS = 600;

type Trim = {
  path: string;
  kept: number;
  total: number;
  unit: "rows" | "chars";
};

type Slot = { parent: object; key: string | number; path: string };

const size = (value: unknown): number => JSON.stringify(value)?.length ?? 0;

function slots(value: unknown, path = ""): Slot[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const itemPath = path + "[" + index + "]";
      const here: Slot[] =
        Array.isArray(item) || typeof item === "string"
          ? [{ parent: value, key: index, path: itemPath }]
          : [];
      return [...here, ...slots(item, itemPath)];
    });
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => {
      const itemPath = path ? path + "." + key : key;
      const here: Slot[] =
        Array.isArray(item) || typeof item === "string"
          ? [{ parent: value, key, path: itemPath }]
          : [];
      return [...here, ...slots(item, itemPath)];
    });
  }
  return [];
}

const read = (slot: Slot): unknown => Reflect.get(slot.parent, slot.key);
const write = (slot: Slot, value: unknown): void => {
  Reflect.set(slot.parent, slot.key, value);
};
const shape = (path: string): string => path.replace(/\[\d+\]/g, "[*]");

function present(value: unknown, path: string): boolean {
  let node = value;
  for (const segment of path.split(/\.|(?=\[)/)) {
    if (segment === "") continue;
    if (segment === "[*]") {
      if (!Array.isArray(node) || node.length === 0) return false;
      node = node[0];
      continue;
    }
    if (typeof node !== "object" || node === null) return false;
    node = Reflect.get(node, segment);
    if (node === undefined) return false;
  }
  return true;
}

function note(trims: Trim[]): string {
  const parts = trims.map((trim) =>
    trim.unit === "rows"
      ? "\`" + trim.path + "\` shows " + trim.kept + " of " + trim.total + " rows"
      : "\`" + trim.path + "\` shortened to " + trim.kept + " chars",
  );
  const text =
    "Output trimmed to fit the chat context: " +
    parts.join("; ") +
    ". Narrow the request (filters, a smaller limit, fewer pages) to see the rest.";
  return text.length > NOTE_BUDGET_CHARS ? text.slice(0, NOTE_BUDGET_CHARS - 1) + "…" : text;
}

export function capToolOutput(value: unknown, maxChars = SAM_MAX_TOOL_OUTPUT_CHARS): unknown {
  if (size(value) <= maxChars) return value;

  const budget = maxChars - NOTE_BUDGET_CHARS;
  const copy: unknown = structuredClone(value);
  const trims = new Map<string, Trim>();
  const record = (slot: Slot, kept: number, total: number, unit: Trim["unit"]) => {
    const path = shape(slot.path);
    const existing = trims.get(path);
    trims.set(path, {
      path,
      kept: existing ? Math.min(existing.kept, kept) : kept,
      total: existing ? Math.max(existing.total, total) : total,
      unit,
    });
  };

  for (const slot of slots(copy)) {
    const item = read(slot);
    if (typeof item === "string" && item.length > MAX_STRING_CHARS) {
      write(slot, item.slice(0, MAX_STRING_CHARS));
      record(slot, MAX_STRING_CHARS, item.length, "chars");
    }
  }

  while (size(copy) > budget) {
    const largest = slots(copy)
      .map((slot) => ({ slot, item: read(slot) }))
      .filter(
        (entry): entry is { slot: Slot; item: unknown[] } =>
          Array.isArray(entry.item) && entry.item.length > 1,
      )
      .reduce<{ slot: Slot; item: unknown[] } | undefined>(
        (best, entry) => (best && size(best.item) >= size(entry.item) ? best : entry),
        undefined,
      );
    if (!largest) break;
    const kept = Math.ceil(largest.item.length / 2);
    write(largest.slot, largest.item.slice(0, kept));
    record(largest.slot, kept, largest.item.length, "rows");
  }

  while (size(copy) > budget) {
    const longest = slots(copy)
      .map((slot) => ({ slot, item: read(slot) }))
      .filter(
        (entry): entry is { slot: Slot; item: string } =>
          typeof entry.item === "string" && entry.item.length > MIN_STRING_CHARS,
      )
      .reduce<{ slot: Slot; item: string } | undefined>(
        (best, entry) => (best && best.item.length >= entry.item.length ? best : entry),
        undefined,
      );
    if (!longest) break;
    const kept = Math.max(MIN_STRING_CHARS, Math.ceil(longest.item.length / 2));
    write(longest.slot, longest.item.slice(0, kept));
    record(longest.slot, kept, longest.item.length, "chars");
  }

  const truncated = note([...trims.values()].filter((trim) => present(copy, trim.path)));
  return structuredClone(
    typeof copy === "object" && copy !== null && !Array.isArray(copy)
      ? { ...copy, truncated }
      : { data: copy, truncated },
  );
}
