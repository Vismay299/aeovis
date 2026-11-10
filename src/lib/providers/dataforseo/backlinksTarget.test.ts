// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/backlinks.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AppError } from "../../http/appError.ts";
import { normalizeBacklinksTarget } from "./backlinksTarget.ts";

describe("normalizeBacklinksTarget", () => {
  const cases = [
    {
      input: "Example.com",
      options: undefined,
      expected: {
        apiTarget: "example.com",
        displayTarget: "example.com",
        scope: "subdomains",
        includeSubdomains: true,
        path: "",
      },
    },
    {
      input: "https://github.com/every-app/open-seo/",
      options: undefined,
      expected: {
        apiTarget: "github.com",
        displayTarget: "github.com/every-app/open-seo",
        scope: "subfolder",
        includeSubdomains: false,
        path: "/every-app/open-seo",
      },
    },
    {
      input: "https://Example.com/pricing",
      options: { scope: "subdomains" as const },
      expected: {
        apiTarget: "example.com",
        displayTarget: "example.com",
        scope: "subdomains",
        includeSubdomains: true,
        path: "",
      },
    },
    {
      input: "Example.com",
      options: { scope: "domain" as const },
      expected: {
        apiTarget: "example.com",
        displayTarget: "example.com",
        scope: "domain",
        includeSubdomains: false,
        path: "",
      },
    },
  ];

  for (const tc of cases) {
    it(`maps ${tc.input} with scope ${tc.options?.scope} onto includeSubdomains/path`, () => {
      assert.deepEqual(normalizeBacklinksTarget(tc.input, tc.options), tc.expected);
    });
  }

  for (const scope of ["exact_url", "page"] as const) {
    it(`builds an absolute page URL for bare hostnames with scope ${scope}`, () => {
      assert.deepEqual(normalizeBacklinksTarget("Example.com", { scope }), {
        apiTarget: "https://example.com/",
        displayTarget: "https://example.com/",
        scope: "exact_url",
        includeSubdomains: true,
        path: "",
      });
    });
  }

  it("preserves explicit http:// protocol for exact_url scope", () => {
    assert.deepEqual(
      normalizeBacklinksTarget("http://example.com/pricing", { scope: "exact_url" }),
      {
        apiTarget: "http://example.com/pricing",
        displayTarget: "http://example.com/pricing",
        scope: "exact_url",
        includeSubdomains: true,
        path: "",
      },
    );
  });

  it("rejects exact-url targets with query strings or fragments", () => {
    assert.throws(
      () =>
        normalizeBacklinksTarget(
          "https://example.com/pricing?token=secret#hero",
          { scope: "exact_url" },
        ),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "invalid_target");
        assert.equal(
          err.message,
          "Page URLs with query strings or fragments are not supported",
        );
        return true;
      },
    );
  });

  it("rejects empty or invalid inputs with AppError(400, 'invalid_target')", () => {
    assert.throws(
      () => normalizeBacklinksTarget(""),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "invalid_target");
        return true;
      },
    );

    assert.throws(
      () => normalizeBacklinksTarget("not_a_valid_domain"),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "invalid_target");
        return true;
      },
    );
  });
});
