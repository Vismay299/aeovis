export type ReferenceProblem = {
  skill: string;
  token: string;
  line: number;
  reason: "unknown_tool" | "not_in_frontmatter" | "optional_not_declared";
};

export type ReferenceVocabulary = {
  declared: ReadonlySet<string>;
  planned: ReadonlySet<string>;
  terms: ReadonlySet<string>;
};

export type ReferenceEntry = {
  name: string;
  tools: string[];
  optionalTools: string[];
  body: string;
  bodyStartLine: number;
};

const BACKTICKED_TOKEN = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;

export function checkSkillToolReferences(
  entries: readonly ReferenceEntry[],
  vocab: ReferenceVocabulary
): ReferenceProblem[] {
  const problems: ReferenceProblem[] = [];
  for (const entry of entries) {
    const frontmatterTools = new Set([...entry.tools, ...entry.optionalTools]);

    for (const tool of entry.tools) {
      if (!vocab.declared.has(tool)) {
        problems.push({ skill: entry.name, token: tool, line: 1, reason: "unknown_tool" });
      }
    }
    for (const tool of entry.optionalTools) {
      if (!vocab.declared.has(tool) && !vocab.planned.has(tool)) {
        problems.push({ skill: entry.name, token: tool, line: 1, reason: "optional_not_declared" });
      }
    }

    // A fenced block is an example of output, HTML or config, not an instruction to call a tool, so
    // every fence is skipped unless its info string is markdown. Prose is always scanned.
    let inFence = false;
    let skipFence = false;
    entry.body.split("\n").forEach((text, index) => {
      const line = entry.bodyStartLine + index;
      const fence = /^\s*```\s*([a-zA-Z0-9_-]*)\s*$/.exec(text);
      if (fence) {
        if (!inFence) {
          const info = fence[1].toLowerCase();
          inFence = true;
          skipFence = info !== "markdown" && info !== "md";
        } else {
          inFence = false;
        }
        return;
      }
      if (inFence && skipFence) return;
      for (const match of text.matchAll(BACKTICKED_TOKEN)) {
        const token = match[1];
        if (vocab.terms.has(token)) continue;
        if (frontmatterTools.has(token)) continue;
        if (vocab.declared.has(token) || vocab.planned.has(token)) {
          problems.push({ skill: entry.name, token, line, reason: "not_in_frontmatter" });
          continue;
        }
        problems.push({ skill: entry.name, token, line, reason: "unknown_tool" });
      }
    });
  }
  return problems;
}
