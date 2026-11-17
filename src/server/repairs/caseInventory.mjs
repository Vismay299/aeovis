/**
 * R21.1b — the declared acceptance-scenario inventory, as data.
 *
 * WHY THIS IS A MODULE AND NOT A LIST IN THE RUNNER
 * The backlog names 404 acceptance scenarios across 21 repairs. A runner that
 * hard-codes "which ids exist" cannot tell a case that was never implemented
 * from one whose id was typed wrong, and "unimplemented" and "typo" need
 * different fixes. So the declaration lives here, the runner reads it, and
 * `validateInventory` is the one place that decides whether a registration is
 * well-formed.
 *
 * IDS ARE GENERATED, COUNTS ARE VALIDATED. Writing 404 id literals by hand
 * guarantees a transcription error that no test can see, because the same hand
 * writes the expectation. Here each id is generated from its repair's declared
 * count (`R01` x16 -> R01-01..R01-16), and two independent tables are
 * cross-checked instead: the execution index's case counts, and section F's
 * per-level allocation. A repair whose levels do not add up to its case count,
 * or whose letters disagree with the allocation table, throws at validation
 * time rather than silently mis-selecting what a suite runs.
 *
 * LEVELS COME FROM THE CASE TABLES, NOT FROM THE ALLOCATION. Section F says how
 * many U/I/D/B/L/M/S cases a repair has; only the repair's own case table says
 * which id is which. The run strings below are transcribed from those tables in
 * id order and are checked against section F by `validateInventory`, so a
 * mis-transcribed letter that changes a count is caught. A swap that preserves
 * every count is not, and cannot be — which is why the run strings are written
 * in runs (e.g. "U8 D2 I3") instead of one 24-character blur.
 */

/** Cases per repair, from the backlog's execution index. */
export const REPAIR_CASE_COUNTS = Object.freeze({
  R01: 16,
  R02: 24,
  R03: 18,
  R04: 24,
  R05: 24,
  R06: 16,
  R07: 16,
  R08: 20,
  R09: 18,
  R10: 16,
  R11: 18,
  R12: 20,
  R13: 16,
  R14: 18,
  R15: 24,
  R16: 18,
  R17: 20,
  R18: 20,
  R19: 24,
  R20: 16,
  R21: 18,
});

/** Total scenarios the backlog declares. Every count above is checked against this sum. */
export const DECLARED_TOTAL = 404;

/**
 * Section F's test-level allocation per repair: how many U/I/D/B/L/M/S cases
 * each repair has. Kept verbatim as the second table the run strings are
 * checked against.
 */
export const REPAIR_LEVEL_ALLOCATION = Object.freeze({
  R01: { U: 8, I: 5, D: 1, B: 1, L: 1, M: 0, S: 0 },
  R02: { U: 6, I: 4, D: 13, B: 1, L: 0, M: 0, S: 0 },
  R03: { U: 8, I: 5, D: 2, B: 3, L: 0, M: 0, S: 0 },
  R04: { U: 14, I: 7, D: 1, B: 0, L: 2, M: 0, S: 0 },
  R05: { U: 16, I: 4, D: 2, B: 2, L: 0, M: 0, S: 0 },
  R06: { U: 4, I: 7, D: 4, B: 1, L: 0, M: 0, S: 0 },
  R07: { U: 5, I: 3, D: 0, B: 8, L: 0, M: 0, S: 0 },
  R08: { U: 15, I: 2, D: 1, B: 2, L: 0, M: 0, S: 0 },
  R09: { U: 6, I: 8, D: 0, B: 0, L: 0, M: 4, S: 0 },
  R10: { U: 5, I: 6, D: 1, B: 2, L: 2, M: 0, S: 0 },
  R11: { U: 4, I: 4, D: 4, B: 2, L: 0, M: 0, S: 4 },
  R12: { U: 4, I: 5, D: 0, B: 5, L: 3, M: 1, S: 2 },
  R13: { U: 0, I: 5, D: 0, B: 11, L: 0, M: 0, S: 0 },
  R14: { U: 7, I: 4, D: 3, B: 4, L: 0, M: 0, S: 0 },
  R15: { U: 8, I: 10, D: 0, B: 2, L: 3, M: 1, S: 0 },
  R16: { U: 7, I: 6, D: 2, B: 3, L: 0, M: 0, S: 0 },
  R17: { U: 7, I: 7, D: 3, B: 3, L: 0, M: 0, S: 0 },
  R18: { U: 3, I: 6, D: 7, B: 4, L: 0, M: 0, S: 0 },
  R19: { U: 10, I: 6, D: 4, B: 2, L: 2, M: 0, S: 0 },
  R20: { U: 3, I: 4, D: 0, B: 4, L: 3, M: 2, S: 0 },
  R21: { U: 3, I: 8, D: 3, B: 2, L: 0, M: 2, S: 0 },
});

/**
 * Each repair's cases as level runs, in id order, read from the repair's own
 * case table in the backlog. `"U3 I1 U4"` is R01-01..03 U, R01-04 I, R01-05..08 U.
 */
const REPAIR_LEVEL_RUNS = Object.freeze({
  R01: "U3 I1 U4 I4 D1 U1 B1 L1",
  R02: "U6 D10 I2 D2 I1 D1 I1 B1",
  R03: "U8 D2 I3 B3 I2",
  R04: "U14 I6 D1 I1 L2",
  R05: "U16 I2 D2 I1 B2 I1",
  R06: "U4 I4 D3 I1 D1 B1 I2",
  R07: "U5 I3 B8",
  R08: "U15 I2 D1 B2",
  R09: "U6 I6 M3 I1 M1 I1",
  R10: "U3 I4 U1 I2 D1 U1 B2 L2",
  R11: "U4 D3 I3 D1 B2 I1 S4",
  R12: "U4 I4 B5 I1 L3 M1 S2",
  R13: "I5 B11",
  R14: "U7 D3 I3 B4 I1",
  R15: "U8 I10 B2 L2 M1 L1",
  R16: "U7 I4 D2 B3 I2",
  R17: "U7 I5 D2 I1 D1 B3 I1",
  R18: "U3 I3 D7 I3 B4",
  R19: "U8 I4 D4 U2 I2 B2 L2",
  R20: "U3 I4 B3 M2 L3 B1",
  R21: "U2 I6 D1 I1 U1 D2 M1 B2 I1 M1",
});

/** The test levels, weakest first. */
export const LEVELS = Object.freeze(["U", "I", "D", "B", "L", "M", "S"]);

/**
 * Which levels a suite executes. `offline` runs only U and I, which is also the
 * reason a live-level case cannot be smuggled into it by asking for its id.
 */
export const SUITE_LEVELS = Object.freeze({
  offline: Object.freeze(["U", "I"]),
  database: Object.freeze(["D"]),
  browser: Object.freeze(["B"]),
  live: Object.freeze(["L"]),
  soak: Object.freeze(["S"]),
});

/** Suites a run may select. `release` aggregates the others; see `suitesForRepair`. */
export const SUITES = Object.freeze([...Object.keys(SUITE_LEVELS), "release"]);

/** Suites whose evidence a run has to produce itself, as opposed to aggregate. */
export const EXECUTED_SUITES = Object.freeze(Object.keys(SUITE_LEVELS));

/**
 * Human adjudication is a required piece of release evidence (M) but is not a
 * suite the runner can execute: a signed review has no dispatcher.
 */
export const MANUAL_SUITE = "manual";

/** Every repair id in declaration order. */
export const REPAIRS = Object.freeze(Object.keys(REPAIR_CASE_COUNTS));

const CASE_ID = /^(R\d{2})-(\d{2})$/;

/** The repair part of a case id, or null when the id is not shaped like one. */
export function repairOf(caseId) {
  const match = CASE_ID.exec(String(caseId ?? "").trim());
  return match ? match[1] : null;
}

function expandRuns(repair) {
  const runs = REPAIR_LEVEL_RUNS[repair];
  if (!runs) throw new Error(`repairLevelRuns: no level runs declared for ${repair}`);
  const levels = [];
  for (const token of runs.trim().split(/\s+/)) {
    const match = /^([UIDBLMS])(\d+)$/.exec(token);
    if (!match) throw new Error(`repairLevelRuns(${repair}): "${token}" is not a <level><count> run`);
    const count = Number(match[2]);
    if (count < 1) throw new Error(`repairLevelRuns(${repair}): "${token}" has a run of zero`);
    for (let i = 0; i < count; i++) levels.push(match[1]);
  }
  const declared = REPAIR_CASE_COUNTS[repair];
  if (levels.length !== declared) {
    throw new Error(
      `repairLevelRuns(${repair}): the level runs cover ${levels.length} cases but the repair declares ${declared}`
    );
  }
  return Object.freeze(levels);
}

const LEVELS_BY_REPAIR = new Map(REPAIRS.map((repair) => [repair, expandRuns(repair)]));

const INVENTORY = Object.freeze(
  REPAIRS.flatMap((repair) =>
    LEVELS_BY_REPAIR.get(repair).map((level, index) =>
      Object.freeze({ id: `${repair}-${String(index + 1).padStart(2, "0")}`, repair, level })
    )
  )
);

const BY_ID = new Map(INVENTORY.map((entry) => [entry.id, entry]));

/** The declared inventory: one frozen `{ id, repair, level }` per scenario. */
export function declaredInventory() {
  return INVENTORY;
}

/** Every declared case id, in repair then numeric order. */
export function allCaseIds() {
  return INVENTORY.map((entry) => entry.id);
}

/** The declared ids for one repair, e.g. R05-01..R05-24. */
export function caseIdsForRepair(repair) {
  return INVENTORY.filter((entry) => entry.repair === repair).map((entry) => entry.id);
}

/** The declared level of a case id, or null when the id is not declared. */
export function levelForCase(caseId) {
  return BY_ID.get(String(caseId ?? "").trim())?.level ?? null;
}

/** The ids of a repair that one suite executes. */
export function casesForSuite(repair, suite) {
  const levels = SUITE_LEVELS[suite];
  if (!levels) throw new Error(`casesForSuite: ${suite} is not an executed suite`);
  return INVENTORY.filter((entry) => entry.repair === repair && levels.includes(entry.level)).map((e) => e.id);
}

/**
 * Every suite that has to produce evidence before a repair can be called done:
 * the executed suites whose levels the repair actually uses, plus `manual` when
 * it has M cases. A suite with no cases for this repair is not required — and a
 * required suite that never runs is what makes a release unverified.
 */
export function suitesForRepair(repair) {
  const allocation = REPAIR_LEVEL_ALLOCATION[repair];
  if (!allocation) throw new Error(`suitesForRepair: unknown repair ${repair}`);
  const required = [];
  for (const suite of EXECUTED_SUITES) {
    if (SUITE_LEVELS[suite].some((level) => allocation[level] > 0)) required.push(suite);
  }
  if (allocation.M > 0) required.push(MANUAL_SUITE);
  return required;
}

/** Section F's allocation for a repair, as a copy. */
export function levelAllocationForRepair(repair) {
  return { ...(REPAIR_LEVEL_ALLOCATION[repair] ?? {}) };
}

/**
 * The declared inventory as `{cases: [ids]}` — the shape the runner accepts for
 * `--inventory`, so a corrupted registration can be replayed without editing
 * the declaration. Unknown ids come back as null levels and are reported.
 */
export function inventoryFromIds(ids) {
  return ids.map((id) => ({ id: String(id).trim(), repair: repairOf(id), level: levelForCase(id) }));
}

function tallyLevels(entries) {
  const tally = Object.fromEntries(LEVELS.map((level) => [level, 0]));
  for (const entry of entries) if (entry.level && tally[entry.level] !== undefined) tally[entry.level] += 1;
  return tally;
}

/**
 * Validate a set of `{ id, repair, level }` registrations against the
 * declaration. Returns every problem rather than the first, because "the
 * inventory is wrong" is not actionable and "R05-02 is registered twice" is.
 *
 * @returns {{ok: boolean, total: number, unique: number, duplicates: string[],
 *   missing: string[], unexpected: string[], perRepair: Record<string, number>,
 *   errors: string[]}}
 */
export function validateInventory(entries = INVENTORY) {
  const errors = [];
  if (!Array.isArray(entries)) {
    return {
      ok: false,
      total: 0,
      unique: 0,
      duplicates: [],
      missing: [],
      unexpected: [],
      perRepair: {},
      errors: [`the inventory is not an array of case registrations (got ${typeof entries})`],
    };
  }

  const seen = new Map();
  const duplicates = [];
  const unexpected = [];
  const perRepair = {};
  for (const [index, entry] of entries.entries()) {
    const id = entry && typeof entry === "object" ? entry.id : entry;
    if (typeof id !== "string" || !CASE_ID.test(id.trim())) {
      errors.push(`entries[${index}] is not a case id: ${JSON.stringify(entry)}`);
      continue;
    }
    const clean = id.trim();
    const repair = repairOf(clean);
    if (!REPAIR_CASE_COUNTS[repair]) {
      errors.push(`${clean} names repair ${repair}, which the declaration does not contain`);
      unexpected.push(clean);
      continue;
    }
    const times = (seen.get(clean) ?? 0) + 1;
    seen.set(clean, times);
    if (times === 2) {
      duplicates.push(clean);
      errors.push(`${clean} is registered twice; every acceptance scenario has exactly one id`);
    }
    perRepair[repair] = (perRepair[repair] ?? 0) + 1;
    const declaredLevel = levelForCase(clean);
    if (declaredLevel === null) {
      errors.push(`${clean} is not one of the declared ${repair} case ids`);
    } else if (entry && typeof entry === "object" && entry.level && entry.level !== declaredLevel) {
      errors.push(`${clean} is registered at level ${entry.level}, but the case table declares ${declaredLevel}`);
    }
  }

  const missing = [];
  const declaredIds = allCaseIds();
  for (const id of declaredIds) if (!seen.has(id)) missing.push(id);
  if (missing.length) {
    const byRepair = new Map();
    for (const id of missing) {
      const repair = repairOf(id);
      if (!byRepair.has(repair)) byRepair.set(repair, []);
      byRepair.get(repair).push(id);
    }
    for (const [repair, ids] of byRepair) {
      errors.push(
        `${repair} is missing ${ids.length} of its ${REPAIR_CASE_COUNTS[repair]} case ids: ${ids.join(", ")}`
      );
    }
  }

  for (const id of seen.keys()) if (!BY_ID.has(id)) unexpected.push(id);
  for (const repair of REPAIRS) {
    const registered = perRepair[repair] ?? 0;
    if (registered > REPAIR_CASE_COUNTS[repair]) {
      errors.push(`${repair} registers ${registered} case ids, but the backlog gives it ${REPAIR_CASE_COUNTS[repair]}`);
    }
  }

  if (entries.length !== DECLARED_TOTAL) {
    errors.push(`the inventory holds ${entries.length} scenarios, not the declared ${DECLARED_TOTAL}`);
  }

  // The second table: the level letters must agree with section F's allocation.
  if (!missing.length && !duplicates.length) {
    for (const repair of REPAIRS) {
      const tally = tallyLevels(entries.filter((e) => repairOf(e.id ?? "") === repair));
      const allocation = REPAIR_LEVEL_ALLOCATION[repair];
      for (const level of LEVELS) {
        if ((tally[level] ?? 0) !== allocation[level]) {
          errors.push(
            `${repair} level allocation disagrees with the backlog table: ${level}=${tally[level] ?? 0}, ` +
              `expected ${level}=${allocation[level]}`
          );
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    total: entries.length,
    unique: seen.size,
    duplicates,
    missing,
    unexpected,
    perRepair,
    errors,
  };
}

/** Same as `validateInventory`, but a broken declaration throws instead of returning. */
export function assertInventory(entries = INVENTORY) {
  const report = validateInventory(entries);
  if (!report.ok) {
    throw new Error(`case inventory is invalid:\n  ${report.errors.join("\n  ")}`);
  }
  return report;
}

/**
 * The declaration is validated at import time, on purpose: a runner that boots
 * on a broken inventory and then reports "unimplemented" would be inventing
 * evidence from a table it never checked.
 */
export const DECLARED_INVENTORY_REPORT = Object.freeze(assertInventory(INVENTORY));
