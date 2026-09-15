import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * R2.8.4 — a DB failure and "no scans yet" must not render the same thing.
 *
 * The route used to treat every non-ok response the same way: `if (!res.ok)
 * setScan(null)`, with the comment "404 (no scans yet) and any transient error
 * both collapse to the shell's existing empty state". So a database outage
 * rendered as "Your dashboard is waiting — run your first visibility check". A
 * user with a year of history was told they had never scanned, and invited to
 * spend a scan budget to fix an outage on our side.
 *
 * These are source-level assertions rather than DOM tests because this repo has
 * no component-render harness; they pin the two decisions that carry the
 * behaviour — the route separating 404 from failure, and the shell rendering a
 * distinct branch — so that collapsing them again fails the suite.
 */

const ROUTE = "src/app/dashboard/[brand]/page.js";
const SHELL = "src/components/dashboard/DashboardShell.jsx";

const read = (rel) => readFile(path.join(REPO, rel), "utf8");

test("the route distinguishes a 404 from any other failure", async () => {
  const src = await read(ROUTE);

  assert.match(
    src,
    /res\.status === 404/,
    "a 404 must be handled on its own — it is the only status that means 'no scans yet'"
  );
  assert.match(src, /setError\(/, "a non-404 failure must set an error, not an empty result");

  // The regression itself: a bare `if (!res.ok) setScan(null)` with nothing
  // separating 404 first.
  const collapsesEverything = /if\s*\(!res\.ok\)\s*\{\s*(\/\/[^\n]*\n\s*)*setScan\(null\)/.test(src);
  assert.ok(!collapsesEverything, "a failed fetch must not fall through to the empty state");
});

test("the route reports a thrown fetch as an error, not as an empty dashboard", async () => {
  const src = await read(ROUTE);
  const catchBlock = src.slice(src.indexOf(".catch("));
  assert.ok(catchBlock.length > 0, "the fetch must still have a catch");
  assert.ok(
    !/setScan\(null\)/.test(catchBlock.slice(0, 400)),
    "a network failure must not be reported as 'no scans yet'"
  );
  assert.match(catchBlock.slice(0, 400), /setError\(/);
});

test("the shell renders a distinct error branch, above the empty state", async () => {
  const src = await read(SHELL);

  assert.match(src, /error = null/, "the shell must accept an error prop");
  assert.match(src, /data-testid="dashboard-error"/, "the error state needs its own testid");

  const errorAt = src.indexOf('data-testid="dashboard-error"');
  const emptyAt = src.indexOf('data-testid="dashboard-empty"');
  assert.ok(errorAt > 0 && emptyAt > 0, "both states must exist");
  assert.ok(
    errorAt < emptyAt,
    "the error branch must return BEFORE the empty branch, or a failed load falls through to it"
  );
});

test("the error state does not invite the user to spend a scan", async () => {
  const src = await read(SHELL);
  const errorAt = src.indexOf('data-testid="dashboard-error"');
  const emptyAt = src.indexOf('data-testid="dashboard-empty"');
  const errorBlock = src.slice(errorAt, emptyAt);

  assert.ok(
    !/Run a visibility check|Run your first/.test(errorBlock),
    "an outage is our problem — the error state must not push the user to spend a scan on it"
  );
  assert.match(errorBlock, /Try again/, "it should offer a retry instead");
});
