import sanitizeHtml from "sanitize-html";
import { Parser } from "htmlparser2";

// F23 §6.2.2 — the report sanitiser. Reports are written by a model from
// attacker-influenceable inputs (crawled pages, SERP titles, GSC queries) and
// served from the app's own origin inside a sandboxed document, so the stored
// HTML is forced through one allowlist and one CSS filter at save time.
//
// Bumping SANITIZER_VERSION is the migration for a fix: every serve path
// re-sanitises rows whose stored version is older (phase 2) and writes the row
// back, so a new rule reaches reports written before it existed.

export const SANITIZER_VERSION = 1;

export type SanitizeResult = {
  html: string;
  changed: boolean;
  removedTags: string[];
  removedAttributes: number;
  blockedUrls: number;
};

// The allowlist carries BOTH spellings of the SVG camel-case tags. HTML parsers
// lower-case HTML tag names, but sanitize-html 2.18.2 preserves the case of
// non-HTML tags (SF-3): an `<linearGradient>` is matched against `allowedTags`
// as `linearGradient`, so a lower-case-only list silently drops the element.
// The lower-case entries stay for parsers and documents that do lower-case.
export const REPORT_ALLOWED_TAGS = [
  "html", "head", "body", "title", "meta", "style",
  "header", "footer", "main", "article", "section", "aside", "nav",
  "div", "span", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "figure", "figcaption", "blockquote", "pre", "code", "kbd", "samp",
  "strong", "b", "em", "i", "u", "s", "small", "sub", "sup", "mark", "abbr", "time",
  "details", "summary", "a", "img",
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "desc", "defs", "linearGradient", "radialGradient", "clipPath",
  "lineargradient", "radialgradient", "stop", "clippath",
] as const;

const ALLOWED_TAG_SET = new Set<string>(REPORT_ALLOWED_TAGS);

const SVG_TAGS = [
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "desc", "defs", "linearGradient", "radialGradient", "clipPath",
  "lineargradient", "radialgradient", "stop", "clippath",
] as const;

const SVG_ATTRIBUTES = [
  "viewbox", "width", "height", "xmlns", "fill", "fill-opacity", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-opacity", "opacity",
  "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "points",
  "transform", "text-anchor", "dominant-baseline", "font-size", "font-weight",
  "font-family", "dx", "dy", "offset", "stop-color", "stop-opacity", "gradientunits",
  "gradienttransform", "preserveaspectratio", "clip-path", "focusable", "aria-hidden",
] as const;

const UNIVERSAL_ATTRIBUTES = ["id", "class", "style", "title", "lang", "dir", "role", "aria-*"] as const;

const ALLOWED_ATTRIBUTES: Record<string, readonly string[]> = {
  "*": UNIVERSAL_ATTRIBUTES,
  a: ["href", "target", "rel", "name"],
  img: ["src", "alt", "width", "height"],
  td: ["colspan", "rowspan", "scope", "headers"],
  th: ["colspan", "rowspan", "scope", "headers"],
  col: ["span"],
  colgroup: ["span"],
  time: ["datetime"],
  ol: ["start", "reversed", "type"],
  details: ["open"],
  meta: ["charset", "name", "content"],
  html: ["lang"],
};
for (const tag of SVG_TAGS) ALLOWED_ATTRIBUTES[tag] = SVG_ATTRIBUTES;

const ALLOWED_SCHEMES = ["http", "https", "mailto"] as const;

// Elements whose text is data, not content. `<style>` is deliberately absent:
// its text is a stylesheet and is filtered by filterCss, not dropped.
const NON_TEXT_TAGS = [
  "script", "textarea", "option", "noscript", "iframe", "object", "embed", "template",
] as const;

/**
 * The only image data URLs a report may keep. SVG data images are excluded on
 * purpose: an `<img>` is not the only way a browser renders one, and the
 * allowlist wants exactly one raster shape.
 */
const DATA_IMAGE_SRC = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;

/**
 * `url(…)` arguments that survive the CSS filter. A raster data image and a
 * same-document fragment (`url(#gradient)`, N-6) are both local: neither can
 * make a network request, so both are kept as written. Everything else becomes
 * `url()`.
 */
function isSafeCssUrl(argument: string): boolean {
  return DATA_IMAGE_SRC.test(argument) || argument.startsWith("#");
}

const LEADING_DOCTYPE_OR_COMMENT = /^\s*(?:<!doctype[^>]*>\s*|<!--[\s\S]*?-->\s*)*/i;

const normaliseWhitespace = (html: string) => html.replace(/\s+/g, " ").trim();

const CSS_WHITESPACE = /[\t\n\f\r ]/;
const HEX_DIGIT = /[0-9a-fA-F]/;

/** Declarations the filter drops whole: script-in-CSS and its vendor relatives. */
const BAD_DECLARATION = /expression\s*\(|behavior\s*:|-moz-binding/i;

/**
 * How many normalise → filter rounds the dirty path may run before it gives up
 * and drops the stylesheet. Each round halves a run of escaped backslashes, so
 * a construct hidden behind 2^16 of them is caught; a document that needs more
 * than this is not CSS anyone wrote by hand, and failing closed is cheaper than
 * storing text whose meaning on a later parse we cannot predict.
 */
const CSS_FILTER_MAX_PASSES = 16;

/**
 * Decode one CSS escape at `backslash`, returning the replacement text and the
 * index after it. A hex escape takes 1–6 hex digits and one optional CSS
 * whitespace terminator; `\` plus a newline is a line continuation; any other
 * escaped character stands for itself. Linear in the escape's own length.
 */
function decodeCssEscape(css: string, backslash: number): { text: string; next: number } {
  const n = css.length;
  let index = backslash + 1;
  if (index >= n) return { text: "\\", next: index };

  let hex = "";
  while (index < n && hex.length < 6 && HEX_DIGIT.test(css[index]!)) {
    hex += css[index];
    index += 1;
  }
  if (hex.length > 0) {
    if (index < n && CSS_WHITESPACE.test(css[index]!)) index += 1;
    const codePoint = Number.parseInt(hex, 16);
    const text = codePoint === 0 || codePoint > 0x10ffff ? "\uFFFD" : String.fromCodePoint(codePoint);
    return { text, next: index };
  }

  const escaped = css[index]!;
  if (escaped === "\r") return { text: "", next: css[index + 1] === "\n" ? index + 2 : index + 1 };
  if (escaped === "\n" || escaped === "\f") return { text: "", next: index + 1 };
  return { text: escaped, next: index + 1 };
}

/**
 * The match-only view of a stylesheet: comments removed and CSS escapes
 * decoded, with quoted strings copied (and decoded) but never treated as a
 * comment delimiter. Both transformations are single linear passes. The
 * original text is returned to the caller when this view turns out clean, so a
 * comment-preserving stylesheet keeps its bytes.
 */
function normaliseCssForMatching(css: string): string {
  let out = "";
  let quote: string | null = null;
  let index = 0;

  while (index < css.length) {
    const char = css[index]!;

    if (char === "\\") {
      const decoded = decodeCssEscape(css, index);
      out += decoded.text;
      index = decoded.next;
      continue;
    }
    if (quote) {
      out += char;
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && css[index + 1] === "*") {
      const close = css.indexOf("*/", index + 2);
      if (close === -1) break; // a comment runs to EOF
      index = close + 2;
      continue;
    }
    out += char;
    index += 1;
  }

  return out;
}

type ParsedCssUrl = { end: number; argument: string; slice: string; closed: boolean };

/**
 * Read one `url(…)` in linear time. `start` points at the `u`. A quoted
 * argument ends at its matching quote (so a `)` inside the string is not the
 * terminator); an unquoted one ends at the first `)`. A missing terminator is
 * reported as `closed: false` with `end` at the end of the string; the caller
 * then never scans that tail again.
 */
function parseCssUrl(css: string, start: number): ParsedCssUrl {
  const n = css.length;
  let index = start + 4;
  while (index < n && CSS_WHITESPACE.test(css[index]!)) index += 1;

  const quote = css[index] === '"' || css[index] === "'" ? css[index]! : null;
  if (quote) {
    const argumentStart = index + 1;
    index = argumentStart;
    while (index < n && css[index] !== quote) index += 1;
    if (index >= n) return { end: n, argument: css.slice(argumentStart), slice: "", closed: false };
    const argument = css.slice(argumentStart, index);
    index += 1;
    while (index < n && CSS_WHITESPACE.test(css[index]!)) index += 1;
    if (css[index] !== ")") return { end: n, argument, slice: "", closed: false };
    return { end: index + 1, argument, slice: css.slice(start, index + 1), closed: true };
  }

  const argumentStart = index;
  while (index < n && css[index] !== ")") index += 1;
  if (index >= n) return { end: n, argument: css.slice(argumentStart).trim(), slice: "", closed: false };
  return { end: index + 1, argument: css.slice(argumentStart, index).trim(), slice: css.slice(start, index + 1), closed: true };
}

/**
 * Drop whole declarations whose value can reach the script engine, keeping the
 * surrounding rule. The scan is linear and knows when a `;` is inside a quoted
 * string or parentheses (a data URL's `;base64` is not a declaration
 * boundary). A selector before `{` is never tested.
 */
function removeBadDeclarations(css: string): string {
  let out = "";
  let segment = "";
  let quote: string | null = null;
  let parens = 0;

  const flushDeclaration = (terminator: "" | ";") => {
    if (!BAD_DECLARATION.test(segment)) out += segment + terminator;
    segment = "";
  };

  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]!;
    if (quote) {
      segment += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      segment += char;
      continue;
    }
    if (char === "(") {
      parens += 1;
      segment += char;
      continue;
    }
    if (char === ")") {
      parens = Math.max(0, parens - 1);
      segment += char;
      continue;
    }
    if (parens === 0 && char === ";") {
      flushDeclaration(";");
      continue;
    }
    if (parens === 0 && char === "{") {
      // Everything before `{` is a selector or at-rule prelude; keep it.
      out += segment + "{";
      segment = "";
      continue;
    }
    if (parens === 0 && char === "}") {
      flushDeclaration("");
      out += "}";
      continue;
    }
    segment += char;
  }
  flushDeclaration("");
  return out;
}

/**
 * Apply the rules to the already-normalised stylesheet. Every branch advances
 * `index` and the only unbounded searches (`indexOf`) are first-time scans: an
 * unclosed `url(` sets `noClosingParen`, after which every later `url(` is
 * neutralised in O(1) without touching the tail again (SF-2).
 */
function filterNormalisedCss(css: string): { css: string; blocked: number } {
  const lower = css.toLowerCase();
  let out = "";
  let blocked = 0;
  let noClosingParen = false;
  let index = 0;

  while (index < css.length) {
    if (lower.startsWith("@import", index)) {
      const semicolon = css.indexOf(";", index + 7);
      index = semicolon === -1 ? css.length : semicolon + 1;
      continue;
    }

    if (lower.startsWith("@font-face", index)) {
      let brace = index + 10;
      while (brace < css.length && CSS_WHITESPACE.test(css[brace]!)) brace += 1;
      if (css[brace] === "{") {
        const close = css.indexOf("}", brace + 1);
        index = close === -1 ? css.length : close + 1;
      } else {
        index = brace; // a bare `@font-face` keyword is not CSS; drop it
      }
      continue;
    }

    if (lower.startsWith("url(", index)) {
      if (noClosingParen) {
        out += "url()";
        blocked += 1;
        index += 4;
        continue;
      }
      const parsed = parseCssUrl(css, index);
      if (!parsed.closed) {
        // There is no `)` to the end of the string; neutralise this one and
        // never rescan the tail for the next `url(`.
        noClosingParen = true;
        out += "url()";
        blocked += 1;
        index += 4;
        continue;
      }
      if (isSafeCssUrl(parsed.argument)) out += parsed.slice;
      else {
        out += "url()";
        blocked += 1;
      }
      index = parsed.end;
      continue;
    }

    if (css[index] === "<" && css[index + 1] === "/") {
      index += 2;
      continue;
    }

    out += css[index];
    index += 1;
  }

  return { css: removeBadDeclarations(out), blocked };
}

/**
 * Strip dangerous CSS from a stylesheet or a `style` attribute value.
 *
 * The rules run on a normalised copy (comments removed, CSS escapes decoded),
 * so `url/**` + `/(…)`, `u\72l(…)` and `@im\70 ort` cannot hide a construct a
 * browser will resolve (SF-1). When that copy is clean, the ORIGINAL text is
 * returned unchanged, so a comment-preserving stylesheet (the starter template)
 * keeps its bytes.
 *
 * When it is dirty, one normalise pass is not enough: a source `\\75 rl(…)`
 * normalises to `\75 rl(…)`, which a browser decodes again into a live `url(…)`.
 * The dirty path therefore repeats normalise → filter on its own output until
 * the text stops changing (B1). The first pass's blocked count is preserved, so
 * the `url()` values that later passes neutralise internally are not counted
 * twice. If no fixed point is reached inside the budget, the stylesheet is
 * dropped rather than stored with an escape that a later parse could resolve.
 *
 * Order is the spec's: @import/@font-face blocks go first (so an imported URL is
 * not also counted as a blocked `url()`), then every non-safe `url()` becomes
 * `url()` and is counted, then declarations that can reach the script engine,
 * then any `</` sequence. Every step is linear and idempotent.
 */
export function filterCss(css: string): { css: string; blocked: number } {
  const source = String(css);
  const normalised = normaliseCssForMatching(source);
  const filtered = filterNormalisedCss(normalised);
  if (filtered.blocked === 0 && filtered.css === normalised) return { css: source, blocked: 0 };

  const firstBlocked = filtered.blocked;
  let current = filtered.css;
  for (let pass = 0; pass < CSS_FILTER_MAX_PASSES; pass += 1) {
    const next = filterNormalisedCss(normaliseCssForMatching(current));
    if (next.css === current) return { css: current, blocked: firstBlocked };
    current = next.css;
  }
  // No fixed point inside the budget. A stylesheet that cannot be settled may
  // still resolve to a disallowed construct on a later parse, so fail closed:
  // an empty stylesheet (and therefore a removed style attribute) is the only
  // answer that cannot fetch anything.
  return { css: "", blocked: firstBlocked };
}

function metaIsAllowed(attribs: Record<string, string>): boolean {
  const keys = Object.keys(attribs);
  if (keys.length === 1 && keys[0] === "charset") return true;
  return attribs.name === "viewport" && typeof attribs.content === "string";
}

function imageIsAllowed(attribs: Record<string, string>): boolean {
  return DATA_IMAGE_SRC.test(attribs.src ?? "");
}

function attributeIsAllowed(tag: string, attribute: string): boolean {
  if (attribute.startsWith("aria-")) return true;
  const universal = ALLOWED_ATTRIBUTES["*"] ?? [];
  if (universal.includes(attribute)) return true;
  return (ALLOWED_ATTRIBUTES[tag] ?? []).includes(attribute);
}

/**
 * One pass over the input for the counts a save reports: which tags the
 * allowlist will remove, how many attributes it will drop, and how many event
 * handlers the document carried.
 */
export function auditHtml(html: string): {
  tags: Set<string>;
  eventAttributes: number;
  urls: string[];
} {
  const tags = new Set<string>();
  const urls: string[] = [];
  let eventAttributes = 0;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = name.toLowerCase();
        tags.add(tag);
        for (const [attribute, value] of Object.entries(attribs)) {
          const key = attribute.toLowerCase();
          if (key.startsWith("on")) eventAttributes += 1;
          if (key === "href" || key === "src") urls.push(String(value ?? ""));
        }
      },
    },
    { decodeEntities: true }
  );
  parser.write(html);
  parser.end();

  return { tags, eventAttributes, urls };
}

/**
 * Count the attributes the allowlist refuses, for the save result. An element
 * the exclusive filter drops entirely counts all of its attributes. A `style`
 * value that filters down to nothing counts as removed; one that survives does
 * not, even when its contents changed.
 */
function countRefusedAttributes(html: string): number {
  let removed = 0;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = name.toLowerCase();
        if (tag === "meta" && !metaIsAllowed(attribs)) {
          removed += Object.keys(attribs).length;
          return;
        }
        if (tag === "img" && !imageIsAllowed(attribs)) {
          removed += Object.keys(attribs).length;
          return;
        }
        for (const [attribute, value] of Object.entries(attribs)) {
          const key = attribute.toLowerCase();
          if (!attributeIsAllowed(tag, key)) {
            removed += 1;
            continue;
          }
          if (key === "style" && filterCss(String(value ?? "")).css.trim() === "") removed += 1;
        }
      },
    },
    { decodeEntities: true }
  );
  parser.write(html);
  parser.end();
  return removed;
}

/** Replace each surviving `<style>` block's text with its filtered form. */
function filterStyleBlocks(html: string, addBlocked: (count: number) => void): string {
  return html.replace(
    /<style(\s[^>]*)?>([\s\S]*?)<\/style>/gi,
    (_match, attributes: string | undefined, css: string) => {
      const filtered = filterCss(css);
      addBlocked(filtered.blocked);
      return `<style${attributes ?? ""}>${filtered.css}</style>`;
    }
  );
}

/**
 * Sanitise one report document. Everything here is synchronous and
 * deterministic: the same input always yields the same output (a property the
 * corpus test asserts for every fixture).
 */
export function sanitizeReportHtml(input: string): SanitizeResult {
  const audit = auditHtml(input);
  let blockedUrls = 0;

  const transform = (
    tagName: string,
    attribs: Record<string, string>
  ): { tagName: string; attribs: Record<string, string> } => {
    const out: Record<string, string> = { ...attribs };

    if (typeof out.style === "string") {
      const filtered = filterCss(out.style);
      blockedUrls += filtered.blocked;
      if (filtered.css.trim()) out.style = filtered.css;
      else delete out.style;
    }

    if (tagName === "a") {
      if (typeof out.href === "string" && out.href.startsWith("#")) {
        // An in-page anchor is the one link that must stay inside the frame;
        // its other attributes are dropped with the target it must not carry.
        return { tagName, attribs: out.href ? { href: out.href } : {} };
      }
      out.target = "_blank";
      out.rel = "noopener noreferrer nofollow";
    }

    return { tagName, attribs: out };
  };

  const sanitized = sanitizeHtml(input, {
    allowedTags: [...REPORT_ALLOWED_TAGS],
    allowedAttributes: ALLOWED_ATTRIBUTES as sanitizeHtml.IOptions["allowedAttributes"],
    allowedSchemes: [...ALLOWED_SCHEMES],
    // `img` is the one element allowed a scheme the global list does not carry.
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    // `<style>` is in the allowlist; the CSS filter and the CSP are what make
    // it safe. Without this the library refuses to emit style content at all.
    allowVulnerableTags: true,
    nonTextTags: [...NON_TEXT_TAGS],
    exclusiveFilter: (frame) => {
      if (frame.tag === "meta") return !metaIsAllowed(frame.attribs);
      if (frame.tag === "img") return !imageIsAllowed(frame.attribs);
      return false;
    },
    // One function for both keys on purpose: the library applies the `*`
    // transform INSTEAD of a tag-specific one, so an `a`-only handler would
    // never run. Keeping both names pointing at the same function records the
    // spec's rule and survives that precedence either way.
    transformTags: {
      a: transform,
      "*": transform,
    },
    // Kept for spec fidelity. sanitize-html 2.18 emits allowed style text
    // without calling textFilter (it special-cases style before the filter), so
    // the style blocks are filtered in filterStyleBlocks below. If a future
    // version does call this, the post-pass is idempotent on its output.
    textFilter: (text, tagName) => (tagName === "style" ? filterCss(text).css : text),
  });

  const styled = filterStyleBlocks(sanitized, (count) => {
    blockedUrls += count;
  });

  // The library drops a leading doctype; older versions sometimes leave one.
  // Whatever it left, the stored document starts with exactly one doctype.
  const withoutLeading = styled.replace(LEADING_DOCTYPE_OR_COMMENT, "").replace(/^\s+/, "");
  const html = `<!doctype html>\n${withoutLeading}`;

  return {
    html,
    changed: normaliseWhitespace(input) !== normaliseWhitespace(html),
    removedTags: [...audit.tags].filter((tag) => !ALLOWED_TAG_SET.has(tag)).sort(),
    removedAttributes: countRefusedAttributes(input),
    blockedUrls,
  };
}
