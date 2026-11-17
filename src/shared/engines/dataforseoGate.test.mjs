import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DATAFORSEO_APPROVED_ENGINES } from "./engineRoutes.ts";

test("F02-AC-12: decision record exists, follows §6.8 template, and approved engines match DATAFORSEO_APPROVED_ENGINES", () => {
  const decisionsDir = path.resolve("docs/decisions");
  const files = readdirSync(decisionsDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}-dataforseo-answer-provider\.md$/.test(f))
    .sort();

  assert.ok(files.length > 0, "No dataforseo answer provider decision record found in docs/decisions/");

  const latestFile = files[files.length - 1];
  const content = readFileSync(path.join(decisionsDir, latestFile), "utf8");

  // Template headings check (§6.8)
  const requiredHeadings = [
    "# ADR — DataForSEO as an answer-engine provider",
    "## Context",
    "## Method",
    "## Results",
    "## Manual fidelity review",
    "## Terms of use",
    "## Decision per engine",
    "## Decision rules applied",
    "## Consequences",
    "## What is NOT verified",
  ];

  for (const heading of requiredHeadings) {
    assert.ok(
      content.includes(heading),
      `Decision record ${latestFile} is missing required heading "${heading}"`,
    );
  }

  // Parse approved engines line:
  // e.g. **Approved engines:** aio, chatgpt, gemini
  const match = content.match(/\*\*Approved engines:\*\*\s*([^\r\n]+)/i);
  assert.ok(match, "Decision record is missing '**Approved engines:**' line");

  const approvedEnginesFromDoc = match[1]
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .sort();

  const approvedEnginesFromCode = [...DATAFORSEO_APPROVED_ENGINES].sort();

  assert.deepEqual(
    approvedEnginesFromCode,
    approvedEnginesFromDoc,
    `Code DATAFORSEO_APPROVED_ENGINES (${approvedEnginesFromCode.join(",")}) does not match decision record (${approvedEnginesFromDoc.join(",")})`,
  );
});
