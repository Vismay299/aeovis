// The link preview is drawn with the bundled font only (F23 §6.2.7: "no network",
// "no remote assets"). `next/og` quietly breaks that promise for any character the
// bundled font lacks: an emoji is fetched from a CDN (and the render throws when
// that fails), and any other missing glyph (an em dash, a curly quote, Cyrillic,
// CJK) sends the title text to Google Fonts. Report titles are written by a model
// and routinely contain an em dash, so the title is reduced to what the bundled
// font draws before it reaches the renderer.
//
// The allowed set was checked code point by code point with the network blocked:
// printable ASCII, Latin-1 Supplement (without the soft hyphen), the euro sign and
// the trade mark sign all render locally with no request.

const DRAWABLE = /[\u0020-\u007E\u00A0-\u00AC\u00AE-\u00FF\u20AC\u2122]/u;

// Typographic characters a model writes constantly, mapped to their plain forms
// instead of being dropped.
const PLAIN: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B\u2032]/gu, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033]/gu, '"'],
  [/[\u2010-\u2015\u2212]/gu, "-"],
  [/\u2026/gu, "..."],
  [/[\u2022\u2023\u25E6\u2043]/gu, "-"],
  [/[\u2000-\u200A\u202F\u205F\u3000]/gu, " "],
  // Line breaks and tabs separate words; dropping them would fuse the words.
  [/[\t\n\v\f\r\u0085\u2028\u2029]/gu, " "],
];

/**
 * `value` reduced to characters the bundled font draws, whitespace collapsed.
 * A letter outside the set keeps its base letter when it has one (o with a double
 * acute becomes o); anything else (emoji, other scripts, symbols) is dropped.
 * `fallback` answers when nothing is left.
 */
export function socialImageText(value: string, fallback: string): string {
  let text = String(value ?? "");
  for (const [pattern, replacement] of PLAIN) text = text.replace(pattern, replacement);

  let out = "";
  for (const char of text) {
    if (DRAWABLE.test(char)) {
      out += char;
      continue;
    }
    const base = char.normalize("NFD").replace(/\p{M}/gu, "");
    if (base !== char && base.length > 0 && [...base].every((part) => DRAWABLE.test(part))) {
      out += base;
    }
  }
  const cleaned = out.replace(/\s+/gu, " ").trim();
  return cleaned || fallback;
}
