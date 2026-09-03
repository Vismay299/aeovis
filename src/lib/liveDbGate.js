/**
 * The gate on tests that need a real Postgres (R1.2.2).
 *
 * Its own module rather than a helper inside the test file, so a guard test can
 * import and exercise it without also re-registering the gated cases.
 *
 * WHY A GATE AT ALL, AND WHY IT MUST BE LOUD
 * Some properties cannot be proven without a database. "Two workers racing for
 * the same batch produce exactly one claim" is one: it is a fact about Postgres
 * row locking, and a fake client has no lock manager, so it would agree with a
 * correct implementation and a broken one alike. CI has no database, so those
 * tests must skip there — but a silent skip turns a green suite into a claim
 * nobody checked. This returns the REASON, and the caller is expected to print
 * it where a passing run cannot hide it. Standing rule 1: a skip is not a
 * success.
 */

/**
 * @returns {{enabled: boolean, reason: string|null}} `reason` is non-null
 * exactly when the gate is closed, and says what is missing and how to supply it.
 */
export function liveDbGate(env = process.env) {
  if (env.DATABASE_URL) return { enabled: true, reason: null };
  if (env.SUPABASE_DB_PASSWORD && env.NEXT_PUBLIC_SUPABASE_URL) {
    return { enabled: true, reason: null };
  }
  return {
    enabled: false,
    reason:
      "no live Postgres configured (needs DATABASE_URL, or SUPABASE_DB_PASSWORD + " +
      "NEXT_PUBLIC_SUPABASE_URL). Run: node --env-file=.env.local --test <file>",
  };
}

/** The banner an unconfigured run prints to stderr, naming what went unproven. */
export function notRunBanner(title, reason, consequence) {
  return (
    "\n" +
    "==============================================================\n" +
    ` ${title}: NOT RUN\n` +
    ` reason: ${reason}\n` +
    ` ${consequence}\n` +
    "==============================================================\n"
  );
}
