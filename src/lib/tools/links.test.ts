import test from "node:test";
import assert from "node:assert/strict";
import { appBaseUrl, buildAppUrl } from "./links.ts";

test("buildAppUrl joins a leading path to the origin and encodes parameters", () => {
  assert.equal(
    buildAppUrl("https://app.test/base/", "/portal/scans", { scan: "a b", page: 2 }),
    "https://app.test/portal/scans?scan=a+b&page=2",
  );
});

test("buildAppUrl skips undefined parameters and preserves query parameters", () => {
  assert.equal(
    buildAppUrl("https://app.test", "portal/scans?sort=recent", { missing: undefined }),
    "https://app.test/portal/scans?sort=recent",
  );
});

test("appBaseUrl uses configured URL, then request origin, then the public default", () => {
  const request = new Request("https://tenant.test/path");
  assert.equal(appBaseUrl({ NEXT_PUBLIC_APP_URL: "https://configured.test/app" }, request), "https://configured.test");
  assert.equal(appBaseUrl({}, request), "https://tenant.test");
  assert.equal(appBaseUrl({}), "https://perceev.com");
});
