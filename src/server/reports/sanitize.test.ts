import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Parser } from "htmlparser2";
import {
  REPORT_ALLOWED_TAGS,
  SANITIZER_VERSION,
  auditHtml,
  filterCss,
  sanitizeReportHtml,
} from "./sanitize.ts";

// F23-AC-06 — the 40-case sanitiser corpus. Every fixture is hand-written
// synthetic HTML; nothing is recorded from a customer. Each document is checked
// against the allowlist, the URL rules, the CSS rules and idempotence, and the
// cases that must keep a construct (a data PNG, a fragment link, `mailto:`, the
// starter template) assert that it survived.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(HERE, "../../../tests/fixtures/f23/sanitize");

type ScannedAttribute = { tag: string; name: string; value: string };

function scan(html: string): { tags: Set<string>; attributes: ScannedAttribute[] } {
  const tags = new Set<string>();
  const attributes: ScannedAttribute[] = [];
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = name.toLowerCase();
        tags.add(tag);
        for (const [attribute, value] of Object.entries(attribs)) {
          attributes.push({ tag, name: attribute.toLowerCase(), value: String(value ?? "") });
        }
      },
    },
    { decodeEntities: true }
  );
  parser.write(html);
  parser.end();
  return { tags, attributes };
}

function cssTexts(html: string): string[] {
  const blocks: string[] = [];
  for (const match of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) blocks.push(match[1] ?? "");
  for (const match of html.matchAll(/\sstyle="([^"]*)"/gi)) {
    blocks.push(String(match[1] ?? "").replaceAll("&quot;", '"'));
  }
  return blocks;
}

const DATA_IMAGE_SRC = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;
const DATA_IMAGE_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;
const ALLOWED = new Set<string>(REPORT_ALLOWED_TAGS);

const documents = readdirSync(CORPUS)
  .filter((file) => file.endsWith(".html"))
  .sort()
  .map((file) => ({ file, html: readFileSync(path.join(CORPUS, file), "utf8") }));

/** The invariants every output must satisfy, whatever its input was. */
function assertSafe(name: string, html: string): void {
  assert.ok(html.startsWith("<!doctype html>\n"), `${name}: the doctype must be first`);

  const { tags, attributes } = scan(html);
  for (const tag of tags) {
    assert.ok(ALLOWED.has(tag), `${name}: tag <${tag}> is outside the allowlist`);
  }

  for (const attribute of attributes) {
    assert.equal(
      attribute.name.startsWith("on"),
      false,
      `${name}: event handler ${attribute.name} survived on <${attribute.tag}>`
    );
    assert.notEqual(attribute.name, "srcset", `${name}: srcset survived`);
    assert.notEqual(attribute.name, "http-equiv", `${name}: meta http-equiv survived`);
    assert.notEqual(attribute.name, "formaction", `${name}: formaction survived`);

    if (attribute.name === "href") {
      const value = attribute.value.toLowerCase();
      assert.equal(value.startsWith("javascript:"), false, `${name}: javascript: href survived`);
      assert.equal(value.startsWith("vbscript:"), false, `${name}: vbscript: href survived`);
      assert.equal(value.startsWith("data:text/html"), false, `${name}: data:text/html href survived`);
      if (!value.startsWith("#")) {
        assert.ok(
          value.startsWith("http://") ||
            value.startsWith("https://") ||
            value.startsWith("mailto:") ||
            !value.includes(":"),
          `${name}: href scheme is not allowed: ${attribute.value}`
        );
      }
    }
    if (attribute.name === "src") {
      assert.match(attribute.value, DATA_IMAGE_SRC, `${name}: <img src> must be a raster data URL`);
    }
  }

  for (const css of cssTexts(html)) {
    assert.equal(/@import/i.test(css), false, `${name}: @import survived`);
    assert.equal(/@font-face/i.test(css), false, `${name}: @font-face survived`);
    assert.equal(/expression\s*\(/i.test(css), false, `${name}: expression() survived`);
    assert.equal(/behavior\s*:/i.test(css), false, `${name}: behavior: survived`);
    assert.equal(/-moz-binding/i.test(css), false, `${name}: -moz-binding survived`);
    assert.equal(css.includes("</"), false, `${name}: a </ sequence survived in CSS`);
    for (const url of css.matchAll(/url\(\s*([^)]*?)\s*\)/gi)) {
      const argument = String(url[1] ?? "").replace(/^['"]|['"]$/g, "");
      if (argument === "") continue;
      assert.match(argument, DATA_IMAGE_URL, `${name}: remote CSS url() survived: ${argument}`);
    }
  }

  const lowered = html.toLowerCase();
  for (const marker of ["<script", "<iframe", "<object", "<embed", "<form", "<input", "<button", "<base", "<link", "<use", "<animate", "<foreignobject", "javascript:", "vbscript:", "data:text/html"]) {
    assert.equal(lowered.includes(marker), false, `${name}: ${marker} survived`);
  }

  // Case 40: idempotence on every document, not just the one named for it.
  assert.equal(sanitizeReportHtml(html).html, html, `${name}: sanitising the output changed it`);
}

test("the corpus is the 40 documents the spec lists", () => {
  assert.equal(documents.length, 40);
  assert.equal(SANITIZER_VERSION, 1);
  assert.equal(documents[0]?.file, "01-script-tag.html");
  assert.equal(documents[39]?.file, "40-idempotence.html");
});

test("every corpus document is safe and idempotent", () => {
  for (const { file, html } of documents) {
    const result = sanitizeReportHtml(html);
    assertSafe(file, result.html);
  }
});

test("case 01 — a script tag and its text are gone, the text around it stays", () => {
  const result = sanitizeReportHtml(documents[0]!.html);
  assert.equal(result.html.includes("alert"), false);
  assert.ok(result.html.includes("Before"));
  assert.ok(result.html.includes("After"));
  assert.deepEqual(result.removedTags, ["script"]);
  assert.equal(result.changed, true);
});

test("case 02 — onload is removed and the body kept", () => {
  const { tags, attributes } = scan(sanitizeReportHtml(documents[1]!.html).html);
  assert.ok(tags.has("body"));
  assert.equal(attributes.some((a) => a.name === "onload"), false);
  assert.equal(auditHtml(documents[1]!.html).eventAttributes, 1);
});

test("case 03 — an img with onerror and a remote src is dropped whole", () => {
  const { tags } = scan(sanitizeReportHtml(documents[2]!.html).html);
  assert.equal(tags.has("img"), false);
  assert.deepEqual(sanitizeReportHtml(documents[2]!.html).removedTags, []);
});

test("cases 04–06 — javascript:, vbscript: and data:text/html hrefs are removed", () => {
  for (const index of [3, 4, 5]) {
    const { attributes } = scan(sanitizeReportHtml(documents[index]!.html).html);
    assert.equal(
      attributes.some((a) => a.name === "href"),
      false,
      `${documents[index]!.file}: the href must be dropped`
    );
    assert.ok(attributes.some((a) => a.tag === "a"), "the anchor text is content and stays");
  }
});

test("case 07 — an SVG script is removed, the SVG is kept", () => {
  const { tags } = scan(sanitizeReportHtml(documents[6]!.html).html);
  assert.ok(tags.has("svg"));
  assert.ok(tags.has("circle"));
  assert.equal(tags.has("script"), false);
  assert.deepEqual(sanitizeReportHtml(documents[6]!.html).removedTags, ["script"]);
});

test("case 08 — foreignObject is removed but its text stays", () => {
  const result = sanitizeReportHtml(documents[7]!.html);
  const { tags } = scan(result.html);
  assert.equal(tags.has("foreignobject"), false);
  assert.ok(result.html.includes("html inside svg"));
  assert.deepEqual(result.removedTags, ["foreignobject", "script"]);
});

test("case 09 — SVG use with a remote href is removed", () => {
  const { tags, attributes } = scan(sanitizeReportHtml(documents[8]!.html).html);
  assert.equal(tags.has("use"), false);
  assert.ok(tags.has("rect"));
  assert.equal(attributes.some((a) => a.value.includes("evil.example")), false);
});

test("case 10 — animate onbegin is removed", () => {
  const { tags } = scan(sanitizeReportHtml(documents[9]!.html).html);
  assert.equal(tags.has("animate"), false);
  assert.ok(tags.has("circle"));
});

test("cases 11–13 — iframe, object and embed are removed", () => {
  for (const [index, tag] of [[10, "iframe"], [11, "object"], [12, "embed"]] as const) {
    const result = sanitizeReportHtml(documents[index]!.html);
    assert.equal(scan(result.html).tags.has(tag), false, `${tag} survived`);
    assert.ok(result.removedTags.includes(tag), `${tag} must be reported as removed`);
  }
});

test("cases 14–16 — form, input and button are removed", () => {
  for (const [index, tags] of [[13, ["form", "input", "button"]], [14, ["input"]], [15, ["button"]]] as const) {
    const result = sanitizeReportHtml(documents[index]!.html);
    for (const tag of tags) {
      assert.equal(scan(result.html).tags.has(tag), false, `${documents[index]!.file}: ${tag} survived`);
      assert.ok(result.removedTags.includes(tag), `${documents[index]!.file}: ${tag} must be reported as removed`);
    }
  }
});

test("case 17 — base href is removed", () => {
  const result = sanitizeReportHtml(documents[16]!.html);
  assert.equal(scan(result.html).tags.has("base"), false);
  assert.deepEqual(result.removedTags, ["base"]);
});

test("case 18 — meta refresh is dropped and the charset meta stays", () => {
  const { tags, attributes } = scan(sanitizeReportHtml(documents[17]!.html).html);
  const metas = attributes.filter((a) => a.tag === "meta");
  assert.equal(metas.length, 1);
  assert.equal(metas[0]?.name, "charset");
  assert.ok(tags.has("meta"));
});

test("case 19 — a stylesheet link is removed", () => {
  const result = sanitizeReportHtml(documents[18]!.html);
  assert.equal(scan(result.html).tags.has("link"), false);
  assert.deepEqual(result.removedTags, ["link"]);
});

test("case 20 — a remote image is dropped", () => {
  const { tags } = scan(sanitizeReportHtml(documents[19]!.html).html);
  assert.equal(tags.has("img"), false);
});

test("case 21 — srcset is dropped while the data src stays", () => {
  const { attributes } = scan(sanitizeReportHtml(documents[20]!.html).html);
  assert.equal(attributes.some((a) => a.name === "srcset"), false);
  const src = attributes.find((a) => a.name === "src");
  assert.ok(src);
  assert.match(src.value, DATA_IMAGE_SRC);
});

test("case 22 — a data PNG is kept", () => {
  const { tags, attributes } = scan(sanitizeReportHtml(documents[21]!.html).html);
  assert.ok(tags.has("img"));
  assert.match(attributes.find((a) => a.name === "src")?.value ?? "", DATA_IMAGE_SRC);
});

test("case 23 — a data SVG image is dropped", () => {
  assert.equal(scan(sanitizeReportHtml(documents[22]!.html).html).tags.has("img"), false);
});

test("case 24 — @import is removed and the rule after it stays", () => {
  const css = cssTexts(sanitizeReportHtml(documents[23]!.html).html).join("\n");
  assert.equal(css.includes("@import"), false);
  assert.ok(css.includes("p{color:#333}"));
});

test("case 25 — a remote CSS url() becomes url() and the other rules stay", () => {
  const result = sanitizeReportHtml(documents[24]!.html);
  const css = cssTexts(result.html).join("\n");
  assert.ok(css.includes("url()"));
  assert.equal(css.includes("evil.example"), false);
  assert.ok(css.includes("p{color:#111}"));
  assert.ok(result.blockedUrls >= 1);
});

test("case 26 — a data CSS url() is kept", () => {
  const css = cssTexts(sanitizeReportHtml(documents[25]!.html).html).join("\n");
  assert.match(css, /url\("data:image\/png;base64,/);
});

test("case 27 — expression() is removed and the sibling declaration stays", () => {
  const css = cssTexts(sanitizeReportHtml(documents[26]!.html).html).join("\n");
  assert.equal(/expression\s*\(/i.test(css), false);
  assert.ok(css.includes("color:#222"));
});

test("case 28 — behavior: is removed", () => {
  const css = cssTexts(sanitizeReportHtml(documents[27]!.html).html).join("\n");
  assert.equal(/behavior\s*:/i.test(css), false);
  assert.ok(css.includes("color:#222"));
});

test("case 29 — -moz-binding is removed", () => {
  const css = cssTexts(sanitizeReportHtml(documents[28]!.html).html).join("\n");
  assert.equal(/-moz-binding/i.test(css), false);
  assert.ok(css.includes("color:#222"));
});

test("case 30 — a style attribute keeps its safe declarations and loses the remote url", () => {
  const result = sanitizeReportHtml(documents[29]!.html);
  const { attributes } = scan(result.html);
  const style = attributes.find((a) => a.name === "style");
  assert.ok(style, "the attribute survives because its other declarations are safe");
  assert.ok(style.value.includes("url()"));
  assert.ok(style.value.includes("#333"));
  assert.equal(style.value.includes("evil.example"), false);
});

test("case 31 — a </style><script> breakout leaves no script", () => {
  const result = sanitizeReportHtml(documents[30]!.html);
  assert.equal(result.html.includes("<script"), false);
  assert.equal((result.html.match(/<style>/g) ?? []).length, 2, "both stylesheets stay");
});

test("cases 32–33 — mixed case and conditional-comment scripts are removed", () => {
  for (const index of [31, 32]) {
    const result = sanitizeReportHtml(documents[index]!.html);
    assert.equal(result.html.toLowerCase().includes("<script"), false);
    assert.ok(result.html.includes("After"));
  }
  assert.equal(sanitizeReportHtml(documents[32]!.html).html.includes("if IE"), false);
});

test("case 34 — an entity-encoded javascript: scheme does not survive", () => {
  const result = sanitizeReportHtml(documents[33]!.html);
  const { attributes } = scan(result.html);
  assert.equal(attributes.some((a) => a.name === "href"), false);
  assert.equal(result.html.toLowerCase().includes("javascript:"), false);
});

test("case 35 — a target=_top link is rewritten to a safe new tab", () => {
  const { attributes } = scan(sanitizeReportHtml(documents[34]!.html).html);
  const anchor = attributes.filter((a) => a.tag === "a");
  assert.equal(anchor.find((a) => a.name === "href")?.value, "https://acme.example/page");
  assert.equal(anchor.find((a) => a.name === "target")?.value, "_blank");
  assert.equal(anchor.find((a) => a.name === "rel")?.value, "noopener noreferrer nofollow");
});

test("case 36 — a fragment link keeps href and nothing else", () => {
  const { attributes } = scan(sanitizeReportHtml(documents[35]!.html).html);
  const anchor = attributes.filter((a) => a.tag === "a");
  assert.equal(anchor.find((a) => a.name === "href")?.value, "#section");
  assert.equal(anchor.some((a) => a.name === "target"), false);
  assert.equal(anchor.some((a) => a.name === "rel"), false);
});

test("case 37 — mailto: is kept and gets the new-tab rel", () => {
  const { attributes } = scan(sanitizeReportHtml(documents[36]!.html).html);
  const anchor = attributes.filter((a) => a.tag === "a");
  assert.equal(anchor.find((a) => a.name === "href")?.value, "mailto:hello@acme.example");
  assert.equal(anchor.find((a) => a.name === "rel")?.value, "noopener noreferrer nofollow");
});

test("case 38 — the starter template survives except the doctype and the link rel", () => {
  const input = documents[37]!.html;
  const result = sanitizeReportHtml(input);
  // sanitize-html serialises void elements with a trailing slash, and the link
  // transform adds the two rel tokens; nothing else may differ.
  const expected = input
    .replace(/rel="noopener"/, 'rel="noopener noreferrer nofollow"')
    .replace(/<(meta|br|hr|img|col)([^>]*?)\s*>/gi, "<$1$2 />");
  assert.equal(result.html, expected);
  assert.deepEqual(result.removedTags, []);
  assert.equal(result.removedAttributes, 0);
  assert.equal(result.blockedUrls, 0);
  assert.ok(result.html.includes("@media print"), "the print stylesheet is untouched");
});

test("case 39 — a 450 KB document survives whole", () => {
  const input = documents[38]!.html;
  const result = sanitizeReportHtml(input);
  assert.ok(Buffer.byteLength(input, "utf8") > 450_000);
  assert.ok(Buffer.byteLength(result.html, "utf8") < 500_000);
  assert.deepEqual(result.removedTags, []);
  assert.ok(result.html.includes("<h1>Large document</h1>"));
});

test("case 40 — every document is idempotent", () => {
  for (const { file, html } of documents) {
    const once = sanitizeReportHtml(html).html;
    const twice = sanitizeReportHtml(once).html;
    assert.equal(twice, once, `${file}: a second pass changed the document`);
  }
});

test("filterCss removes imports and font faces before counting URLs", () => {
  const result = filterCss(
    '@import url("https://evil.example/a.css"); @font-face{font-family:x;src:url(https://evil.example/f.woff)} p{color:#111}'
  );
  assert.equal(result.css.includes("@import"), false);
  assert.equal(result.css.includes("@font-face"), false);
  assert.equal(result.css.includes("evil.example"), false);
  assert.ok(result.css.includes("p{color:#111}"));
  assert.equal(result.blocked, 0, "a URL inside a removed block is not counted twice");
});

test("filterCss replaces every non-data url() and counts it", () => {
  const result = filterCss("a{background:url(https://x/y.png)} b{background:url('http://x/z.png')}");
  assert.equal((result.css.match(/url\(\)/g) ?? []).length, 2);
  assert.equal(result.blocked, 2);
});

test("filterCss keeps data images and drops the known script vectors", () => {
  const result = filterCss(
    'a{background:url("data:image/png;base64,AAAA")} b{width:expression(alert(1));color:red} c{behavior:url(#x);color:blue} d{-moz-binding:url(x)}'
  );
  assert.ok(result.css.includes("data:image/png;base64,AAAA"));
  assert.equal(/expression|behavior|-moz-binding/i.test(result.css), false);
  assert.ok(result.css.includes("color:red"));
  assert.ok(result.css.includes("color:blue"));
  // `url(#x)` is a same-document fragment and is data-like under N-6, so only
  // the `-moz-binding:url(x)` value is counted; the declaration is still dropped.
  assert.equal(result.blocked, 1);
});

test("filterCss removes </ and is idempotent", () => {
  const once = filterCss('a{content:"</style>"} b{background:url(https://x/y.png)}');
  assert.equal(once.css.includes("</"), false);
  assert.equal(filterCss(once.css).css, once.css);
});

test("auditHtml lower-cases tags and counts event handlers and URLs", () => {
  const audit = auditHtml('<BODY onload="x"><IMG SRC="https://a"><a href="mailto:x@y">x</a></BODY>');
  assert.deepEqual([...audit.tags].sort(), ["a", "body", "img"]);
  assert.equal(audit.eventAttributes, 1);
  assert.deepEqual(audit.urls, ["https://a", "mailto:x@y"]);
});

test("removedTags are sorted and name only disallowed tags", () => {
  const result = sanitizeReportHtml(
    '<!doctype html><html><body><form><input><button>x</button></form><iframe></iframe><script>1</script></body></html>'
  );
  assert.deepEqual(result.removedTags, ["button", "form", "iframe", "input", "script"]);
  for (const tag of result.removedTags) assert.equal(REPORT_ALLOWED_TAGS.includes(tag as never), false);
});

test("removedAttributes counts refused attributes", () => {
  const result = sanitizeReportHtml(
    '<!doctype html><html><body><p onclick="x" data-x="1" style="background:url(https://e/x.png)">t</p></body></html>'
  );
  assert.equal(result.removedAttributes, 2, "onclick and data-x");
});

// ---------------------------------------------------------------------------
// SF-1 — CSS comments and escapes cannot hide a construct
// ---------------------------------------------------------------------------

test("SF-1 — a comment inside url( cannot hide a remote URL", () => {
  const result = filterCss("a{background:url/**/(https://evil.example/x.png)}");
  assert.equal(result.css.includes("evil.example"), false);
  assert.ok(result.css.includes("url()"));
  assert.equal(result.blocked, 1);
});

test("SF-1 — CSS escapes cannot hide url( or @import", () => {
  const escapedUrl = filterCss("a{background:u\\72l(https://evil.example/x.png)}");
  assert.equal(escapedUrl.css.includes("evil.example"), false);
  assert.ok(escapedUrl.css.includes("url()"));
  assert.equal(escapedUrl.blocked, 1);

  const escapedImport = filterCss('@im\\70 ort "https://evil.example/x.css"; p{color:red}');
  assert.equal(escapedImport.css.includes("@import"), false);
  assert.equal(escapedImport.css.includes("evil.example"), false);
  assert.ok(escapedImport.css.includes("p{color:red}"));

  const commentedImport = filterCss('@/**/import "https://evil.example/x.css"; p{color:red}');
  assert.equal(commentedImport.css.includes("@import"), false);
  assert.equal(commentedImport.css.includes("evil.example"), false);
  assert.ok(commentedImport.css.includes("p{color:red}"));
});

test("SF-1 — a clean comment-preserving stylesheet is returned byte-identical", () => {
  const css = "/* keep this note */\np{color:#333}\n";
  assert.deepEqual(filterCss(css), { css, blocked: 0 });
});

test("SF-1 — obfuscation is neutralised through sanitizeReportHtml", () => {
  const attribute = sanitizeReportHtml(
    '<!doctype html><html><body><p style="background:url/**/(https://evil.example/x.png)">x</p></body></html>'
  );
  assert.equal(attribute.html.includes("evil.example"), false);

  const block = sanitizeReportHtml(
    '<!doctype html><html><head><style>@/**/import "https://evil.example/x.css"; p{color:#333}</style></head><body><p>x</p></body></html>'
  );
  assert.equal(block.html.includes("@import"), false);
  assert.equal(block.html.includes("evil.example"), false);
  assert.ok(block.html.includes("p{color:#333}"));
});

// ---------------------------------------------------------------------------
// SF-2 — the CSS filter is linear on unclosed input
// ---------------------------------------------------------------------------

test("SF-2 — 100 KB of unclosed url( completes promptly and deterministically", () => {
  const input = "url(".repeat(25_000);
  assert.equal(input.length, 100_000);
  const started = performance.now();
  const first = filterCss(input);
  const elapsed = performance.now() - started;
  const second = filterCss(input);

  assert.deepEqual(first, second);
  assert.equal(first.blocked, 25_000);
  assert.equal(first.css, "url()".repeat(25_000));
  assert.ok(elapsed < 2_000, `the linear scan took ${elapsed.toFixed(0)} ms for 100 KB`);
});

test("SF-2 — unclosed at-rules also terminate", () => {
  const started = performance.now();
  assert.equal(filterCss("@font-face{".repeat(20_000)).css, "");
  assert.equal(filterCss("@import x".repeat(20_000)).css, "");
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2_000, `unclosed at-rule scans took ${elapsed.toFixed(0)} ms`);
});

test("SF-2 — an unclosed url( is neutralised and counted", () => {
  const result = filterCss("a{background:url(https://evil.example/x.png");
  assert.equal(result.blocked, 1);
  assert.ok(result.css.startsWith("a{background:url()"));
  assert.equal(/url\([^)]*evil/.test(result.css), false, "no completed url() function is left");
});

// ---------------------------------------------------------------------------
// SF-3 / N-6 — SVG camel-case tags and same-document fragment URLs
// ---------------------------------------------------------------------------

test("SF-3 — camel-case gradients and clipPath survive with their attributes", () => {
  const html =
    '<!doctype html>\n<html><body><svg viewBox="0 0 10 10">' +
    '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0" stop-color="#3730CE"></stop><stop offset="1" stop-color="#5B54F0"></stop></linearGradient>' +
    '<radialGradient id="r"><stop offset="0" stop-color="#fff"></stop></radialGradient>' +
    '<clipPath id="c"><rect width="5" height="5"></rect></clipPath>' +
    '<rect width="10" height="10" fill="url(#g)" clip-path="url(#c)"></rect></svg></body></html>';
  const result = sanitizeReportHtml(html);

  for (const marker of [
    '<linearGradient id="g"',
    '<radialGradient id="r"',
    '<clipPath id="c"',
    'gradientunits="userSpaceOnUse"',
    'x1="0"',
    'stop-color="#3730CE"',
    'fill="url(#g)"',
    'clip-path="url(#c)"',
  ]) {
    assert.ok(result.html.includes(marker), `SF-3: expected ${marker} in the output`);
  }
  assert.equal(result.removedTags.includes("lineargradient"), false);
  assert.equal(result.removedTags.includes("radialgradient"), false);
  assert.equal(result.removedTags.includes("clippath"), false);
  assert.equal(sanitizeReportHtml(result.html).html, result.html, "SF-3: sanitising twice changes nothing");
});

test("SF-3/N-6 — same-document fragment URLs survive while remote ones do not", () => {
  assert.deepEqual(filterCss("rect{fill:url(#g)}"), { css: "rect{fill:url(#g)}", blocked: 0 });
  const remote = filterCss("rect{fill:url(https://evil.example/paint.svg#g)}");
  assert.equal(remote.css, "rect{fill:url()}");
  assert.equal(remote.blocked, 1);

  const style = sanitizeReportHtml(
    '<!doctype html><html><body><svg><rect width="1" height="1" style="fill:url(#g)"></rect></svg></body></html>'
  );
  assert.ok(style.html.includes("fill:url(#g)"));
});
