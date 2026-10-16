import test from "node:test";

/**
 * R21-06 fixture — a required test that exists on disk OUTSIDE the collected
 * glob `src/lib/repairs/*.test.mjs`.
 *
 * WHY IT EXISTS. A test file that nothing collects disappears silently: the
 * suite goes green and the case it registered is never run. This file is the
 * on-disk half of that failure — it declares a real case id (R19-23, which has
 * no other registration) and the runner can see it, cannot dispatch it from the
 * glob, and must say so instead of reporting R19-23 unimplemented with no
 * explanation.
 *
 * It is deliberately not named so the `src/**\/*.test.mjs` glob of `npm test`
 * collects it, and it must never be "fixed" by moving it into the glob: the
 * behaviour it proves only exists while the file is outside it.
 */
test(
  "R19-23 — authorized first-party property read/import (orphaned fixture)",
  {
    skip:
      "BLOCKED: this file is an orphan-detection fixture for R21-06. It is outside the collected glob " +
      "on purpose, so the runner reports it as an orphaned required test rather than running it.",
  },
  () => {}
);
