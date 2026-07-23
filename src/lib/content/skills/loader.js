import { readFileSync, existsSync } from "fs";
import path from "path";

/**
 * Skill-file loader for the Agent Content OS pipeline.
 *
 * Each step×playbook pair is authored as a markdown file with YAML
 * frontmatter: `<step>.<playbook>.md`, falling back to `<step>.shared.md`.
 * Prompts live in git-versioned markdown — the co-founder tunes agent
 * behavior by editing these files, no code changes (locked decision #7).
 */

const SKILLS_DIR = path.join(process.cwd(), "src", "lib", "content", "skills");

// Module-level cache; in dev Next.js clears module state on file edits, so
// skill edits are picked up on reload without a server restart.
const cache = new Map();

/**
 * Minimal YAML frontmatter parser. Supports `key: value` and inline lists
 * `key: [a, b, c]` — deliberately tiny, the frontmatter never nests.
 */
function parseFrontmatter(raw) {
  const meta = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, valueRaw] = m;
    const value = valueRaw.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      meta[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      meta[key] = value;
    }
  }
  return meta;
}

/**
 * Load a skill file for a step + playbook. Tries `<step>.<playbook>.md`
 * first, then `<step>.shared.md`. Throws if neither exists — a missing
 * skill file is a build defect, not a runtime condition to paper over.
 */
export function loadSkill(step, playbook) {
  const key = `${step}.${playbook}`;
  if (cache.has(key)) return cache.get(key);

  const candidates = [
    path.join(SKILLS_DIR, `${step}.${playbook}.md`),
    path.join(SKILLS_DIR, `${step}.shared.md`),
  ];
  const file = candidates.find((p) => existsSync(p));
  if (!file) {
    throw new Error(`No skill file for step "${step}" playbook "${playbook}"`);
  }

  const raw = readFileSync(file, "utf8");
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = fmMatch ? parseFrontmatter(fmMatch[1]) : {};
  const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;

  const skill = { meta, body, file };
  cache.set(key, skill);
  return skill;
}

/**
 * Interpolate {{var}} placeholders in a skill body. Values that are objects
 * are JSON-stringified (pretty) so prompts stay readable in logs. Unknown
 * placeholders are left intact — visible in the prompt, easy to spot.
 */
export function renderSkill(skill, vars = {}) {
  return skill.body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name) => {
    if (!(name in vars)) return match;
    const v = vars[name];
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    return JSON.stringify(v, null, 2);
  });
}

/** Convenience: load + render in one call. */
export function renderStepPrompt(step, playbook, vars) {
  return renderSkill(loadSkill(step, playbook), vars);
}

/** Test hook: clear the cache (used by loader tests). */
export function _clearSkillCache() {
  cache.clear();
}
