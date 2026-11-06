// Virtual hosts configuration for site audit fixture sites.

import type { SiteConfig, SiteId } from "./types.ts";

export const SITES: Record<SiteId, SiteConfig> = {
  main: {
    id: "main",
    host: "main.audit.test",
    expectedSiteIssues: ["ai-training-crawler-blocked", "llms-txt-missing"],
    robotsText: `User-agent: *
Allow: /

User-agent: GPTBot
Disallow: /

User-agent: OAI-SearchBot
Disallow: /ai/search-blocked

User-agent: ChatGPT-User
Disallow: /ai/agent-blocked
`,
    llmsTxt: {
      status: 404,
      contentType: "text/plain",
      body: "Not found",
    },
  },
  llmsbad: {
    id: "llmsbad",
    host: "llmsbad.audit.test",
    expectedSiteIssues: ["llms-txt-invalid"],
    robotsText: `User-agent: *
Allow: /
`,
    llmsTxt: {
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><body>Not markdown</body></html>",
    },
  },
  robots500: {
    id: "robots500",
    host: "robots500.audit.test",
    expectedSiteIssues: ["robots-txt-unavailable"],
    robotsText: null, // triggers 500 response
    llmsTxt: {
      status: 200,
      contentType: "text/markdown",
      body: "# Title\n> Description\n- [Link](https://example.com)",
    },
  },
  robotshtml: {
    id: "robotshtml",
    host: "robotshtml.audit.test",
    expectedSiteIssues: ["robots-txt-malformed"],
    robotsText: "<!doctype html><html><body>HTML error page at robots.txt</body></html>",
    llmsTxt: {
      status: 200,
      contentType: "text/markdown",
      body: "# Title\n> Description\n- [Link](https://example.com)",
    },
  },
  closed: {
    id: "closed",
    host: "closed.audit.test",
    expectedSiteIssues: ["crawl-blocked-by-robots"],
    robotsText: `User-agent: *
Disallow: /
`,
    llmsTxt: {
      status: 200,
      contentType: "text/markdown",
      body: "# Title\n> Description\n- [Link](https://example.com)",
    },
  },
  throttled: {
    id: "throttled",
    host: "throttled.audit.test",
    expectedSiteIssues: ["crawl-rate-limited"],
    robotsText: `User-agent: *
Allow: /
`,
    llmsTxt: {
      status: 200,
      contentType: "text/markdown",
      body: "# Title\n> Description\n- [Link](https://example.com)",
    },
  },
};
