import test from "node:test";
import assert from "node:assert/strict";
import {
  createMapSitePagesTool,
  createReadPagesTool,
  extractTitle,
  htmlToText,
  isAllowedReadUrl,
} from "./siteReading.ts";
import type { ToolHandlerContext, TurnMemory } from "../types.ts";

function context(overrides: Partial<ToolHandlerContext["brand"]> = {}): ToolHandlerContext {
  return {
    admin: {} as any,
    brand: {
      brandKey: "brand-a",
      role: "owner",
      display_name: "Acme",
      website: "https://acme.test",
      website_host: "acme.test",
      aliases: [],
      is_active: true,
      ...overrides,
    },
    userId: "user-a",
    user: { id: "user-a", email: "owner@acme.test" },
    role: "owner",
    requestId: "test",
    source: "test",
  };
}

function response(url: string, status = 200, body = "") {
  return {
    url,
    status,
    headers: new Headers(),
    body: new Uint8Array(),
    truncated: false,
    text: () => body,
    json: () => JSON.parse(body),
  } as any;
}

function noCitations() {
  return async () => [] as readonly string[];
}

test("own host and its subdomains are allowed on any path and query", async () => {
  const ctx = context();
  assert.equal(
    await isAllowedReadUrl("https://acme.test/pricing?plan=pro", ctx, undefined, {
      competitorDomains: [],
      citationUrls: noCitations(),
    }),
    true,
  );
  assert.equal(
    await isAllowedReadUrl("https://blog.acme.test/posts/one", ctx, undefined, {
      competitorDomains: [],
      citationUrls: noCitations(),
    }),
    true,
  );
  assert.equal(
    await isAllowedReadUrl("https://www.acme.test/", ctx, undefined, {
      competitorDomains: [],
      citationUrls: noCitations(),
    }),
    true,
  );
});

test("an unrelated host is refused", async () => {
  assert.equal(
    await isAllowedReadUrl("https://evil.example/", context(), undefined, {
      competitorDomains: ["rival.example"],
      citationUrls: noCitations(),
    }),
    false,
  );
});

test("a declared competitor's homepage is allowed but a deep URL is not", async () => {
  const ctx = context();
  const deps = { competitorDomains: ["rival.example"], citationUrls: noCitations() };

  assert.equal(await isAllowedReadUrl("https://rival.example/", ctx, undefined, deps), true);
  assert.equal(
    await isAllowedReadUrl("https://www.rival.example/", ctx, undefined, deps),
    true,
  );
  assert.equal(
    await isAllowedReadUrl("https://rival.example/blog/post", ctx, undefined, deps),
    false,
  );
});

test("a competitor deep URL is allowed after map_site_pages stored it this turn", async () => {
  const ctx = context();
  const memory: TurnMemory = {};
  const deps = { competitorDomains: ["rival.example"], citationUrls: noCitations() };

  assert.equal(
    await isAllowedReadUrl("https://rival.example/blog/post", ctx, memory, deps),
    false,
  );

  memory.mappedUrls = {
    "rival.example": ["https://rival.example/blog/post", "https://rival.example/about"],
  };

  assert.equal(
    await isAllowedReadUrl("https://rival.example/blog/post", ctx, memory, deps),
    true,
  );
  assert.equal(
    await isAllowedReadUrl("https://rival.example/blog/other", ctx, memory, deps),
    false,
  );
});

test("stored citations allow the exact URL, fragments stripped, and nothing else on the host", async () => {
  const ctx = context();
  const deps = {
    competitorDomains: [],
    citationUrls: async () => ["https://news.example/story"],
  };

  assert.equal(
    await isAllowedReadUrl("https://news.example/story", ctx, undefined, deps),
    true,
  );
  assert.equal(
    await isAllowedReadUrl("https://news.example/story#section-2", ctx, undefined, deps),
    true,
  );
  assert.equal(
    await isAllowedReadUrl("https://news.example/other", ctx, undefined, deps),
    false,
  );
});

test("non-http schemes are refused even on an allowed host", async () => {
  assert.equal(
    await isAllowedReadUrl("ftp://acme.test/file", context(), undefined, {
      competitorDomains: [],
      citationUrls: noCitations(),
    }),
    false,
  );
});

test("htmlToText matches the ported scraper behaviour", () => {
  const html =
    "<html><head><title>Acme &amp; Co</title><style>.x{color:red}</style></head>" +
    "<body><!-- hidden --><script>alert('no')</script><h1>Hello&nbsp;<b>world</b></h1>" +
    "<noscript>enable js</noscript><p>Fish &amp; chips &#39;today&#39;</p></body></html>";

  assert.equal(htmlToText(html), "Acme & Co Hello  world Fish & chips 'today'");
  assert.equal(extractTitle(html), "Acme & Co");
  assert.equal(extractTitle("<html><body>none</body></html>"), null);
});

test("map_site_pages defaults to the workspace host, keeps origin sitemap URLs and caps at 60", async () => {
  const ctx = context();
  const fetched: string[] = [];
  const locs = Array.from({ length: 70 }, (_, i) => `  <loc>https://acme.test/p${i}</loc>`).join("\n");
  const sitemap =
    `<?xml version="1.0"?><urlset>\n${locs}\n` +
    "<url><loc>https://acme.test/sitemap.xml</loc></url>" +
    "<url><loc>https://other.example/out</loc></url></urlset>";
  const memory: TurnMemory = {};
  ctx.turnMemory = memory;

  const tool = createMapSitePagesTool({
    competitorDomains: [],
    safeFetch: (async (url: string) => {
      fetched.push(url);
      return response(url, 200, sitemap);
    }) as any,
  });

  const output = (await tool.handler(ctx, {})) as any;

  assert.deepEqual(fetched, ["https://acme.test/sitemap.xml"]);
  assert.equal(output.host, "acme.test");
  assert.equal(output.blocked, false);
  assert.equal(output.urls.length, 60);
  assert.equal(output.urls[0], "https://acme.test/");
  assert.equal(output.urls.includes("https://other.example/out"), false);
  assert.equal(output.urls.includes("https://acme.test/sitemap.xml"), false);
  assert.deepEqual(memory.mappedUrls?.["acme.test"], output.urls);
});

test("map_site_pages refuses an undeclared host without fetching", async () => {
  let calls = 0;
  const tool = createMapSitePagesTool({
    competitorDomains: [],
    safeFetch: (async () => {
      calls += 1;
      return response("https://evil.example/sitemap.xml", 200, "<urlset></urlset>");
    }) as any,
  });

  const output = (await tool.handler(context(), { host: "evil.example" })) as any;

  assert.equal(calls, 0);
  assert.deepEqual(output, { host: "evil.example", urls: [], blocked: true });
});

test("map_site_pages accepts a declared competitor host", async () => {
  const tool = createMapSitePagesTool({
    competitorDomains: ["rival.example"],
    safeFetch: (async (url: string) =>
      response(url, 200, "<urlset><url><loc>https://rival.example/pricing</loc></url></urlset>")) as any,
  });

  const output = (await tool.handler(context(), { host: "www.rival.example" })) as any;

  assert.equal(output.host, "rival.example");
  assert.deepEqual(output.urls, ["https://rival.example/", "https://rival.example/pricing"]);
  assert.equal(output.blocked, false);
});

test("read_pages reads allowed pages, maps title and reports each skip reason", async () => {
  const ctx = context();
  const memory: TurnMemory = {
    mappedUrls: { "rival.example": ["https://rival.example/about"] },
  };
  ctx.turnMemory = memory;

  const tool = createReadPagesTool({
    competitorDomains: ["rival.example"],
    citationUrls: async () => [],
    safeFetch: (async (url: string) => {
      if (url === "https://acme.test/") {
        return response(url, 200, "<title>Acme Home</title><p>Hello &amp; welcome</p>");
      }
      if (url === "https://rival.example/about") {
        return response(url, 200, "<title>About Rival</title><p>Rival text</p>");
      }
      if (url === "https://acme.test/forbidden") return response(url, 403, "no");
      if (url === "https://acme.test/empty") return response(url, 200, "<script>only</script>");
      throw new Error("offline");
    }) as any,
  });

  const output = (await tool.handler(ctx, {
    urls: [
      "https://acme.test/",
      "https://rival.example/about",
      "https://evil.example/",
      "https://acme.test/forbidden",
      "https://acme.test/empty",
      "https://acme.test/down",
    ],
  })) as any;

  assert.deepEqual(output.pages, [
    { url: "https://acme.test/", title: "Acme Home", text: "Acme Home Hello & welcome" },
    { url: "https://rival.example/about", title: "About Rival", text: "About Rival Rival text" },
  ]);
  assert.deepEqual(output.skipped, [
    { url: "https://evil.example/", reason: "host_not_allowed" },
    { url: "https://acme.test/forbidden", reason: "blocked" },
    { url: "https://acme.test/empty", reason: "empty" },
    { url: "https://acme.test/down", reason: "unreachable" },
  ]);
});

test("read_pages refuses a same-host redirect from a mapped competitor page to an unmapped URL", async () => {
  const ctx = context();
  ctx.turnMemory = {
    mappedUrls: { "rival.example": ["https://rival.example/about"] },
  };
  const tool = createReadPagesTool({
    competitorDomains: ["rival.example"],
    citationUrls: async () => [],
    safeFetch: (async () =>
      response("https://rival.example/private", 200, "<title>Private</title><p>Secret</p>")) as any,
  });

  const output = (await tool.handler(ctx, {
    urls: ["https://rival.example/about"],
  })) as any;

  assert.deepEqual(output.pages, []);
  assert.deepEqual(output.skipped, [
    { url: "https://rival.example/about", reason: "host_not_allowed" },
  ]);
});

test("read_pages still reads a mapped competitor URL that does not redirect", async () => {
  const ctx = context();
  ctx.turnMemory = {
    mappedUrls: { "rival.example": ["https://rival.example/about"] },
  };
  const tool = createReadPagesTool({
    competitorDomains: ["rival.example"],
    citationUrls: async () => [],
    safeFetch: (async (url: string) =>
      response(url, 200, "<title>About Rival</title><p>Rival text</p>")) as any,
  });

  const output = (await tool.handler(ctx, {
    urls: ["https://rival.example/about"],
  })) as any;

  assert.equal(output.pages.length, 1);
  assert.equal(output.pages[0].url, "https://rival.example/about");
  assert.deepEqual(output.skipped, []);
});

test("read_pages truncates text at 4,000 characters", async () => {
  const tool = createReadPagesTool({
    competitorDomains: [],
    citationUrls: async () => [],
    safeFetch: (async (url: string) =>
      response(url, 200, "<p>" + "x".repeat(5000) + "</p>")) as any,
  });

  const output = (await tool.handler(context(), { urls: ["https://acme.test/"] })) as any;

  assert.equal(output.pages.length, 1);
  assert.equal(output.pages[0].text.length, 4000);
});
