/**
 * R6.4.17 — Shared corpus-integrity guard.
 *
 * Every security/performance guard test in this repo iterates a corpus. If the
 * corpus is empty, the loop registers 0 tests and passes silently — a green
 * suite that asserts nothing. This helper exists so every test asserts the same
 * four claims (floor, shape, uniqueness, required members) from one
 * implementation, rather than twelve drifting copies.
 *
 * WHY NOT GREP-BASED: this helper itself is a guard against corpus drift; it
 * must not be defeated by the same NUL-byte / binary-file issue R6.4.10
 * addresses. It operates on in-memory arrays, never on files.
 *
 * OPTIONS:
 *   floor       (required) — minimum row count. Derived from the actual array
 *               length at the time of writing. Lower it in the same commit as
 *               a deliberate removal; the guard catches accidental ones.
 *   isTuple     (default false) — when true, rows are [value, reason] arrays.
 *               Each row must be an array, carry a non-empty reason, and match
 *               rowLength (if set) or be >= 2.
 *   rowLength   (default null, meaning >= 2) — exact length for tuple rows.
 *   required    (default []) — members that must be present. Matched by exact
 *               equality unless substringMatch is true.
 *   substringMatch (default false) — when true, required members are checked
 *               with target.includes(member) instead of strict equality. This
 *               is needed by publicRouteExposure.test.mjs where targets are
 *               absolute paths and required items are relative fragments.
 *               Deliberately named so a reader sees it is a weaker check.
 *   allowRegExp  (default false) — when true, string entries may be RegExp
 *               instances (their .source is used for dedup). Needed by
 *               serpQueryPrice.test.mjs COST_LITERAL_PATTERNS.
 */
export function assertCorpusIntact(
  rows,
  name,
  { floor, required = [], isTuple = false, rowLength = null, substringMatch = false, allowRegExp = false }
) {
  if (!Array.isArray(rows)) {
    throw new Error(`${name} is not an array at all, so tests assert nothing`);
  }

  if (rows.length < floor) {
    throw new Error(
      `${name} holds ${rows.length} rows, under its floor of ${floor}. Rows were removed from a corpus ` +
        `whose tests iterate over it, so assertions silently stopped running. If the removal ` +
        `was deliberate, lower the floor here in the same commit and state why.`
    );
  }

  // Shape check
  if (isTuple) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (
        !Array.isArray(row) ||
        (rowLength === null ? row.length < 2 : row.length !== rowLength) ||
        typeof row[0] !== "string"
      ) {
        throw new Error(
          `${name}[${i}] is not a valid tuple entry with expected shape (rowLength=${rowLength ?? ">=2"}): ${JSON.stringify(row)}`
        );
      }
      const reason = row[row.length - 1];
      if (typeof reason !== "string" || reason.trim().length === 0) {
        throw new Error(
          `${name}[${i}] (${JSON.stringify(row[0])}) carries no reason -- a row nobody can justify is a row ` +
            `the next editor deletes, and the floor above would then be met by padding`
        );
      }
    }
  } else {
    for (let i = 0; i < rows.length; i++) {
      const item = rows[i];
      if (allowRegExp && item instanceof RegExp) continue;
      if (typeof item !== "string") {
        throw new Error(
          `${name}[${i}] is not a ${allowRegExp ? "string or RegExp" : "string"}: ${JSON.stringify(item)}`
        );
      }
      if (item.trim().length === 0) {
        throw new Error(
          `${name}[${i}] is an empty string -- a blank entry pads the floor without adding coverage`
        );
      }
    }
  }

  // Uniqueness check
  const targets = rows.map((r) => {
    if (Array.isArray(r)) return r[0];
    if (allowRegExp && r instanceof RegExp) return r.source;
    return r;
  });
  const seen = new Set();
  const dupes = [];
  for (const t of targets) {
    if (seen.has(t) && !dupes.includes(t)) dupes.push(t);
    seen.add(t);
  }
  if (dupes.length > 0) {
    throw new Error(
      `${name} repeats ${JSON.stringify(dupes)}. A duplicated row holds the count up without adding ` +
        `coverage, which is how a corpus passes its floor while testing less than it did yesterday.`
    );
  }

  // Required members check
  if (required.length > 0) {
    const missing = required.filter((t) => {
      if (substringMatch) {
        return !targets.some((target) => target.includes(t));
      }
      return !targets.includes(t);
    });
    if (missing.length > 0) {
      throw new Error(
        `${name} no longer contains ${JSON.stringify(missing)}. These rows are load-bearing ` +
          `targets: losing one makes a guard silent again. Removing one is a decision to stop ` +
          `defending that target -- make it in the same commit as this list.`
      );
    }
  }
}