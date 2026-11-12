// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu): src/shared/google-serp-url.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { googleSerpUrl } from "./google-serp-url.ts";

test("googleSerpUrl targets the tracked city with uule", () => {
  assert.equal(
    googleSerpUrl("best seo tool", { locationCode: 2840, languageCode: "en", locationName: "Austin,Texas,United States" }),
    "https://www.google.com/search?q=best+seo+tool&hl=en&gl=us&pws=0&uule=w+CAIQICIaQXVzdGluLFRleGFzLFVuaXRlZCBTdGF0ZXM%3D",
  );
});

test("googleSerpUrl uses the country for a national tracker", () => {
  assert.equal(
    googleSerpUrl("café", { locationCode: 2826, languageCode: "en" }),
    "https://www.google.com/search?q=caf%C3%A9&hl=en&gl=gb&pws=0",
  );
});
