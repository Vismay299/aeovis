import test from "node:test";
import assert from "node:assert/strict";
import { analyzeHtml } from "./pageAnalyzer.ts";

const PAGE_URL = "https://example.com/blog/post";

test("analyzeHtml extracts all fields from a well-formed document", () => {
  const html = `<!DOCTYPE html>
    <html><head>
      <title> The  Title </title>
      <meta name="description" content="  A description.  ">
      <meta name="robots" content="index, follow">
      <meta property="og:title" content="OG Title">
      <meta property="og:description" content="OG Desc">
      <meta property="og:image" content="/og.png">
      <link rel="canonical" href="https://example.com/blog/post">
      <link rel="alternate" hreflang="en" href="/en">
      <link rel="alternate" hreflang="de" href="/de">
      <script type="application/ld+json">{"@type":"Article"}</script>
    </head><body>
      <h1>Main <em>Heading</em></h1>
      <h2>Sub</h2><h3>Deep</h3><h2>Sub 2</h2>
      <p>Some visible body text with <strong>bold words</strong> here.</p>
      <script>ignored();</script>
      <style>.x{}</style>
      <svg><title>icon</title><text>svg text</text></svg>
      <noscript><img src="/ns.png"><p>noscript text</p></noscript>
      <img src="/a.png" alt="A picture">
      <img src="/b.png" alt="">
      <img src="/c.png">
      <img alt="no src">
      <a href="/relative">Relative <span>link</span></a>
      <a href="https://example.com/relative">Duplicate target</a>
      <a href="https://other.example/x" rel="NoFollow sponsored">External</a>
      <a href="mailto:x@example.com">Mail</a>
      <a href="#frag">Fragment</a>
      <a href="javascript:void(0)">JS</a>
      <a href="/empty-anchor"><img src="/img-link.png" alt=""></a>
    </body></html>`;

  const res = analyzeHtml(html, PAGE_URL, 200, 150);

  assert.equal(res.title, "The  Title");
  assert.equal(res.metaDescription, "A description.");
  assert.equal(res.robotsMeta, "index, follow");
  assert.equal(res.canonical, "https://example.com/blog/post");
  assert.equal(res.ogTitle, "OG Title");
  assert.equal(res.ogDescription, "OG Desc");
  assert.equal(res.ogImage, "/og.png");
  assert.deepEqual(res.h1s, ["Main Heading"]);
  assert.deepEqual(res.headingOrder, [1, 2, 3, 2]);
  assert.equal(res.hasStructuredData, true);
  assert.deepEqual(res.hreflangTags, ["en", "de"]);
  assert.deepEqual(res.hreflang, [
    { lang: "en", href: "https://example.com/en" },
    { lang: "de", href: "https://example.com/de" },
  ]);
  assert.equal(res.jsonLdBlocks.length, 1);
  assert.equal(res.jsonLdBlocks[0], '{"@type":"Article"}');
  assert.equal(res.wordCount, 20); // Includes heading, paragraphs, and anchor texts
  assert.equal(res.images.length, 5);
  assert.equal(res.links.length, 3);
  assert.equal(res.javascriptShell, false);
});

test("analyzeHtml handles bare fragment with no head or body", () => {
  const html = `<h1>Bare fragment</h1><p>Just text and a <a href="/x">link</a>.</p>`;
  const res = analyzeHtml(html, PAGE_URL, 200, 50);

  assert.equal(res.title, "");
  assert.deepEqual(res.h1s, ["Bare fragment"]);
  assert.equal(res.wordCount, 6);
  assert.equal(res.links.length, 1);
  assert.equal(res.links[0].targetUrl, "https://example.com/x");
});

test("analyzeHtml handles empty document", () => {
  const res = analyzeHtml("", PAGE_URL, 200, 10);
  assert.equal(res.title, "");
  assert.equal(res.wordCount, 0);
  assert.equal(res.h1s.length, 0);
  assert.equal(res.links.length, 0);
  assert.equal(res.images.length, 0);
});

test("analyzeHtml handles document with head only", () => {
  const html = `<html><head><title>Head only</title><meta name="description" content="d"></head></html>`;
  const res = analyzeHtml(html, PAGE_URL, 200, 20);
  assert.equal(res.title, "Head only");
  assert.equal(res.metaDescription, "d");
  assert.equal(res.wordCount, 0);
});

test("analyzeHtml preserves first occurrence on duplicate meta and title tags", () => {
  const html = `<html><head>
    <title>First</title><title>Second</title>
    <meta name="description" content="first desc">
    <meta name="description" content="second desc">
    <link rel="canonical" href="/first"><link rel="canonical" href="/second">
    </head><body><p>text</p></body></html>`;
  const res = analyzeHtml(html, PAGE_URL, 200, 20);
  assert.equal(res.title, "First");
  assert.equal(res.metaDescription, "first desc");
  assert.equal(res.canonical, "/first");
});

test("analyzeHtml recovers from unclosed and misnested tags", () => {
  const html = `<html><body>
    <h1>Unclosed heading
    <p>Paragraph <b>bold <i>both</b> italic?</i>
    <a href="/one">first <a href="/two">second</a>
    <div>trailing text`;
  const res = analyzeHtml(html, PAGE_URL, 200, 20);
  assert.equal(res.h1s.length, 1);
  assert.ok(res.h1s[0].includes("Unclosed heading"));
  assert.ok(res.links.some((l) => l.targetUrl === "https://example.com/one"));
  assert.ok(res.links.some((l) => l.targetUrl === "https://example.com/two"));
  assert.ok(res.bodyText.includes("trailing text"));
});

test("analyzeHtml decodes entities in text and titles", () => {
  const html = `<html><head><title>A &amp; B &lt;C&gt;</title></head>
    <body><h1>Caf&eacute; &quot;menu&quot;</h1>
    <p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>
    <a href="/x?a=1&amp;b=2">Query &amp; anchor</a></body></html>`;
  const res = analyzeHtml(html, PAGE_URL, 200, 20);
  assert.equal(res.title, "A & B <C>");
  assert.deepEqual(res.h1s, ['Café "menu"']);
  assert.ok(res.bodyText.includes("1 < 2 && 3 > 2"));
  assert.equal(res.links[0].targetUrl, "https://example.com/x?a=1&b=2");
  assert.equal(res.links[0].anchor, "Query & anchor");
});

test("analyzeHtml tracks heading order across nested sections", () => {
  const html = `<body><h3>three</h3><div><h1>one</h1><section><h2>two</h2>
    <h6>six</h6></section></div><h4>four</h4></body>`;
  const res = analyzeHtml(html, PAGE_URL, 200, 20);
  assert.deepEqual(res.headingOrder, [3, 1, 2, 6, 4]);
});

test("analyzeHtml counts words accurately with irregular whitespace", () => {
  const html = `<body>
    <p>
      one
      two    three
    </p>
    <ul><li>four</li><li>five</li></ul>
  </body>`;
  const res = analyzeHtml(html, PAGE_URL, 200, 20);
  assert.equal(res.wordCount, 4); // "one two three fourfive"
  assert.equal(res.bodyText, "one two three fourfive");
});

test("analyzeHtml treats meta name case-insensitively", () => {
  const html1 = `<head><meta name="Description" content="first"><meta name="description" content="second"></head>`;
  assert.equal(analyzeHtml(html1, PAGE_URL, 200, 10).metaDescription, "first");

  const html2 = `<head><meta name="ROBOTS" content="noindex"></head>`;
  assert.equal(analyzeHtml(html2, PAGE_URL, 200, 10).robotsMeta, "noindex");
});

test("analyzeHtml caps links and images to 1,000", () => {
  const links = Array.from(
    { length: 1_100 },
    (_, i) => `<a href="/p/${i}">link ${i}</a>`,
  ).join("");
  const images = Array.from(
    { length: 1_100 },
    (_, i) => `<img src="/i/${i}.png">`,
  ).join("");
  const res = analyzeHtml(
    `<body>${links}${images}</body>`,
    "https://example.com/",
    200,
    100,
  );
  assert.equal(res.links.length, 1_000);
  assert.equal(res.images.length, 1_000);
});

test("analyzeHtml detects JavaScript app shells accurately", () => {
  for (const id of ["root", "app", "__next", "__nuxt"]) {
    const html = `<body><div id="${id}">Loading...</div><script src="/app.js"></script></body>`;
    assert.equal(analyzeHtml(html, PAGE_URL, 200, 0).javascriptShell, true);
  }

  const angular = '<app-root></app-root><script type="module" src="/main.js"></script>';
  assert.equal(analyzeHtml(angular, PAGE_URL, 200, 0).javascriptShell, true);

  // Negative cases
  assert.equal(
    analyzeHtml('<div id="root"><h2>A heading</h2></div><script src="/app.js"></script>', PAGE_URL, 200, 0).javascriptShell,
    false,
  );
  assert.equal(
    analyzeHtml('<div id="root"><a href="/about">About</a></div><script src="/app.js"></script>', PAGE_URL, 200, 0).javascriptShell,
    false,
  );
  assert.equal(
    analyzeHtml('<div id="app"><img src="/photo.png"></div><script src="/app.js"></script>', PAGE_URL, 200, 0).javascriptShell,
    false,
  );
  assert.equal(
    analyzeHtml('<div id="root"></div><script type="application/ld+json">{}</script>', PAGE_URL, 200, 0).javascriptShell,
    false,
  );
  assert.equal(
    analyzeHtml('<p>Short content</p><script src="/analytics.js"></script>', PAGE_URL, 200, 0).javascriptShell,
    false,
  );
  assert.equal(
    analyzeHtml('<div id="root"></div>', PAGE_URL, 200, 0).javascriptShell,
    false,
  );
});

test("analyzeHtml extracts hreflang pairs with resolved relative hrefs", () => {
  const html = `<head>
    <link rel="alternate" hreflang="es" href="/es/articulo">
    <link rel="alternate" hreflang="fr" href="https://fr.example.com/post">
    <link rel="alternate" hreflang="x-default" href="/intl">
  </head>`;
  const res = analyzeHtml(html, PAGE_URL, 200, 10);
  assert.deepEqual(res.hreflang, [
    { lang: "es", href: "https://example.com/es/articulo" },
    { lang: "fr", href: "https://fr.example.com/post" },
    { lang: "x-default", href: "https://example.com/intl" },
  ]);
});

test("analyzeHtml captures ld+json with uppercase type, parameters, caps at 20 blocks, and cuts 65KB block", () => {
  const blocks = Array.from(
    { length: 25 },
    (_, i) => `<script type="APPLICATION/LD+JSON; charset=utf-8">{"index":${i}}</script>`,
  ).join("\n");
  const bigBlock = `<script type="application/ld+json">${"x".repeat(70_000)}</script>`;

  const html = `<html><head>${blocks}${bigBlock}</head><body></body></html>`;
  const res = analyzeHtml(html, PAGE_URL, 200, 10);

  // Exactly 20 blocks captured, 21st through 26th ignored
  assert.equal(res.jsonLdBlocks.length, 20);
  assert.equal(res.hasStructuredData, true);
  assert.equal(res.jsonLdBlocks[0], '{"index":0}');
  assert.equal(res.jsonLdBlocks[19], '{"index":19}');

  // Single big block
  const bigRes = analyzeHtml(`<html><head>${bigBlock}</head></html>`, PAGE_URL, 200, 10);
  assert.equal(bigRes.jsonLdBlocks.length, 1);
  assert.ok(bigRes.jsonLdBlocks[0].includes("/*CUT*/"));
  assert.equal(bigRes.jsonLdBlocks[0].length, 65_536 + "/*CUT*/".length);
});

test("analyzeHtml tracks data-nosnippet and ignores it inside noscript", () => {
  const htmlInsideNoscript = `<body>
    <noscript><div data-nosnippet>No snippet inside noscript</div></noscript>
    <p>Normal text</p>
  </body>`;
  const res1 = analyzeHtml(htmlInsideNoscript, PAGE_URL, 200, 10);
  assert.equal(res1.dataNosnippet, false);

  const htmlOutsideNoscript = `<body>
    <div data-nosnippet>Restricted text</div>
  </body>`;
  const res2 = analyzeHtml(htmlOutsideNoscript, PAGE_URL, 200, 10);
  assert.equal(res2.dataNosnippet, true);
});
