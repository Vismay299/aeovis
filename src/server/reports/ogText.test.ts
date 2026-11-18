// F23-AC-14: the preview image uses the bundled font and makes no network request.
// The renderer itself needs JSX, so the reduction that guarantees it is tested here.
// The allowed set was verified against next/og with the network blocked.

import assert from "node:assert/strict";
import { test } from "node:test";
import { socialImageText } from "./ogText.ts";

const ALLOWED = /^[\u0020-\u007E\u00A0-\u00AC\u00AE-\u00FF\u20AC\u2122]*$/u;

test("plain ASCII and Latin-1 titles pass through unchanged", () => {
  assert.equal(socialImageText("AI Visibility Report: Q4 (final) & 100% #1", "x"), "AI Visibility Report: Q4 (final) & 100% #1");
  const latin = "Caf\u00E9 r\u00E9sum\u00E9 Zo\u00EB \u00C5ngstr\u00F6m \u00F1 \u00DF \u00F8 \u00BF \u00A9 \u00BD \u00A3 \u20AC \u2122";
  assert.equal(socialImageText(latin, "x"), latin);
});

test("the typographic characters a model writes become plain ones", () => {
  assert.equal(socialImageText("AI Visibility Report \u2014 November 17, 2026", "x"), "AI Visibility Report - November 17, 2026");
  assert.equal(socialImageText("\u201CQuoted\u201D and \u2018single\u2019", "x"), "\"Quoted\" and 'single'");
  assert.equal(socialImageText("Loading\u2026 a\u2013b", "x"), "Loading... a-b");
  assert.equal(socialImageText("one\u2009two\u202Fthree", "x"), "one two three");
});

test("emoji and other scripts are dropped, not sent to a CDN", () => {
  assert.equal(socialImageText("Launch \uD83D\uDE80 report", "x"), "Launch report");
  assert.equal(socialImageText("Team \uD83D\uDC69\u200D\uD83D\uDCBB review \u2B50\uFE0F", "x"), "Team review");
  assert.equal(socialImageText("Report \u0418\u043D\u0434\u0435\u043A\u0441 \u65E5\u672C\u8A9E", "x"), "Report");
  assert.equal(socialImageText("arrows \u2192 and checks \u2713", "x"), "arrows and checks");
});

test("a letter outside the set keeps its base letter", () => {
  assert.equal(socialImageText("Gy\u0151r \u0107evap\u010Di\u0107", "x"), "Gyor cevapcic");
});

test("a title with nothing drawable falls back", () => {
  assert.equal(socialImageText("\u65E5\u672C\u8A9E\u306E\u30EC\u30DD\u30FC\u30C8", "Shared report"), "Shared report");
  assert.equal(socialImageText("\uD83D\uDE80\uD83D\uDE80", "Shared report"), "Shared report");
  assert.equal(socialImageText("   ", "Shared report"), "Shared report");
  assert.equal(socialImageText("\u202E\u200B", "Shared report"), "Shared report");
});

test("control characters and the soft hyphen never survive; line breaks separate words", () => {
  assert.equal(socialImageText("a\u0000b\u0007c\u00ADd\n\te   f", "x"), "abcd e f");
  assert.equal(socialImageText("one\ntwo\u2028three", "x"), "one two three");
});

test("every output is made only of characters the bundled font draws", () => {
  // Every BMP code point, then a spread of astral ones, each between letters.
  for (let cp = 0; cp <= 0xffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const out = socialImageText(`a${String.fromCodePoint(cp)}b`, "fallback");
    assert.match(out, ALLOWED, `U+${cp.toString(16)}`);
  }
  for (let cp = 0x1f300; cp <= 0x1faff; cp += 7) {
    assert.match(socialImageText(`a${String.fromCodePoint(cp)}b`, "x"), ALLOWED, `U+${cp.toString(16)}`);
  }
});
