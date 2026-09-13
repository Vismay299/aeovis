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

function assertCorpusIntact(rows, name, { floor, required = [], isTuple = false }) {
  assert.ok(Array.isArray(rows), `${name} is not an array at all, so tests assert nothing`);
  assert.ok(
    rows.length >= floor,
    `${name} holds ${rows.length} rows, under its floor of ${floor}. Rows were removed from a corpus ` +
      `whose tests iterate over it, so assertions silently stopped running. If the removal ` +
      `was deliberate, lower the floor here in the same commit and state why.`
  );
  if (isTuple) {
    rows.forEach((row, i) => {
      assert.ok(
        Array.isArray(row) && row.length >= 2 && typeof row[0] === "string",
        `${name}[${i}] is not a valid tuple entry: ${JSON.stringify(row)}`
      );
      const reason = row[row.length - 1];
      assert.ok(
        typeof reason === "string" && reason.trim().length > 0,
        `${name}[${i}] (${JSON.stringify(row[0])}) carries no reason -- a row nobody can justify is a row ` +
          `the next editor deletes, and the floor above would then be met by padding`
      );
    });
  } else {
    rows.forEach((item, i) => {
      assert.ok(
        typeof item === "string",
        `${name}[${i}] is not a string: ${JSON.stringify(item)}`
      );
    });
  }
  const targets = rows.map((r) => (Array.isArray(r) ? r[0] : r));
  const dupes = [...new Set(targets.filter((t, i) => targets.indexOf(t) !== i))];
  assert.deepEqual(
    dupes,
    [],
    `${name} repeats ${JSON.stringify(dupes)}. A duplicated row holds the count up without adding ` +
      `coverage, which is how a corpus passes its floor while testing less than it did yesterday.`
  );
  const missing = required.filter((t) => !targets.some((target) => target.includes(t)));
  assert.deepEqual(
    missing,
    [],
    `${name} no longer contains ${JSON.stringify(missing)}. These rows are load-bearing ` +
      `targets: removing one is a decision to stop defending that target -- make it in the same commit as this list.`
  );
}

/** Every real customer identifier that must not appear in a public page route. */
const CUSTOMER_IDENTIFIERS = ["snitch.com", "italicatiles.com"];

test("GUARD TEETH — assertCorpusIntact enforces length floor, uniqueness, and required targets", () => {
  assert.throws(
    () => assertCorpusIntact([], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /under its floor of 1/
  );
  assert.throws(
    () => assertCorpusIntact(["a", "a"], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /repeats/
  );
  assert.throws(
    () => assertCorpusIntact(["a"], "TEST_CORPUS", { floor: 1, required: ["b"], isTuple: false }),
    /no longer contains/
  );
  assert.throws(
    () => assertCorpusIntact([123], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /is not a string/
  );
});

test("GUARD — CUSTOMER_IDENTIFIERS corpus is intact", () => {
  assertCorpusIntact(CUSTOMER_IDENTIFIERS, "CUSTOMER_IDENTIFIERS", {
    floor: 2,
    required: ["snitch.com", "italicatiles.com"],
    isTuple: false,
  });
});

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
  assertCorpusIntact(routes, "pageRouteFiles()", {
    floor: 5,
    required: ["page.js", "layout.js"],
    isTuple: false,
  });
  const preview = routes.filter((f) => f.includes(`${path.sep}chart-preview${path.sep}`));
  assert.deepEqual(preview, [], "src/app/chart-preview must not exist — it is a public route");
});

test("no public page route hardcodes a real customer's measurements", async () => {
  const routes = await pageRouteFiles();
  assertCorpusIntact(routes, "pageRouteFiles()", {
    floor: 5,
    required: ["page.js", "layout.js"],
    isTuple: false,
  });

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
