// In-memory node:http server for site-audit test fixtures.

import http from "node:http";
import { SITES } from "./sites.ts";
import { findFixture, FIXTURES } from "./registry.ts";
import { renderDocument, escapeHtml, lorem } from "./fixtures/helpers.ts";
import type { SiteId } from "./types.ts";

export interface FixtureServer {
  port: number;
  origin: string;
  close: () => Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server = http.createServer(async (req, res) => {
    const siteId = (req.headers["x-fixture-site"] as SiteId) || "main";
    const site = SITES[siteId] ?? SITES.main;
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = url.pathname;

    // 1. Throttled site: every page is 429 except robots.txt and llms.txt
    if (siteId === "throttled" && pathname !== "/robots.txt" && pathname !== "/llms.txt") {
      res.writeHead(429, {
        "retry-after": "7200",
        "content-type": "text/plain",
      });
      res.end("Too Many Requests");
      return;
    }

    // 2. Robots.txt
    if (pathname === "/robots.txt") {
      if (site.robotsText === null) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Internal Server Error");
        return;
      }
      if (siteId === "robotshtml") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(site.robotsText);
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(site.robotsText);
      return;
    }

    // 3. Llms.txt
    if (pathname === "/llms.txt") {
      if (site.llmsTxt) {
        res.writeHead(site.llmsTxt.status, {
          "content-type": site.llmsTxt.contentType,
        });
        res.end(site.llmsTxt.body);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return;
    }

    // 4. Sitemap.xml
    if (pathname === "/sitemap.xml") {
      const urls = [
        `http://${site.host}/`,
        ...FIXTURES.filter(
          (f) => (f.site ?? "main") === siteId && f.inSitemap !== false,
        ).map((f) => `http://${site.host}${f.path}`),
      ];
      const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset>${urls
        .map((u) => `<url><loc>${u}</loc></url>`)
        .join("")}</urlset>`;
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(xml);
      return;
    }

    // 5. Fixtures dispatch
    const fixture = findFixture(pathname, siteId);
    if (fixture) {
      const standardReq = new Request(`http://${site.host}${pathname}`, {
        method: req.method,
        headers: req.headers as any,
      });
      const response = await fixture.handler({
        origin: `http://${site.host}`,
        request: standardReq,
        path: pathname,
        site: siteId,
      });

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((val, key) => {
        responseHeaders[key] = val;
      });
      res.writeHead(response.status, responseHeaders);
      const body = await response.arrayBuffer();
      res.end(Buffer.from(body));
      return;
    }

    // 6. Homepage / catalog
    if (pathname === "/" || pathname === "/catalog") {
      const links = FIXTURES.filter(
        (f) => (f.site ?? "main") === siteId && f.linkedFromCatalog !== false,
      )
        .map((f) => `<li><a href="${f.path}">${escapeHtml(f.name)}</a></li>`)
        .join("\n");
      const html = renderDocument({
        title: pathname === "/" ? "Fixture Site Homepage" : "Fixture Site Catalog",
        metaDescription:
          "A valid meta description that is long enough to avoid being flagged as too short.",
        ogTitle: pathname === "/" ? "Fixture Site Homepage" : "Fixture Site Catalog",
        ogDescription: "A valid Open Graph description for the fixture site.",
        ogImage: `http://${site.host}/images/og.png`,
        bodyHtml: `<h1>${pathname === "/" ? "Fixture Catalog" : "Catalog"}</h1><p>${lorem(180)}</p><ul>${links}</ul>`,
      });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // 7. Static dummy image / assets
    if (pathname.startsWith("/images/")) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.alloc(10));
      return;
    }

    // 8. Not found
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      const port = addr.port;
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
