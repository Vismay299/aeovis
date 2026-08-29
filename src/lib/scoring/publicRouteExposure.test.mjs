import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R0.1.2 guard — no unauthenticated page route may ship a real customer's
 * measurements.
 *
 * /chart-preview was a design harness that described itself as "not a product
 * route" and shipped a named third-party brand's real visibility trend, copied
 * out of the production database, as hardcoded constants on a public,
 * un-noindexed page (finding C12). It was DELETED rather than gated: gating
 * leaves the customer's numbers in the repository and in every build, and the
 * harness's own docstring said it was safe to delete once its components were
 * wired into the real dashboard — which they now are (RankAndSharePanel,
 * SectionStrap).
 *
 * Deleting the route file is what makes the URL 404: Next.js's app router has
 * no route without a page file, so this is a stronger guarantee than an auth
 * check that could be misconfigured.
 *
 * Correction to the finding as written: the page did not query the production
 * DB at request time. The data was hardcoded, sourced from the DB by hand.
 * Same exposure, different mechanism.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const APP = path.join(REPO, "src/app");

/** Every real customer identifier that must not appear in a public page route. */
const CUSTOMER_IDENTIFIERS = ["snitch.com", "italicatiles.com"];

async function pageRouteFiles(dir = APP, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // API routes are covered by the operator perimeter (R0.1.3), not here.
      if (entry.name === "api") continue;
      await pageRouteFiles(full, acc);
    } else if (/^(page|layout)\.(js|jsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

test("the /chart-preview design harness is gone, so the URL 404s", async () => {
  const routes = await pageRouteFiles();
  const preview = routes.filter((f) => f.includes(`${path.sep}chart-preview${path.sep}`));
  assert.deepEqual(preview, [], "src/app/chart-preview must not exist — it is a public route");
});

test("no public page route hardcodes a real customer's measurements", async () => {
  const routes = await pageRouteFiles();
  assert.ok(routes.length > 0, "the walker must actually find page routes");

  const offenders = [];
  for (const file of routes) {
    const src = (await readFile(file, "utf8")).toLowerCase();
    for (const id of CUSTOMER_IDENTIFIERS) {
      if (src.includes(id)) offenders.push(`${path.relative(REPO, file)} mentions ${id}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a public page route carries real customer data:\n  " + offenders.join("\n  ")
  );
});

test("no page route still self-describes as a temporary harness", async () => {
  // The tell that flagged /chart-preview in the first place: a route whose own
  // docstring says it is not a product route, shipped to production anyway.
  const routes = await pageRouteFiles();
  const offenders = [];
  for (const file of routes) {
    const src = await readFile(file, "utf8");
    if (/not a product route|TEMPORARY DESIGN HARNESS/i.test(src)) {
      offenders.push(path.relative(REPO, file));
    }
  }
  assert.deepEqual(offenders, [], `self-declared non-product routes are still public: ${offenders}`);
});
