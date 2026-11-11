import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIRECRAWL_SCRAPE_USD_DEFAULT, firecrawlScrapeUsd } from "./firecrawl.ts";

describe("firecrawl pricing", () => {
  it("defaults to 0.005", () => {
    assert.equal(firecrawlScrapeUsd({}), FIRECRAWL_SCRAPE_USD_DEFAULT);
    assert.equal(firecrawlScrapeUsd({ FIRECRAWL_SCRAPE_USD: "" }), FIRECRAWL_SCRAPE_USD_DEFAULT);
    assert.equal(firecrawlScrapeUsd({ FIRECRAWL_SCRAPE_USD: "invalid" }), FIRECRAWL_SCRAPE_USD_DEFAULT);
    assert.equal(firecrawlScrapeUsd({ FIRECRAWL_SCRAPE_USD: "-1" }), FIRECRAWL_SCRAPE_USD_DEFAULT);
    assert.equal(firecrawlScrapeUsd({ FIRECRAWL_SCRAPE_USD: "0" }), FIRECRAWL_SCRAPE_USD_DEFAULT);
  });

  it("reads env override when positive number", () => {
    assert.equal(firecrawlScrapeUsd({ FIRECRAWL_SCRAPE_USD: "0.01" }), 0.01);
    assert.equal(firecrawlScrapeUsd({ FIRECRAWL_SCRAPE_USD: "0.002" }), 0.002);
  });
});
