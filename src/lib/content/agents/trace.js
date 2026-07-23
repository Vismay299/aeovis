import { CREW, crewMember } from "./crew.js";

/**
 * Live agent trace — the data behind the theater. The worker maintains one
 * trace array per job and writes the whole array to content_jobs.agent_trace
 * on every step transition, so the UI can render each specialist lighting up
 * in real time (idle → working → done/failed) with what it's doing and a
 * one-line summary of what it produced.
 */

/** Fresh trace: all five specialists pending, in pipeline order. */
export function initTrace() {
  return CREW.map((c) => ({
    step: c.step,
    name: c.name,
    emoji: c.emoji,
    role: c.role,
    status: "pending",
    activity: "",
    summary: "",
    cycle: 0,
    started_at: null,
    finished_at: null,
  }));
}

function entry(trace, step) {
  return trace.find((t) => t.step === step);
}

export function markWorking(trace, step, activity, nowIso) {
  const e = entry(trace, step);
  if (!e) return trace;
  e.status = "working";
  e.activity = activity || crewMember(step).verb;
  if (!e.started_at) e.started_at = nowIso || new Date().toISOString();
  return trace;
}

export function markDone(trace, step, summary, nowIso) {
  const e = entry(trace, step);
  if (!e) return trace;
  e.status = "done";
  e.summary = summary || "";
  e.finished_at = nowIso || new Date().toISOString();
  return trace;
}

export function markFailed(trace, step, message, nowIso) {
  const e = entry(trace, step);
  if (!e) return trace;
  e.status = "failed";
  e.summary = message || "failed";
  e.finished_at = nowIso || new Date().toISOString();
  return trace;
}

/** Note a repeat pass (revision cycle) on a specialist without losing history. */
export function bumpCycle(trace, step, cycle) {
  const e = entry(trace, step);
  if (e) e.cycle = cycle;
  return trace;
}

// --- summary builders: the one-liners each specialist reports on completion ---

export function summarizeCoordinate(workOrder) {
  const tq = (workOrder?.target_queries || []).length;
  const fo = (workOrder?.fan_out || []).length;
  const bits = [`Angle: "${(workOrder?.angle || "").slice(0, 80)}"`];
  if (tq) bits.push(`${tq} target ${tq === 1 ? "query" : "queries"}`);
  if (fo) bits.push(`${fo} sub-queries`);
  if (workOrder?.hook_thesis) bits.push(`hook set`);
  return bits.join(" · ");
}

export function summarizeResearch(pack) {
  const s = (pack?.sources || []).length;
  const st = (pack?.stats || []).length;
  const q = (pack?.quotes || []).length;
  const parts = [`${s} ${s === 1 ? "source" : "sources"}`, `${st} sourced ${st === 1 ? "stat" : "stats"}`];
  if (q) parts.push(`${q} ${q === 1 ? "quote" : "quotes"}`);
  const unsupported = (pack?.unsupported_subqueries || []).length;
  if (unsupported) parts.push(`${unsupported} unsupported flagged`);
  return parts.join(", ");
}

export function summarizeBenchmark(notes, playbook) {
  if (playbook === "linkedin_post") return "Channel best-practice pack loaded";
  if (notes?.directive) {
    const dom = notes.dominant_format && notes.dominant_format !== "unknown" ? `${notes.dominant_format} dominates → ` : "";
    return `${dom}${notes.directive}`.slice(0, 140);
  }
  return "Teardown complete";
}

export function summarizeDraft(draft, cycle) {
  const words = String(draft?.body_md || "").trim().split(/\s+/).filter(Boolean).length;
  const rev = cycle > 1 ? ` (redraft ${cycle})` : "";
  return `"${(draft?.title || "untitled").slice(0, 60)}" — ${words} words${rev}`;
}

export function summarizeReview(review) {
  const bits = [`Scored ${review?.weighted_total ?? "?"} — ${review?.verdict || "?"}`];
  if (review?.ymyl_violation) bits.push("YMYL flag");
  const v = (review?.violations || []).length;
  if (v && !review?.ymyl_violation) bits.push(`${v} ${v === 1 ? "issue" : "issues"}`);
  return bits.join(", ");
}
