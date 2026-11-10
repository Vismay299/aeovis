// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/backlinks.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UnbilledCallError } from "../../spend/errors.ts";
import {
  BACKLINKS_DEFAULT_LIMIT,
  DEFAULT_BACKLINKS_SPAM_THRESHOLD,
  createBacklinksClient,
  fetchBacklinksHistory,
  fetchBacklinksRows,
  fetchBacklinksSummary,
  fetchDomainPagesSummary,
  fetchReferringDomains,
} from "./backlinks.ts";

const billed = {
  path: ["v3", "backlinks", "summary", "live"],
  cost: 0.024036,
  result_count: 0,
};

function okResponse(result: unknown[], path = ["v3", "backlinks", "summary", "live"]) {
  return new Response(
    JSON.stringify({
      status_code: 20000,
      status_message: "Ok.",
      tasks: [{ status_code: 20000, status_message: "Ok.", path, cost: 0.024036, result_count: result.length, result }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function parseBody(fetchCall: [string, RequestInit]): unknown {
  const body = fetchCall[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected DataForSEO request body to be a string");
  }
  return JSON.parse(body);
}

describe("backlinks provider", () => {
  const env = { DATAFORSEO_API_KEY: "test-only-key" };

  describe("fetchBacklinksSummary", () => {
    it("classifies top-level DataForSEO body errors through F02 to UnbilledCallError/dataforseo_balance", async () => {
      const fetchImpl: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            status_code: 40200,
            status_message: "Account balance is too low",
            tasks: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );

      await assert.rejects(
        () => fetchBacklinksSummary({ target: "example.com" }, { env, fetchImpl }),
        (err: unknown) => {
          assert.ok(err instanceof UnbilledCallError);
          assert.equal(err.code, "dataforseo_balance");
          assert.equal(err.status, 402);
          return true;
        },
      );
    });

    it("treats [null] and [[]] summary results as a valid zero-data response", async () => {
      for (const result of [[null], []]) {
        const fetchImpl: typeof fetch = async () => okResponse(result);
        const res = await fetchBacklinksSummary({ target: "example.com" }, { env, fetchImpl });
        assert.deepEqual(res.data, {});
      }
    });

    it("asks DataForSEO to exclude subdomains for a domain-scoped target", async () => {
      let capturedBody: unknown;
      const fetchImpl: typeof fetch = async (url, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return okResponse([]);
      };

      await fetchBacklinksSummary(
        { target: "example.com", includeSubdomains: false },
        { env, fetchImpl },
      );

      assert.deepEqual(capturedBody, [
        {
          target: "example.com",
          include_subdomains: false,
          include_indirect_links: true,
          exclude_internal_backlinks: true,
          backlinks_status_type: "live",
          rank_scale: "one_hundred",
        },
      ]);
    });

    it("parses summary fixture including misspelled reffering keys", async () => {
      const fixtureText = readFileSync(
        join(process.cwd(), "tests/fixtures/f16/backlinks-summary.json"),
        "utf8",
      );
      const fetchImpl: typeof fetch = async () =>
        new Response(fixtureText, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      const res = await fetchBacklinksSummary({ target: "example.com" }, { env, fetchImpl });
      assert.equal(res.data.rank, 21);
      assert.equal(res.data.backlinks, 4120);
      assert.equal(res.data.referring_domains, 312);
      assert.equal(res.data.new_reffering_domains, 9);
      assert.equal(res.data.lost_reffering_domains, 5);
      assert.equal(res.data.backlinks_spam_score, 12);
      assert.equal(res.data.info?.target_spam_score, 4);
      assert.equal(res.billing.costUsd, 0.024036);
    });
  });

  describe("fetchBacklinksRows", () => {
    it("sends OpenSEO common payload, defaults, and preserves user filters and pagination with hideSpam=true/false", async () => {
      for (const hideSpam of [undefined, true, false]) {
        let capturedUrl: string | undefined;
        let capturedBody: unknown;
        const fetchImpl: typeof fetch = async (url, init) => {
          capturedUrl = String(url);
          capturedBody = JSON.parse(init?.body as string);
          return okResponse([], ["v3", "backlinks", "backlinks", "live"]);
        };

        const filters = [["domain_from", "=", "openseo.so"]];
        await fetchBacklinksRows(
          {
            target: "openseo.so",
            mode: "as_is",
            offset: 50,
            limit: 50,
            hideSpam,
            filters,
          },
          { env, fetchImpl },
        );

        assert.ok(capturedUrl?.includes("/v3/backlinks/backlinks/live"));
        const expectedFilters =
          hideSpam === false
            ? filters
            : [
                ...filters,
                "and",
                [
                  ["backlink_spam_score", "<", DEFAULT_BACKLINKS_SPAM_THRESHOLD],
                  "or",
                  ["backlink_spam_score", "=", null],
                ],
              ];

        assert.deepEqual(capturedBody, [
          {
            target: "openseo.so",
            include_subdomains: true,
            include_indirect_links: true,
            exclude_internal_backlinks: true,
            backlinks_status_type: "live",
            rank_scale: "one_hundred",
            limit: 50,
            offset: 50,
            order_by: ["rank,desc"],
            mode: "as_is",
            filters: expectedFilters,
          },
        ]);
      }
    });

    it("parses backlinks rows fixture with spam scores", async () => {
      const fixtureText = readFileSync(
        join(process.cwd(), "tests/fixtures/f16/backlinks-rows.json"),
        "utf8",
      );
      const fetchImpl: typeof fetch = async () =>
        new Response(fixtureText, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      const res = await fetchBacklinksRows({ target: "example.com" }, { env, fetchImpl });
      assert.equal(res.data.totalCount, 3);
      assert.equal(res.data.items.length, 3);
      assert.equal(res.data.items[0].domain_from, "source-clean.com");
      assert.equal(res.data.items[0].backlink_spam_score, 0);
      assert.equal(res.data.items[1].backlink_spam_score, null);
      assert.equal(res.data.items[2].backlink_spam_score, 55);
    });
  });

  describe("fetchReferringDomains", () => {
    it("sends correct endpoint, ordering, and spam filter condition", async () => {
      for (const hideSpam of [true, false]) {
        let capturedUrl: string | undefined;
        let capturedBody: unknown;
        const fetchImpl: typeof fetch = async (url, init) => {
          capturedUrl = String(url);
          capturedBody = JSON.parse(init?.body as string);
          return okResponse([], ["v3", "backlinks", "referring_domains", "live"]);
        };

        await fetchReferringDomains(
          {
            target: "example.com",
            limit: 100,
            hideSpam,
          },
          { env, fetchImpl },
        );

        assert.ok(capturedUrl?.includes("/v3/backlinks/referring_domains/live"));
        const expectedFilters =
          hideSpam
            ? [["backlinks_spam_score", "<=", DEFAULT_BACKLINKS_SPAM_THRESHOLD]]
            : undefined;

        assert.deepEqual(capturedBody, [
          {
            target: "example.com",
            include_subdomains: true,
            include_indirect_links: true,
            exclude_internal_backlinks: true,
            backlinks_status_type: "live",
            rank_scale: "one_hundred",
            limit: 100,
            order_by: ["backlinks,desc"],
            ...(expectedFilters ? { filters: expectedFilters } : {}),
          },
        ]);
      }
    });

    it("parses referring domains fixture", async () => {
      const fixtureText = readFileSync(
        join(process.cwd(), "tests/fixtures/f16/backlinks-referring-domains.json"),
        "utf8",
      );
      const fetchImpl: typeof fetch = async () =>
        new Response(fixtureText, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      const res = await fetchReferringDomains({ target: "example.com" }, { env, fetchImpl });
      assert.equal(res.data.totalCount, 1);
      assert.equal(res.data.items[0].domain, "partner.com");
      assert.equal(res.data.items[0].backlinks, 45);
      assert.equal(res.data.items[0].backlinks_spam_score, 8);
    });
  });

  describe("fetchDomainPagesSummary", () => {
    it("sends correct endpoint, ordering, and user filters", async () => {
      let capturedUrl: string | undefined;
      let capturedBody: unknown;
      const fetchImpl: typeof fetch = async (url, init) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(init?.body as string);
        return okResponse([], ["v3", "backlinks", "domain_pages_summary", "live"]);
      };

      const userFilters = [["page", "like", "%/pricing%"]];
      await fetchDomainPagesSummary(
        {
          target: "example.com",
          limit: 50,
          offset: 10,
          filters: userFilters,
        },
        { env, fetchImpl },
      );

      assert.ok(capturedUrl?.includes("/v3/backlinks/domain_pages_summary/live"));
      assert.deepEqual(capturedBody, [
        {
          target: "example.com",
          include_subdomains: true,
          include_indirect_links: true,
          exclude_internal_backlinks: true,
          backlinks_status_type: "live",
          rank_scale: "one_hundred",
          limit: 50,
          offset: 10,
          order_by: ["backlinks,desc"],
          filters: userFilters,
        },
      ]);
    });

    it("parses domain pages summary fixture", async () => {
      const fixtureText = readFileSync(
        join(process.cwd(), "tests/fixtures/f16/backlinks-domain-pages.json"),
        "utf8",
      );
      const fetchImpl: typeof fetch = async () =>
        new Response(fixtureText, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      const res = await fetchDomainPagesSummary({ target: "example.com" }, { env, fetchImpl });
      assert.equal(res.data.totalCount, 1);
      assert.equal(res.data.items[0].page, "/pricing");
      assert.equal(res.data.items[0].backlinks, 120);
    });
  });

  describe("fetchBacklinksHistory", () => {
    it("sends correct endpoint and date range payload without include_subdomains", async () => {
      let capturedUrl: string | undefined;
      let capturedBody: unknown;
      const fetchImpl: typeof fetch = async (url, init) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(init?.body as string);
        return okResponse([], ["v3", "backlinks", "history", "live"]);
      };

      await fetchBacklinksHistory(
        {
          target: "example.com",
          dateFrom: "2025-10-31",
          dateTo: "2026-10-30",
        },
        { env, fetchImpl },
      );

      assert.ok(capturedUrl?.includes("/v3/backlinks/history/live"));
      assert.deepEqual(capturedBody, [
        {
          target: "example.com",
          date_from: "2025-10-31",
          date_to: "2026-10-30",
          rank_scale: "one_hundred",
        },
      ]);
    });

    it("parses backlinks history fixture", async () => {
      const fixtureText = readFileSync(
        join(process.cwd(), "tests/fixtures/f16/backlinks-history.json"),
        "utf8",
      );
      const fetchImpl: typeof fetch = async () =>
        new Response(fixtureText, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      const res = await fetchBacklinksHistory(
        { target: "example.com", dateFrom: "2025-10-31", dateTo: "2025-12-31" },
        { env, fetchImpl },
      );
      assert.equal(res.data.length, 2);
      assert.equal(res.data[0].date, "2025-10-31");
      assert.equal(res.data[0].backlinks, 3810);
      assert.equal(res.data[1].date, "2025-12-31");
      assert.equal(res.data[1].backlinks, 4050);
    });
  });

  describe("createBacklinksClient", () => {
    it("every entry is priced", () => {
      type RegisteredMeterCall = {
        fetcher: unknown;
        estimate: (i: unknown) => number;
        defaultFeature: string | null;
      };

      const registrations: Record<string, RegisteredMeterCall> = {};

      const spyMeter = (
        fetcher: unknown,
        estimate: (i: unknown) => number,
        defaultFeature: string | null,
      ) => {
        const entry = { fetcher, estimate, defaultFeature };
        return entry;
      };

      const client = createBacklinksClient({ meter: spyMeter as any }) as unknown as Record<
        string,
        RegisteredMeterCall
      >;

      const expectedEntries = [
        "summary",
        "rows",
        "referringDomains",
        "domainPages",
        "history",
      ] as const;

      assert.deepEqual(Object.keys(client).sort(), [...expectedEntries].sort());

      for (const name of expectedEntries) {
        const reg = client[name];
        assert.ok(reg, `Missing registration for ${name}`);
        assert.equal(
          reg.defaultFeature,
          "backlinks.research",
          `${name} must use default feature backlinks.research`,
        );

        let sampleInput: unknown;
        if (name === "summary") sampleInput = { target: "example.com" };
        else if (name === "rows" || name === "referringDomains" || name === "domainPages")
          sampleInput = { target: "example.com", limit: BACKLINKS_DEFAULT_LIMIT };
        else if (name === "history")
          sampleInput = { target: "example.com", dateFrom: "2025-01-01", dateTo: "2025-01-10" };

        const est = reg.estimate(sampleInput);
        assert.ok(
          typeof est === "number" && est > 0,
          `${name} estimate must be > 0 (got ${est})`,
        );
      }
    });
  });
});
