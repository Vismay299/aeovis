import test from "node:test";
import assert from "node:assert/strict";
import {
  PROMPT_SOURCE,
  STATIC_PACK_SOURCE,
  classifyPromptSource,
  PromptSourcingUnavailableError,
} from "./promptSource.js";
import { LlmUnavailableError, isLlmUnavailable } from "../llmErrors.js";

test("classifyPromptSource - an all-LLM set is llm_generated", () => {
  const out = classifyPromptSource([
    { text: "best tiles brand", source: "llm_generated" },
    { text: "top tile suppliers", source: "paa" },
  ]);
  assert.equal(out.prompt_source, PROMPT_SOURCE.LLM_GENERATED);
  assert.equal(out.static_pack_prompts, 0);
  assert.equal(out.total_prompts, 2);
});

test("STATIC PACK PATH — one industry-pack prompt marks the whole set static_industry_pack", () => {
  // This is the regression: the set below used to be published as if it had
  // been generated for the brand, with nothing recorded on the scan.
  const out = classifyPromptSource([
    { text: "best tiles brand", source: "llm_generated" },
    { text: "generic category question", source: STATIC_PACK_SOURCE },
  ]);
  assert.equal(out.prompt_source, PROMPT_SOURCE.STATIC_INDUSTRY_PACK);
  assert.equal(out.static_pack_prompts, 1);
  assert.equal(out.total_prompts, 2);
});

test("classifyPromptSource - an entirely static set is static_industry_pack", () => {
  const out = classifyPromptSource([
    { source: STATIC_PACK_SOURCE },
    { source: STATIC_PACK_SOURCE },
  ]);
  assert.equal(out.prompt_source, PROMPT_SOURCE.STATIC_INDUSTRY_PACK);
  assert.equal(out.static_pack_prompts, 2);
});

test("classifyPromptSource - an empty set reports null, never llm_generated", () => {
  // Measured-zero vs never-ran: no prompts is not a provenance claim.
  assert.deepEqual(classifyPromptSource([]), {
    prompt_source: null,
    static_pack_prompts: 0,
    total_prompts: 0,
  });
  assert.equal(classifyPromptSource(undefined).prompt_source, null);
});

test("ABORT PATH — PromptSourcingUnavailableError is typed, names the stage, and keeps the cause", () => {
  const cause = new LlmUnavailableError("LLM_API_KEY is not configured", {
    reason: "missing_key",
    provider: "openrouter",
  });
  const err = new PromptSourcingUnavailableError("Italica", cause);

  assert.ok(err instanceof LlmUnavailableError, "must stay recognisable as an LLM outage");
  assert.ok(isLlmUnavailable(err));
  assert.equal(err.name, "PromptSourcingUnavailableError");
  assert.equal(err.stage, "sourcing");
  assert.equal(err.reason, "missing_key", "the underlying reason survives the wrap");
  assert.equal(err.cause, cause);
  assert.match(err.message, /Italica/);
  assert.match(err.message, /industry pack/, "says WHY it aborted rather than degrading");
});

test("GUARD — STATIC_PACK_SOURCE still matches the literal promptGen.js stamps on pack prompts", async () => {
  // classifyPromptSource is a string match against a value produced in another
  // file. If someone renames "industry_fallback" in promptGen.js, provenance
  // silently reverts to reporting every scan as llm_generated — the exact
  // failure mode this task closes. Fail here instead.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./promptGen.js", import.meta.url), "utf8");
  assert.match(
    src,
    new RegExp(`source:\\s*"${STATIC_PACK_SOURCE}"`),
    `promptGen.js no longer stamps source: "${STATIC_PACK_SOURCE}" on industry-pack prompts — ` +
      `update STATIC_PACK_SOURCE in promptSource.js to match, or provenance will silently read llm_generated.`
  );
});
