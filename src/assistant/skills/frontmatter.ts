import type { SkillFrontmatter } from "./types.ts";

export class SkillFormatError extends Error {
  readonly file: string;
  readonly line: number | null;

  constructor(file: string, line: number | null, message: string) {
    super(line === null ? `${file}: ${message}` : `${file}:${line}: ${message}`);
    this.name = "SkillFormatError";
    this.file = file;
    this.line = line;
  }
}

type FieldKind = "scalar" | "list" | "boolean";

const FIELDS: Record<string, FieldKind> = {
  name: "scalar",
  description: "scalar",
  version: "scalar",
  source: "scalar",
  tools: "list",
  optional_tools: "list",
  requires_flags: "list",
  internal: "boolean",
};

const REQUIRED = ["name", "description", "version", "source", "tools"] as const;
const NAME_RE = /^[a-z][a-z0-9-]{2,40}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SOURCE_RE = /^(perceev|openseo:\.agents\/skills\/[a-z0-9-]+\/SKILL\.md@c5f8db1)$/;
const TOOL_RE = /^[a-z][a-z0-9_]{2,63}$/;
const LICENCE_COMMENT_RE = /<!-- Portions ported[\s\S]*?-->/g;
const BODY_MIN = 200;
const BODY_MAX = 24_000;
const DESCRIPTION_MIN = 20;
const DESCRIPTION_MAX = 1_024;

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

function countNewlines(text: string): number {
  return text.split("\n").length - 1;
}

export function parseSkillFile(
  file: string,
  raw: string
): { frontmatter: SkillFrontmatter; body: string; bodyStartLine: number } {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") throw new SkillFormatError(file, 1, "Skill has no frontmatter");
  const close = lines.indexOf("---", 1);
  if (close === -1) throw new SkillFormatError(file, 1, "Skill has no frontmatter");

  const values = new Map<string, string | string[]>();
  for (let i = 1; i < close; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const match = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!match) throw new SkillFormatError(file, i + 1, "Malformed frontmatter line");
    const [, key, rawValue] = match;
    const kind = FIELDS[key];
    if (kind === undefined) throw new SkillFormatError(file, i + 1, `Unknown frontmatter key ${key}`);
    if (values.has(key)) throw new SkillFormatError(file, i + 1, `Duplicate frontmatter key ${key}`);
    const value = rawValue.trim();
    if (kind === "list") {
      if (!value.startsWith("[") || !value.endsWith("]")) {
        throw new SkillFormatError(file, i + 1, `${key} must be an inline list`);
      }
      const inner = value.slice(1, -1).trim();
      values.set(key, inner === "" ? [] : inner.split(",").map((item) => unquote(item.trim())));
    } else {
      if (value.startsWith("[")) throw new SkillFormatError(file, i + 1, `${key} must be a single value`);
      values.set(key, unquote(value));
    }
  }

  for (const key of REQUIRED) {
    if (!values.has(key)) throw new SkillFormatError(file, 1, `Missing frontmatter key ${key}`);
  }

  const scalar = (key: string): string => String(values.get(key) ?? "");
  const list = (key: string): string[] => (values.get(key) as string[] | undefined) ?? [];

  const name = scalar("name");
  if (!NAME_RE.test(name)) throw new SkillFormatError(file, 1, `Invalid skill name "${name}"`);

  const description = scalar("description");
  if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    throw new SkillFormatError(file, 1, `description must be ${DESCRIPTION_MIN}–${DESCRIPTION_MAX} characters`);
  }

  const version = scalar("version");
  if (!VERSION_RE.test(version)) throw new SkillFormatError(file, 1, `Invalid version "${version}"`);

  const source = scalar("source");
  if (!SOURCE_RE.test(source)) throw new SkillFormatError(file, 1, `Invalid source "${source}"`);

  const tools = list("tools");
  if (tools.length === 0) throw new SkillFormatError(file, 1, "tools must not be empty");
  const optionalTools = list("optional_tools");
  const requiresFlags = list("requires_flags");
  for (const item of [...tools, ...optionalTools, ...requiresFlags]) {
    if (!TOOL_RE.test(item)) throw new SkillFormatError(file, 1, `Invalid list item "${item}"`);
  }

  const internalValue = values.has("internal") ? scalar("internal") : "false";
  if (internalValue !== "true" && internalValue !== "false") {
    throw new SkillFormatError(file, 1, "internal must be true or false");
  }

  const rawBody = lines.slice(close + 1).join("\n");
  const stripped = rawBody.replace(LICENCE_COMMENT_RE, (comment) => "\n".repeat(countNewlines(comment)));
  const leadingNewlines = /^\s*/.exec(stripped)?.[0] ?? "";
  const body = stripped.trim();
  const bodyStartLine = close + 2 + countNewlines(leadingNewlines);

  if (body.length < BODY_MIN || body.length > BODY_MAX) {
    throw new SkillFormatError(file, bodyStartLine, `body must be ${BODY_MIN}–${BODY_MAX} characters`);
  }
  const heading = /^# (.+)$/.exec(body.split("\n")[0]);
  if (!heading) throw new SkillFormatError(file, bodyStartLine, "body must start with a # title");

  return {
    frontmatter: {
      name,
      description,
      version,
      source,
      tools,
      optionalTools,
      requiresFlags,
      internal: internalValue === "true",
    },
    body,
    bodyStartLine,
  };
}
