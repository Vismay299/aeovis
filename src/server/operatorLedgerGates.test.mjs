import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R6.2.4 — section E of the operator ledger cannot go stale silently.
 *
 * "Standing gates by task id" is a hand-maintained list of the tasks that need a
 * human. R3.3.5 was filed twelve seconds before the previous revision of that
 * document was submitted, and so was absent from it on the day it shipped: a
 * gated task invisible in the operator's own list of gated tasks. Nothing was
 * false — section E tells the reader to count open work from
 * `orchestrate.mjs status` rather than from the table — but a list that goes
 * stale within the minute is a list nobody can trust to be complete.
 *
 * A hand-written list is corrected once and rots again. This is the mechanism
 * instead: the ledger of record is `.claude/orchestration/tasks.json`, so every
 * OPEN task carrying a human-gate tag must appear by id somewhere in
 * `docs/OPERATOR_LEDGER.md` — section A (worked now) or section E (standing).
 * Filing a new gated task without naming it there turns this test red.
 *
 * What it deliberately does NOT assert: where in the document an id appears, or
 * that what is written beside it is true. No test can check the second, and
 * pinning the first would make the document unrewritable.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LEDGER_MD = path.join(REPO, "docs/OPERATOR_LEDGER.md");
const TASKS_JSON = path.join(REPO, ".claude/orchestration/tasks.json");

/**
 * The five tags that mean "an agent cannot finish this alone". Pinned as
 * literals on purpose: read back out of tasks.json, the set would silently
 * shrink to whatever tags happen to be in use and this guard would stop
 * covering the tag nobody used this week.
 */
const GATE_TAGS = ["needs-secrets", "needs-vercel", "needs-decision", "needs-llm", "needs-soak"];

/** Task ids are dotted; `R3.3.5` must not be satisfied by `R3.3.50`. */
const idMention = (id) => new RegExp(`\\b${id.replace(/\./g, "\\.")}(?![.\\d])`);

async function ledgerTasks() {
  const parsed = JSON.parse(await readFile(TASKS_JSON, "utf8"));
  const tasks = parsed.tasks;
  assert.ok(Array.isArray(tasks) && tasks.length > 0, "tasks.json has no task array to read");
  return tasks;
}

const isGated = (t) => (t.tags || []).some((tag) => GATE_TAGS.includes(tag));

/** The text of one `## ` section, by the letter that opens its heading. */
function section(md, letter) {
  const start = md.search(new RegExp(`^## ${letter}\\. `, "m"));
  assert.notEqual(start, -1, `the ledger has no section ${letter} — this guard is reading the wrong shape`);
  const rest = md.slice(start + 1);
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
}

test("GUARD — the gate-tag vocabulary this guard uses is the one the ledger publishes", async () => {
  const md = await readFile(LEDGER_MD, "utf8");
  for (const tag of GATE_TAGS) {
    assert.match(
      md,
      new RegExp(`\`${tag}\``),
      `the ledger's rules name the human-gate tags; ${tag} is missing, so one of the two has drifted`
    );
  }

  // Anti-vacuity for every check below: if nothing in tasks.json carried a gate
  // tag, the loops in this file would iterate zero times and pass green while
  // section E covered nothing at all.
  const tasks = await ledgerTasks();
  const gated = tasks.filter(isGated);
  assert.ok(
    gated.length > 0,
    "no task in tasks.json carries any of " +
      GATE_TAGS.join("/") +
      " — either the tags were renamed or this guard is inspecting the wrong field; " +
      "an empty set here makes every assertion in this file vacuous"
  );
});

test("GUARD — every OPEN gated task is named in the operator ledger", async () => {
  const md = await readFile(LEDGER_MD, "utf8");
  const open = (await ledgerTasks()).filter((t) => isGated(t) && t.status !== "done");
  assert.ok(open.length > 0, "no open gated task at all — verify that before trusting a green run");

  const missing = open
    .filter((t) => !idMention(t.id).test(md))
    .map((t) => `${t.id} [${(t.tags || []).filter((g) => GATE_TAGS.includes(g)).join(",")}] ${t.title}`);

  assert.deepEqual(
    missing,
    [],
    "these tasks need a human and appear nowhere in docs/OPERATOR_LEDGER.md. Add each to § E " +
      "(or § A if it is being worked now) saying what the human must supply:\n  " +
      missing.join("\n  ")
  );
});

test("GUARD — a section E table row for a CLOSED task says so", async () => {
  const md = await readFile(LEDGER_MD, "utf8");
  const e = section(md, "E");
  const byId = new Map((await ledgerTasks()).map((t) => [t.id, t]));

  // Table rows only. Section E keeps two closed entries deliberately, each
  // labelled where it appears; prose paragraphs elsewhere in the section are not
  // inspected, because a paragraph is where the explanation of a closure lives
  // and a keyword match on it would be noise rather than a check.
  // Only the FIRST cell — the "Task" column — says what a row is ABOUT. The
  // second cell is prose and routinely cross-references other tasks (the R3.1.5
  // row names R3.3.2 as a symptom of it); reading ids out of there would demand
  // a CLOSED label on a row that is not about the closed task at all.
  const unlabelled = [];
  for (const line of e.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const subject = line.split("|")[1] || "";
    for (const id of subject.match(/\bR\d+(?:\.\d+)+/g) || []) {
      const task = byId.get(id);
      if (task?.status === "done" && !/CLOSED/.test(line)) unlabelled.push(id);
    }
  }

  assert.deepEqual(
    [...new Set(unlabelled)],
    [],
    "these section E rows describe work as outstanding that tasks.json records as done. Either " +
      "remove the row or label it CLOSED and say what the operator still owes, the way R0.1.20 and " +
      "R0.1.21 are labelled:\n  " +
      unlabelled.join("\n  ")
  );
});
