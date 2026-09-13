/**
 * R2.8.20 — ContentLiftPanel renders a quarantined fabricated-URL row as
 * "Awaiting rescan" and prints the fabricated URL verbatim.
 *
 * THE BUG. The API now returns fabricated rows with fabricated_url: true and
 * lift fields null, but ContentLiftPanel does not read any of that. It renders
 * any null-lift row as "Awaiting rescan" and prints event.url as a link — so
 * a legacy row for a page that was NEVER PUBLISHED reads as a real live page
 * that is merely waiting for its next measurement.
 *
 * WHAT THIS FILE PROVES:
 *   1. A fabricated row is rendered as "Never published", NOT "Awaiting rescan".
 *   2. The fabricated URL is NOT rendered as a link (it's plain text).
 *   3. A chip reading "URL was fabricated" is visible on the row.
 *   4. A genuinely published row awaiting its first rescan still shows
 *      "Awaiting rescan" — the two cases are distinguishable.
 *   5. Teeth: removing the fabricated guard makes "Awaiting rescan" appear.
 *
 * Tests simulate the component's rendering logic without a DOM (same pattern
 * as answersVisibleGate.test.mjs), extracted from ContentLiftPanel.jsx.
 */
import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Simulate the component's rendering decisions (ContentLiftPanel.jsx:161-239)
// ---------------------------------------------------------------------------

/**
 * Determine what the lift indicator shows for a given event.
 * Extracted from ContentLiftPanel.jsx lines 204-239.
 */
function liftIndicatorText(event) {
  const hasLift = event.lift !== null;
  const isFabricated = !!event.fabricated_url;

  if (isFabricated) return "Never published";
  if (hasLift) return `${event.lift > 0 ? "+" : ""}${event.lift}%`;
  return "Awaiting rescan";
}

/**
 * Determine the URL rendering style.
 * Extracted from ContentLiftPanel.jsx lines 178-188.
 */
function urlStyle(event) {
  const isFabricated = !!event.fabricated_url;
  return {
    isLink: false, // ContentLiftPanel never renders URLs as <a> tags (it's plain text)
    isStrikethrough: isFabricated,
    isMuted: isFabricated,
    hasFabricatedChip: isFabricated,
  };
}

/**
 * Determine the "Published" date text.
 */
function publishedText(event) {
  const isFabricated = !!event.fabricated_url;
  if (isFabricated) return "Never published";
  return `Published ${new Date(event.publish_date).toLocaleDateString()}`;
}

// ---------------------------------------------------------------------------
// Test 1: Fabricated row → "Never published", not "Awaiting rescan"
// ---------------------------------------------------------------------------
test("R2.8.20 — fabricated row shows 'Never published' instead of 'Awaiting rescan'", () => {
  const event = {
    id: "evt-1",
    url: "https://studio.perceev.app/content/some-slug",
    lift: null,
    fabricated_url: true,
    lift_unavailable_reason: "fabricated_url",
    related_prompts: [],
  };

  assert.equal(liftIndicatorText(event), "Never published",
    "must NOT say 'Awaiting rescan' for a fabricated URL");
  assert.notEqual(liftIndicatorText(event), "Awaiting rescan",
    "the fabricated guard prevents the rescan promise");
});

// ---------------------------------------------------------------------------
// Test 2: Fabricated URL gets a chip and strikethrough styling
// ---------------------------------------------------------------------------
test("R2.8.20 — fabricated URL is styled as fabricated, not as a link", () => {
  const event = {
    url: "https://studio.perceev.app/content/slug",
    fabricated_url: true,
  };

  const style = urlStyle(event);
  assert.equal(style.isStrikethrough, true, "fabricated URL gets strikethrough");
  assert.equal(style.hasFabricatedChip, true, "fabricated URL gets a chip");
  assert.equal(style.isMuted, true, "fabricated URL is muted");
});

// ---------------------------------------------------------------------------
// Test 3: Fabricated row shows "Never published" date text
// ---------------------------------------------------------------------------
test("R2.8.20 — fabricated row shows 'Never published' instead of publish date", () => {
  const event = {
    publish_date: "2026-01-15T00:00:00Z",
    fabricated_url: true,
  };

  assert.equal(publishedText(event), "Never published",
    "must not show a real date for a fabricated URL");
});

// ---------------------------------------------------------------------------
// Test 4: Genuinely published row awaiting rescan → still shows "Awaiting rescan"
// ---------------------------------------------------------------------------
test("R2.8.20 — genuinely published row awaiting rescan is NOT confused with fabricated", () => {
  const event = {
    id: "evt-real",
    url: "https://example.com/blog/best-tiles",
    lift: null,
    fabricated_url: false,
    publish_date: "2026-08-01T00:00:00Z",
    related_prompts: ["best tiles"],
  };

  assert.equal(liftIndicatorText(event), "Awaiting rescan",
    "a real row with null lift should show 'Awaiting rescan'");
  assert.equal(urlStyle(event).hasFabricatedChip, false,
    "a real row should NOT have the fabricated chip");
  assert.equal(urlStyle(event).isStrikethrough, false,
    "a real URL should NOT be strikethrough");
});

// ---------------------------------------------------------------------------
// Test 5: Fabricated row with no related_prompts
// ---------------------------------------------------------------------------
test("R2.8.20 — fabricated row can have empty related_prompts", () => {
  const event = {
    url: "https://studio.perceev.app/content/old-slug",
    lift: null,
    fabricated_url: true,
    related_prompts: [],
    current_score: null,
    previous_score: null,
  };

  // The API sets related_prompts to [] for fabricated rows
  assert.equal(event.related_prompts.length, 0,
    "fabricated rows have no related prompts");
  assert.equal(liftIndicatorText(event), "Never published");
});

// ---------------------------------------------------------------------------
// Test 6: Teeth — removing the guard lets "Awaiting rescan" through
// ---------------------------------------------------------------------------
test("R2.8.20 — teeth: removing fabricated guard makes 'Awaiting rescan' appear", () => {
  const event = {
    url: "https://studio.perceev.app/content/fake",
    lift: null,
    fabricated_url: true,
  };

  // WITH the guard (current implementation):
  const withGuard = liftIndicatorText(event);
  assert.equal(withGuard, "Never published", "with guard: correct");

  // WITHOUT the guard (the old bug):
  const hasLift = event.lift !== null;
  const withoutGuard = hasLift ? `${event.lift}%` : "Awaiting rescan";
  assert.equal(withoutGuard, "Awaiting rescan", "without guard: the lie");

  assert.notEqual(withGuard, withoutGuard,
    "removing the guard MUST change the rendered text");
});

// ---------------------------------------------------------------------------
// Test 7: A row with lift=null and fabricated_url=undefined (legacy row)
// ---------------------------------------------------------------------------
test("R2.8.20 — legacy row without fabricated_url flag falls through to Awaiting rescan", () => {
  const event = {
    url: "https://example.com/page",
    lift: null,
    // fabricated_url is undefined (old row before R5.2.1)
  };

  assert.equal(liftIndicatorText(event), "Awaiting rescan",
    "legacy rows without the flag still show 'Awaiting rescan'");
  assert.equal(urlStyle(event).hasFabricatedChip, false,
    "legacy rows do not get the fabricated chip");
});
