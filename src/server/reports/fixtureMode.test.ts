import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fixtureDocumentPathForReport,
  fixtureDocumentPathForToken,
  isFixtureMode,
  readFixtureDocument,
} from "./fixtureMode.ts";

test("the fixture switch needs the flag AND a non-production runtime", () => {
  assert.equal(isFixtureMode({ F23_FIXTURE_DOCUMENTS: "1", NODE_ENV: "development" }), true);
  assert.equal(isFixtureMode({ F23_FIXTURE_DOCUMENTS: "1" }), true, "an unset NODE_ENV is not production");
  assert.equal(isFixtureMode({ F23_FIXTURE_DOCUMENTS: "1", NODE_ENV: "production" }), false, "never in production");
  assert.equal(isFixtureMode({ NODE_ENV: "development" }), false, "off without the flag");
  assert.equal(isFixtureMode({ F23_FIXTURE_DOCUMENTS: "true", NODE_ENV: "development" }), false, "only the exact value 1");
  assert.equal(isFixtureMode({}), false);
});

test("only the two fixed ids and tokens map to a fixture document", () => {
  const benignId = "11111111-1111-1111-1111-111111111111";
  const hostileId = "22222222-2222-2222-2222-222222222222";
  assert.match(fixtureDocumentPathForReport(benignId) ?? "", /benign\.html$/);
  assert.match(fixtureDocumentPathForReport(hostileId) ?? "", /hostile\.html$/);
  assert.equal(fixtureDocumentPathForReport("33333333-3333-3333-3333-333333333333"), null);
  assert.match(fixtureDocumentPathForToken("a".repeat(32)) ?? "", /benign\.html$/);
  assert.match(fixtureDocumentPathForToken("b".repeat(32)) ?? "", /hostile\.html$/);
  assert.equal(fixtureDocumentPathForToken("c".repeat(32)), null);
});

test("the fixture documents exist, and a missing file reads as null rather than throwing", async () => {
  for (const id of ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"]) {
    const path = fixtureDocumentPathForReport(id);
    assert.ok(path);
    const html = await readFixtureDocument(path);
    assert.ok(html && html.length > 0, `${path} is readable`);
  }
  assert.equal(await readFixtureDocument("tests/fixtures/f23/documents/missing.html"), null);
});
