// Helpers for rendering fixture pages.

export function htmlResponse(
  bodyHtml: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(bodyHtml, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...headers,
    },
  });
}

export interface ChromeOptions {
  title?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  robotsMeta?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  headExtra?: string;
  jsonLd?: string | null;
  bodyHtml?: string;
  dataNosnippet?: boolean;
}

export function renderDocument(opts: ChromeOptions): string {
  const headParts: string[] = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
  ];

  if (opts.title !== undefined) {
    headParts.push(`<title>${opts.title}</title>`);
  }
  if (opts.metaDescription !== undefined) {
    headParts.push(`<meta name="description" content="${opts.metaDescription}">`);
  }
  if (opts.canonicalUrl) {
    headParts.push(`<link rel="canonical" href="${opts.canonicalUrl}">`);
  }
  if (opts.robotsMeta) {
    headParts.push(`<meta name="robots" content="${opts.robotsMeta}">`);
  }
  if (opts.ogTitle !== undefined) {
    headParts.push(`<meta property="og:title" content="${opts.ogTitle}">`);
  }
  if (opts.ogDescription !== undefined) {
    headParts.push(`<meta property="og:description" content="${opts.ogDescription}">`);
  }
  if (opts.ogImage !== undefined) {
    headParts.push(`<meta property="og:image" content="${opts.ogImage}">`);
  }
  if (opts.jsonLd !== null && opts.jsonLd !== undefined) {
    headParts.push(`<script type="application/ld+json">${opts.jsonLd}</script>`);
  } else if (opts.jsonLd === undefined) {
    headParts.push(
      `<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Default WebPage"}</script>`,
    );
  }
  if (opts.headExtra) {
    headParts.push(opts.headExtra);
  }

  const bodyAttrs = opts.dataNosnippet ? " data-nosnippet" : "";
  const body =
    opts.bodyHtml ??
    `<p>${lorem(180)}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
${headParts.join("\n")}
</head>
<body${bodyAttrs}>
<header><nav><a href="/">Home</a> | <a href="/catalog">Catalog</a></nav></header>
<main>
${body}
</main>
<footer><p>© 2026 Test Suite</p></footer>
</body>
</html>`;
}

export function lorem(words: number): string {
  const bank =
    "the quick brown fox jumps over a lazy search engine while crawling deep into a sprawling website looking for signals headings titles descriptions and links that help people find genuinely useful content on the open web".split(
      " ",
    );
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(bank[i % bank.length]);
  return out.join(" ");
}
