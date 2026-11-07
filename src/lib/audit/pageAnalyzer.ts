// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/page-analyzer.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * HTML page analyzer using htmlparser2's streaming tokenizer.
 *
 * Extracts SEO-relevant data without building a DOM:
 * title, meta description, canonical, robots meta, OG tags, headings,
 * images, links, hreflang, structured data (JSON-LD), data-nosnippet, word count.
 */

import { Parser } from "htmlparser2";
import { normalizeUrl, isSameOrigin } from "./urlUtils.ts";
import type { PageAnalysis, PageLink, HreflangEntry } from "./types.ts";

const SKIPPED_LINK_PROTOCOLS = /^(javascript:|mailto:|tel:|#)/;
/** Subtrees whose text is not visible content. */
const NON_CONTENT_TAGS = new Set(["script", "style", "noscript", "svg"]);
const HEADING_LEVELS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};
const MAX_ANCHOR_CHARS = 200;
const MAX_EXTRACTED_LINKS = 1_000;
const MAX_EXTRACTED_IMAGES = 1_000;
const MAX_HREFLANG = 50;
const MAX_JSON_LD_BLOCKS = 20;
const MAX_JSON_LD_CHARS = 65_536;

const APP_ROOT_IDS = new Set(["root", "app", "__next", "__nuxt"]);

interface OpenAnchor {
  href: string;
  rel: string;
  text: string[];
}

function isJsonLdType(typeAttr?: string): boolean {
  if (!typeAttr) return false;
  const mime = typeAttr.split(";")[0].trim().toLowerCase();
  return mime === "application/ld+json";
}

/**
 * Analyze an HTML string and extract all SEO-relevant data.
 */
export function analyzeHtml(
  html: string,
  pageUrl: string,
  statusCode: number,
  responseTimeMs: number,
  redirectUrl: string | null = null,
): PageAnalysis {
  let title: string | null = null;
  let titleDepth = 0;
  let titleDone = false;
  let noscriptDepth = 0;
  let metaDescription: string | null = null;
  let canonical: string | null = null;
  let robotsMeta: string | null = null;
  let ogTitle: string | null = null;
  let ogDescription: string | null = null;
  let ogImage: string | null = null;
  let hasStructuredData = false;
  let hasAppRoot = false;
  let hasExecutableScript = false;
  let dataNosnippet = false;

  const hreflangTags: string[] = [];
  const hreflang: HreflangEntry[] = [];

  const jsonLdBlocks: string[] = [];
  let openLdJson: string[] | null = null;

  const h1s: string[] = [];
  const headingOrder: number[] = [];
  let openH1: string[] | null = null;

  const images: Array<{ src: string | null; alt: string | null }> = [];
  const linksByTarget = new Map<string, PageLink>();
  let openAnchor: OpenAnchor | null = null;

  let suppressDepth = 0;
  let bodyDepth = 0;
  let headDepth = 0;
  let sawBody = false;
  const bodyParts: string[] = [];
  const fallbackParts: string[] = [];

  const handleMetaTag = (attribs: Record<string, string>) => {
    const content = attribs["content"];
    const metaName = attribs["name"]?.toLowerCase();
    if (metaName === "description") {
      metaDescription ??= content?.trim() ?? "";
    } else if (metaName === "robots") {
      robotsMeta ??= content ?? null;
    } else if (attribs["property"] === "og:title") {
      ogTitle ??= content ?? null;
    } else if (attribs["property"] === "og:description") {
      ogDescription ??= content ?? null;
    } else if (attribs["property"] === "og:image") {
      ogImage ??= content ?? null;
    }
  };

  const handleLinkTag = (attribs: Record<string, string>) => {
    if (attribs["rel"] === "canonical") {
      canonical ??= attribs["href"] ?? null;
    } else if (attribs["rel"] === "alternate" && attribs["hreflang"]) {
      const code = attribs["hreflang"];
      hreflangTags.push(code);
      if (hreflang.length < MAX_HREFLANG) {
        const rawHref = attribs["href"] ?? null;
        const resolvedHref = rawHref ? normalizeUrl(rawHref, pageUrl) : null;
        hreflang.push({ lang: code, href: resolvedHref });
      }
    }
  };

  const closeAnchor = () => {
    if (!openAnchor) return;
    const { href, rel, text } = openAnchor;
    openAnchor = null;
    if (linksByTarget.size >= MAX_EXTRACTED_LINKS) return;
    const resolved = normalizeUrl(href, pageUrl);
    if (!resolved || linksByTarget.has(resolved)) return;
    const anchor = text
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_ANCHOR_CHARS);
    linksByTarget.set(resolved, {
      targetUrl: resolved,
      anchor: anchor || null,
      isInternal: isSameOrigin(resolved, pageUrl),
      isNofollow: rel.split(/\s+/).includes("nofollow"),
    });
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if ("data-nosnippet" in attribs && noscriptDepth === 0) {
          dataNosnippet = true;
        }

        if (NON_CONTENT_TAGS.has(name)) {
          suppressDepth += 1;
        }
        if (name === "noscript") noscriptDepth += 1;
        if (noscriptDepth > 0) return;

        if (headDepth === 0 && suppressDepth === 0) {
          hasAppRoot ||= APP_ROOT_IDS.has(attribs["id"]) || name === "app-root";
        }

        switch (name) {
          case "title":
            if (!titleDone && suppressDepth === 0) {
              titleDepth += 1;
              if (title === null) title = "";
            }
            break;
          case "head":
            headDepth += 1;
            break;
          case "body":
            bodyDepth += 1;
            sawBody = true;
            break;
          case "meta":
            handleMetaTag(attribs);
            break;
          case "link":
            handleLinkTag(attribs);
            break;
          case "img":
            if (images.length < MAX_EXTRACTED_IMAGES) {
              images.push({
                src: attribs["src"] ?? null,
                alt: "alt" in attribs ? attribs["alt"] : null,
              });
            }
            break;
          case "script": {
            const typeVal = attribs["type"];
            hasExecutableScript ||= [
              "",
              "module",
              "text/javascript",
              "application/javascript",
            ].includes(typeVal?.toLowerCase() ?? "");

            if (isJsonLdType(typeVal)) {
              hasStructuredData = true;
              if (jsonLdBlocks.length < MAX_JSON_LD_BLOCKS) {
                openLdJson = [];
              }
            }
            break;
          }
          case "a": {
            closeAnchor();
            const href = attribs["href"];
            if (href && !SKIPPED_LINK_PROTOCOLS.test(href)) {
              openAnchor = {
                href,
                rel: attribs["rel"]?.toLowerCase() ?? "",
                text: [],
              };
            }
            break;
          }
        }

        const headingLevel = HEADING_LEVELS[name];
        if (headingLevel !== undefined) {
          headingOrder.push(headingLevel);
          if (headingLevel === 1 && openH1 === null) openH1 = [];
        }
      },
      ontext(text) {
        if (openLdJson !== null) {
          openLdJson.push(text);
        }

        if (suppressDepth > 0) return;
        if (titleDepth > 0) {
          if (title !== null) title += text;
          return;
        }
        if (openH1) openH1.push(text);
        if (openAnchor) openAnchor.text.push(text);
        if (bodyDepth > 0) {
          bodyParts.push(text);
        } else if (headDepth === 0) {
          fallbackParts.push(text);
        }
      },
      onclosetag(name) {
        if (name === "script" && openLdJson !== null) {
          const raw = openLdJson.join("");
          openLdJson = null;
          if (raw.length > MAX_JSON_LD_CHARS) {
            jsonLdBlocks.push(raw.slice(0, MAX_JSON_LD_CHARS) + "/*CUT*/");
          } else {
            jsonLdBlocks.push(raw);
          }
        }

        if (NON_CONTENT_TAGS.has(name) && suppressDepth > 0) {
          suppressDepth -= 1;
        }
        if (name === "noscript" && noscriptDepth > 0) {
          noscriptDepth -= 1;
          return;
        }
        if (noscriptDepth > 0) return;
        if (name === "title" && titleDepth > 0) {
          titleDepth -= 1;
          if (titleDepth === 0) titleDone = true;
        }
        if (name === "head" && headDepth > 0) headDepth -= 1;
        if (name === "body" && bodyDepth > 0) bodyDepth -= 1;
        if (name === "a") closeAnchor();
        if (name === "h1" && openH1) {
          h1s.push(openH1.join("").trim());
          openH1 = null;
        }
      },
    },
  );

  parser.write(html);
  parser.end();

  const rawText = (sawBody ? bodyParts : fallbackParts).join("");
  const bodyText = rawText.replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;

  return {
    url: pageUrl,
    statusCode,
    redirectUrl,
    responseTimeMs,
    title: (title ?? "").trim(),
    metaDescription: metaDescription ?? "",
    canonical,
    robotsMeta,
    ogTitle,
    ogDescription,
    ogImage,
    h1s,
    headingOrder,
    wordCount,
    bodyText,
    javascriptShell:
      hasAppRoot &&
      hasExecutableScript &&
      wordCount < 20 &&
      headingOrder.length === 0 &&
      linksByTarget.size === 0 &&
      images.length === 0,
    images,
    links: Array.from(linksByTarget.values()),
    hasStructuredData,
    hreflangTags,
    hreflang,
    jsonLdBlocks,
    dataNosnippet,
  };
}
