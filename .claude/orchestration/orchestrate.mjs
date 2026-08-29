#!/usr/bin/env node
/**
 * Rebuild orchestration ledger CLI.
 *
 * The single writer for .claude/orchestration/tasks.json. Agents never edit the
 * JSON by hand — they call this, so the state machine and the evidence rule are
 * enforced by code rather than by an agent remembering to follow them.
 *
 * The evidence rule is standing rule 6 from the roadmap, made mechanical:
 * a task cannot reach `done` without a passing verification and at least one
 * file:line citation. That is the rule that turned Joveo's plan into a product.
 *
 * Usage:
 *   node .claude/orchestration/orchestrate.mjs status [--phase R0]
 *   node .claude/orchestration/orchestrate.mjs next [--phase R0] [--lane backend] [--limit 5]
 *   node .claude/orchestration/orchestrate.mjs show <id>
 *   node .claude/orchestration/orchestrate.mjs claim <id> --agent <name>
 *   node .claude/orchestration/orchestrate.mjs submit <id> --evidence <f:l,f:l> [--note "..."]
 *   node .claude/orchestration/orchestrate.mjs verify <id> --verdict pass|fail [--note "..."]
 *   node .claude/orchestration/orchestrate.mjs block <id> --reason <code> [--note "..."]
 *   node .claude/orchestration/orchestrate.mjs unblock <id> [--note "..."]
 *   node .claude/orchestration/orchestrate.mjs add <--json '{...}'>
 *   node .claude/orchestration/orchestrate.mjs rule --add "<text>"
 *   node .claude/orchestration/orchestrate.mjs amend <id> --note "..." [--anchors f:l]
 *   node .claude/orchestration/orchestrate.mjs render
 *   node .claude/orchestration/orchestrate.mjs validate
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const LEDGER = path.join(HERE, "tasks.json");
const TRACKER = path.join(REPO, "docs/plans/2026-08-29-rebuild-roadmap.md");

const STATUSES = ["todo", "in_progress", "in_verification", "done", "blocked"];

const LOCK = LEDGER + ".lock";

/**
 * Concurrent workers all call claim/submit, so read-modify-write on one JSON
 * file races: two claims a millisecond apart and one silently loses. Found the
 * first time workers ran in parallel. An exclusive lockfile plus an atomic
 * rename makes the ledger safe to share; without it the audit trail is the
 * thing that gets corrupted, which defeats the point of having one.
 */
function withLock(fn) {
  const deadline = Date.now() + 15000;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(LOCK, "wx");
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Reap a lock orphaned by a killed process rather than deadlocking.
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > 30000) fs.unlinkSync(LOCK);
      } catch {}
      if (Date.now() > deadline) die("timed out waiting for the ledger lock");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(LOCK);
    } catch {}
  }
}

function load() {
  return JSON.parse(fs.readFileSync(LEDGER, "utf8"));
}

/** Atomic: write a temp file and rename, so a crash mid-write cannot truncate. */
function save(g) {
  const tmp = `${LEDGER}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(g, null, 2) + "\n");
  fs.renameSync(tmp, LEDGER);
}
/**
 * Throws rather than exiting: `die` is called from inside withLock, and
 * process.exit() skips the `finally` that releases the lockfile — which left
 * every other waiter to block until the 30s orphan reap. Caught at top level.
 */
class Died extends Error {}
function die(msg) {
  throw new Died(msg);
}
function stamp() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i] ?? true;
    else positional.push(argv[i]);
  }
  return { flags, positional };
}

function find(g, id) {
  const t = g.tasks.find((t) => t.id === id);
  if (!t) die(`no such task: ${id}`);
  return t;
}

/** A task is ready when every dependency is done and nothing blocks it. */
function readiness(g, t) {
  if (t.status === "done") return { ready: false, why: "done" };
  if (t.status === "blocked") return { ready: false, why: `blocked: ${t.blocked_reason}` };
  const byId = Object.fromEntries(g.tasks.map((x) => [x.id, x]));
  const pending = t.deps.filter((d) => byId[d].status !== "done");
  if (pending.length) return { ready: false, why: `waiting on ${pending.join(", ")}` };
  if (t.tags.length) return { ready: true, why: `ready, but gated: ${t.tags.join(", ")}`, gated: true };
  return { ready: true, why: "ready" };
}

const cmds = {
  status(g, { flags }) {
    const tasks = flags.phase ? g.tasks.filter((t) => t.phase === flags.phase) : g.tasks;
    const counts = {};
    for (const s of STATUSES) counts[s] = tasks.filter((t) => t.status === s).length;
    const scope = flags.phase ? `phase ${flags.phase}` : "all phases";
    console.log(`Rebuild ledger — ${scope}: ${tasks.length} tasks`);
    console.log(
      STATUSES.map((s) => `  ${s.padEnd(16)} ${String(counts[s]).padStart(3)}`).join("\n")
    );
    const ready = tasks.filter((t) => readiness(g, t).ready && t.status === "todo");
    const open = ready.filter((t) => !t.tags.length);
    console.log(`\n  ready now        ${String(open.length).padStart(3)}`);
    console.log(`  ready but gated  ${String(ready.length - open.length).padStart(3)}`);
    for (const p of g.phases) {
      const pt = g.tasks.filter((t) => t.phase === p.id);
      const d = pt.filter((t) => t.status === "done").length;
      const bar = "#".repeat(Math.round((d / pt.length) * 20)).padEnd(20, ".");
      console.log(`  ${p.id} ${bar} ${String(d).padStart(3)}/${pt.length}  ${p.title}`);
    }
  },

  next(g, { flags }) {
    let tasks = g.tasks.filter((t) => t.status === "todo");
    if (flags.phase) tasks = tasks.filter((t) => t.phase === flags.phase);
    if (flags.lane) tasks = tasks.filter((t) => t.lane === flags.lane);
    const ready = tasks
      .map((t) => ({ t, r: readiness(g, t) }))
      .filter(({ r }) => r.ready)
      .filter(({ r }) => (flags.gated ? true : !r.gated));
    const limit = Number(flags.limit || 10);
    if (!ready.length) {
      console.log("no ready tasks in scope");
      return;
    }
    for (const { t, r } of ready.slice(0, limit)) {
      console.log(`${t.id}  [${t.lane}]  ${t.title}`);
      console.log(`    ${r.why}`);
    }
    if (ready.length > limit) console.log(`... and ${ready.length - limit} more`);
  },

  show(g, { positional }) {
    const t = find(g, positional[0]);
    const r = readiness(g, t);
    console.log(JSON.stringify({ ...t, readiness: r }, null, 2));
  },

  claim(g, { positional, flags }) {
    const t = find(g, positional[0]);
    if (!flags.agent) die("--agent is required");
    const r = readiness(g, t);
    if (!r.ready) die(`${t.id} is not ready: ${r.why}`);
    if (t.status === "in_progress") die(`${t.id} already claimed by ${t.owner}`);
    t.status = "in_progress";
    t.owner = String(flags.agent);
    t.notes.push({ at: stamp(), by: String(flags.agent), text: "claimed" });
    save(g);
    console.log(`${t.id} claimed by ${flags.agent}`);
  },

  /** Implementer hands off to verification. Evidence is mandatory here, not at done. */
  submit(g, { positional, flags }) {
    const t = find(g, positional[0]);
    if (t.status !== "in_progress") die(`${t.id} is ${t.status}, expected in_progress`);
    const evidence = String(flags.evidence || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!evidence.length) die("--evidence is required: one or more file:line citations");
    const bad = evidence.filter((e) => !/^[^\s:]+:\d+(-\d+)?$/.test(e) && !/^[^\s:]+$/.test(e));
    if (bad.length) die(`evidence must be file or file:line — bad: ${bad.join(", ")}`);
    const missing = evidence
      .map((e) => e.split(":")[0])
      .filter((f) => !fs.existsSync(path.join(REPO, f)));
    if (missing.length) die(`evidence cites files that do not exist: ${missing.join(", ")}`);
    t.evidence = evidence;
    t.status = "in_verification";
    if (flags.note) t.notes.push({ at: stamp(), by: t.owner, text: String(flags.note) });
    save(g);
    console.log(`${t.id} submitted for verification with ${evidence.length} citation(s)`);
  },

  /** Only the verifier closes a task. A fail sends it back to the implementer. */
  verify(g, { positional, flags }) {
    const t = find(g, positional[0]);
    if (t.status !== "in_verification") die(`${t.id} is ${t.status}, expected in_verification`);
    const verdict = String(flags.verdict || "");
    if (!["pass", "fail"].includes(verdict)) die("--verdict must be pass or fail");
    t.verification = { verdict, at: stamp(), note: flags.note ? String(flags.note) : null };
    if (verdict === "pass") {
      t.status = "done";
      console.log(`${t.id} verified and closed — evidence: ${t.evidence.join(", ")}`);
    } else {
      t.status = "in_progress";
      t.notes.push({ at: stamp(), by: "verifier", text: `rejected: ${flags.note || "no reason given"}` });
      console.log(`${t.id} rejected, returned to ${t.owner}`);
    }
    save(g);
  },

  block(g, { positional, flags }) {
    const t = find(g, positional[0]);
    const reason = String(flags.reason || "");
    if (!Object.keys(g.block_reasons).includes(reason))
      die(`--reason must be one of: ${Object.keys(g.block_reasons).join(", ")}`);
    t.status = "blocked";
    t.blocked_reason = reason;
    t.notes.push({ at: stamp(), by: t.owner || "controller", text: `blocked (${reason}): ${flags.note || ""}` });
    save(g);
    console.log(`${t.id} blocked: ${reason}`);
  },

  unblock(g, { positional, flags }) {
    const t = find(g, positional[0]);
    if (t.status !== "blocked") die(`${t.id} is ${t.status}, not blocked`);
    t.status = "todo";
    delete t.blocked_reason;
    t.notes.push({ at: stamp(), by: "controller", text: `unblocked: ${flags.note || ""}` });
    save(g);
    console.log(`${t.id} unblocked`);
  },

  /**
   * Append a standing rule. The tracker is generated from `standing_rules`, so
   * without this the only way to add one was to hand-edit the ledger — which the
   * agent protocol forbids. Found by the first controller run.
   */
  rule(g, { flags }) {
    if (!flags.add) die('--add "<rule text>" is required');
    const text = String(flags.add).trim();
    if (g.standing_rules.includes(text)) die("that rule is already in force");
    g.standing_rules.push(text);
    save(g);
    console.log(`standing rule ${g.standing_rules.length} added — run render to publish it`);
  },

  /**
   * File a new task. Follow-ups discovered mid-rebuild belong in the ledger, not
   * in a report nobody re-reads. Takes the same shape as a tasks.json entry.
   */
  add(g, { flags }) {
    if (!flags.json) die("--json '<task object>' is required");
    let t;
    try {
      t = JSON.parse(String(flags.json));
    } catch (e) {
      die(`--json is not valid JSON: ${e.message}`);
    }
    for (const f of ["id", "subphase", "lane", "title", "detail", "accept"])
      if (!t[f]) die(`task is missing required field: ${f}`);
    if (g.tasks.some((x) => x.id === t.id)) die(`task ${t.id} already exists`);
    if (!Object.keys(g.lanes).includes(t.lane))
      die(`unknown lane ${t.lane} — one of: ${Object.keys(g.lanes).join(", ")}`);
    t.phase = t.id.split(".")[0];
    if (!g.phases.some((p) => p.id === t.phase)) die(`unknown phase ${t.phase}`);
    t.deps = t.deps || [];
    for (const d of t.deps)
      if (!g.tasks.some((x) => x.id === d)) die(`unknown dependency ${d}`);
    t.tags = t.tags || [];
    for (const tag of t.tags)
      if (!Object.keys(g.block_reasons).includes(tag)) die(`unknown tag ${tag}`);
    Object.assign(t, {
      findings: t.findings || [],
      anchors: t.anchors || [],
      status: "todo",
      owner: null,
      evidence: [],
      notes: [{ at: stamp(), by: "controller", text: "filed mid-rebuild" }],
      verification: null,
    });
    g.tasks.push(t);
    g.tasks.sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" })
    );
    save(g);
    console.log(`${t.id} filed in ${t.phase} [${t.lane}]`);
  },

  /**
   * Refine a task's evidence as it is discovered — appends to `detail` and
   * `anchors` only. It deliberately CANNOT touch `accept`: moving an acceptance
   * criterion to fit what was built is the failure this ledger exists to stop.
   * A criterion that is genuinely wrong needs a new task, not a quiet edit.
   */
  amend(g, { positional, flags }) {
    const t = find(g, positional[0]);
    if (flags.accept) die("`accept` is immutable — file a new task instead of moving the goalposts");
    if (!flags.note && !flags.anchors) die("--note and/or --anchors is required");
    if (flags.note) {
      t.detail += ` ${String(flags.note)}`;
      t.notes.push({ at: stamp(), by: "controller", text: `amended: ${flags.note}` });
    }
    if (flags.anchors)
      for (const a of String(flags.anchors).split(",").map((x) => x.trim()).filter(Boolean))
        if (!t.anchors.includes(a)) t.anchors.push(a);
    save(g);
    console.log(`${t.id} amended (accept unchanged)`);
  },

  validate(g) {
    const ids = new Set(g.tasks.map((t) => t.id));
    const problems = [];
    for (const t of g.tasks) {
      if (!STATUSES.includes(t.status)) problems.push(`${t.id}: bad status ${t.status}`);
      for (const d of t.deps) if (!ids.has(d)) problems.push(`${t.id}: unknown dep ${d}`);
      if (t.status === "done" && !t.evidence.length) problems.push(`${t.id}: done with no evidence`);
      if (t.status === "done" && t.verification?.verdict !== "pass")
        problems.push(`${t.id}: done without a passing verification`);
      for (const tag of t.tags)
        if (!Object.keys(g.block_reasons).includes(tag)) problems.push(`${t.id}: unknown tag ${tag}`);
    }
    const seen = {};
    const walk = (id, trail) => {
      if (seen[id] === "closed") return;
      if (seen[id] === "open") return problems.push(`cycle: ${trail.concat(id).join(" -> ")}`);
      seen[id] = "open";
      for (const d of g.tasks.find((t) => t.id === id).deps) walk(d, trail.concat(id));
      seen[id] = "closed";
    };
    for (const t of g.tasks) walk(t.id, []);
    if (problems.length) {
      problems.forEach((p) => console.error(`  ${p}`));
      process.exit(1);
    }
    console.log(`ledger valid: ${g.tasks.length} tasks, ${g.phases.length} phases`);
  },

  /** The human tracker is generated, never hand-edited — so it cannot drift. */
  render(g) {
    const mark = (t) =>
      ({ done: "[x]", blocked: "[-]", in_progress: "[~]", in_verification: "[~]", todo: "[ ]" }[t.status]);
    const out = [];
    out.push("# Rebuild roadmap — R0-R6");
    out.push("");
    out.push("> Status: **LIVE**. Generated from `.claude/orchestration/tasks.json` by");
    out.push("> `node .claude/orchestration/orchestrate.mjs render`. Do not hand-edit —");
    out.push("> edits belong in the ledger, which the orchestration CLI is the only writer for.");
    out.push("");
    out.push(`Source: ${g.source.plan}`);
    out.push(`Companion: ${g.source.companion}`);
    out.push(`Baseline commit: \`${g.source.baseline_commit}\``);
    out.push("");
    const done = g.tasks.filter((t) => t.status === "done").length;
    const blocked = g.tasks.filter((t) => t.status === "blocked").length;
    out.push(`**${done} / ${g.tasks.length} closed** · ${blocked} blocked · legend: \`[x]\` done · \`[~]\` in flight · \`[-]\` blocked · \`[ ]\` open`);
    out.push("");
    out.push("## Standing rules");
    out.push("");
    g.standing_rules.forEach((r, i) => out.push(`${i + 1}. ${r}`));
    out.push("");
    for (const p of g.phases) {
      const pt = g.tasks.filter((t) => t.phase === p.id);
      const pd = pt.filter((t) => t.status === "done").length;
      out.push(`## ${p.id} — ${p.title}  \`${pd}/${pt.length}\``);
      out.push("");
      out.push(`*${p.estimate}.* ${p.why}`);
      out.push("");
      let sub = null;
      for (const t of pt) {
        if (t.subphase !== sub) {
          sub = t.subphase;
          out.push(`### ${sub}`);
          out.push("");
        }
        const tags = t.tags.length ? ` \`${t.tags.join("` `")}\`` : "";
        // Label evidence by state. A task in verification has *submitted*
        // citations, not closed ones — rendering "closed at" on unclosed work
        // is precisely the false-success class this rebuild exists to remove,
        // and the tracker is not exempt from its own standard.
        const evLabel = t.status === "done" ? "closed at" : "submitted";
        const ev = t.evidence.length
          ? ` — ${evLabel} ${t.evidence.map((e) => `\`${e}\``).join(", ")}`
          : "";
        const blockNote = t.status === "blocked" ? ` — blocked: ${t.blocked_reason}` : "";
        out.push(`- ${mark(t)} **${t.id}** ${t.title}${tags}${ev}${blockNote}`);
      }
      out.push("");
    }
    fs.mkdirSync(path.dirname(TRACKER), { recursive: true });
    fs.writeFileSync(TRACKER, out.join("\n") + "\n");
    console.log(`rendered ${path.relative(REPO, TRACKER)} (${done}/${g.tasks.length} closed)`);
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || !cmds[cmd]) {
  console.error(`usage: orchestrate.mjs <${Object.keys(cmds).join("|")}> [args]`);
  process.exit(1);
}
const MUTATES = ["claim", "submit", "verify", "block", "unblock", "add", "rule", "amend"];
const args = parseArgs(rest);
try {
  if (MUTATES.includes(cmd)) {
    // Re-read INSIDE the lock: a copy loaded before waiting is already stale.
    withLock(() => cmds[cmd](load(), args));
  } else {
    cmds[cmd](load(), args);
  }
} catch (e) {
  if (e instanceof Died) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
