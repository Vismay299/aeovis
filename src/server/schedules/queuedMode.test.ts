import test from "node:test";
import assert from "node:assert/strict";

test("scheduled scans collect in queued mode where supported (F10-AC-11)", async (t) => {
  let engineRoutes: any = null;
  try {
    const modulePath = "../../shared/engines/engineRoutes.ts";
    // @ts-ignore dynamic import for unmerged F02 phase 4 module
    engineRoutes = await import(modulePath);
  } catch {
    t.skip("F02 phase 4 not merged");
    return;
  }

  if (!engineRoutes || !engineRoutes.DATAFORSEO_SCAN_MODES || !engineRoutes.QUEUED_COLLECTION_READY) {
    t.skip("F02 phase 4 not merged");
    return;
  }

  const modes = engineRoutes.DATAFORSEO_SCAN_MODES;
  assert.equal(modes.chatgpt, "scraper_queued");
  assert.equal(modes.gemini, "scraper_queued");
  assert.equal(modes.aio, "serp_queued");
});
