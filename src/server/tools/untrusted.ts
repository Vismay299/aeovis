export const INVISIBLE_CONTROL_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

function setAtPath(root: unknown, parts: string[], replacement: string, index = 0): void {
  if (index === parts.length - 1) {
    if (Array.isArray(root) && /^\d+$/.test(parts[index])) {
      root[Number(parts[index])] = replacement;
    } else if (typeof root === "object" && root !== null) {
      Reflect.set(root, parts[index], replacement);
    }
    return;
  }
  if (Array.isArray(root) && /^\d+$/.test(parts[index])) {
    setAtPath(root[Number(parts[index])], parts, replacement, index + 1);
  } else if (typeof root === "object" && root !== null) {
    setAtPath(Reflect.get(root, parts[index]), parts, replacement, index + 1);
  }
}

function visit(
  node: unknown,
  parts: string[],
  partIndex: number,
  concrete: string[],
  found: string[],
  root: unknown,
): void {
  if (partIndex >= parts.length) return;
  const part = parts[partIndex];
  if (part === "*") {
    if (!Array.isArray(node)) return;
    node.forEach((item, index) =>
      visit(item, parts, partIndex + 1, [...concrete, String(index)], found, root),
    );
    return;
  }
  if (typeof node !== "object" || node === null || !Object.hasOwn(node, part)) return;
  const value = Reflect.get(node, part);
  const next = [...concrete, part];
  if (partIndex === parts.length - 1) {
    if (typeof value !== "string") return;
    const cleaned = value.replace(INVISIBLE_CONTROL_RE, "");
    setAtPath(root, next, cleaned);
    const concretePath = next.join(".").replace(/\.(\d+)(?=\.|$)/g, "[$1]");
    if (!found.includes(concretePath)) found.push(concretePath);
    return;
  }
  visit(value, parts, partIndex + 1, next, found, root);
}

export function markUntrusted(
  output: unknown,
  paths: readonly string[] | undefined,
): { output: unknown; untrusted: string[] } {
  if (!paths?.length) return { output, untrusted: [] };
  const copy = structuredClone(output);
  const found: string[] = [];
  for (const path of paths) {
    const parts = path.replace(/\[(\*|\d+)\]/g, ".$1").split(".").filter(Boolean);
    visit(copy, parts, 0, [], found, copy);
  }
  return { output: copy, untrusted: found };
}
