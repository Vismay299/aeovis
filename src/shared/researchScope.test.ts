import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseResearchTarget, urlMatchesResearchTarget } from "./researchScope.ts";

function parseOk(
  input: string,
  scope?: Parameters<typeof parseResearchTarget>[1],
) {
  const result = parseResearchTarget(input, scope);
  if (!result.ok) throw new Error(`expected ok parse, got: ${result.message}`);
  return result.target;
}

describe("parseResearchTarget", () => {
  it("defaults a root domain to subdomains scope", () => {
    const target = parseOk("Example.com");
    assert.equal(target.scope, "subdomains");
    assert.equal(target.hostname, "example.com");
    assert.equal(target.path, "");
    assert.equal(target.display, "example.com");
  });

  it("defaults a URL with a path to subfolder scope", () => {
    const target = parseOk("example.com/commercial-insurance/");
    assert.equal(target.scope, "subfolder");
    assert.equal(target.path, "/commercial-insurance");
    assert.equal(target.display, "example.com/commercial-insurance");
  });

  it("strips query strings and fragments without failing", () => {
    const target = parseOk("https://example.com/blog?utm_source=x#section");
    assert.equal(target.path, "/blog");
  });

  it("preserves path casing and percent encoding", () => {
    const target = parseOk("example.com/Docs/%7Euser");
    assert.equal(target.path, "/Docs/%7Euser");
  });

  it("strips www from hostname but keeps it for page URLs", () => {
    const target = parseOk("www.example.com/blog", "exact_url");
    assert.equal(target.hostname, "example.com");
    assert.equal(target.urlHostname, "www.example.com");
  });

  it("rejects subfolder for a root input instead of silently rescoping", () => {
    const result = parseResearchTarget("example.com", "subfolder");
    assert.deepEqual(result, {
      ok: false,
      message: "Add a path to use Subfolder (e.g. example.com/blog)",
    });
  });

  it("rejects invalid hosts and credentials", () => {
    assert.equal(parseResearchTarget("example.por").ok, false);
    assert.equal(parseResearchTarget("").ok, false);
    assert.equal(parseResearchTarget("my_site.com").ok, false);
    assert.equal(parseResearchTarget("https://user:pw@example.com/x").ok, false);
  });
});

describe("urlMatchesResearchTarget", () => {
  const subfolder = parseOk("example.com/blog", "subfolder");

  it("matches the subfolder itself and its children", () => {
    assert.equal(
      urlMatchesResearchTarget("https://example.com/blog", subfolder),
      true,
    );
    assert.equal(
      urlMatchesResearchTarget("https://example.com/blog/post?x=1", subfolder),
      true,
    );
    assert.equal(
      urlMatchesResearchTarget("https://www.example.com/blog/", subfolder),
      true,
    );
  });

  it("excludes similarly named sibling paths and other hosts", () => {
    assert.equal(
      urlMatchesResearchTarget("https://example.com/blogging", subfolder),
      false,
    );
    assert.equal(
      urlMatchesResearchTarget("https://sub.example.com/blog/post", subfolder),
      false,
    );
  });

  it("matches exact URLs ignoring trailing slash, query, and fragment", () => {
    const exact = parseOk("example.com/pricing", "exact_url");
    assert.equal(
      urlMatchesResearchTarget("https://example.com/pricing/", exact),
      true,
    );
    assert.equal(
      urlMatchesResearchTarget("https://example.com/pricing?ref=x#top", exact),
      true,
    );
    assert.equal(
      urlMatchesResearchTarget("https://example.com/pricing/plans", exact),
      false,
    );
  });

  it("separates domain scope from subdomains scope", () => {
    const domain = parseOk("example.com", "domain");
    const subs = parseOk("example.com", "subdomains");
    assert.equal(urlMatchesResearchTarget("https://blog.example.com/x", domain), false);
    assert.equal(urlMatchesResearchTarget("https://blog.example.com/x", subs), true);
    assert.equal(urlMatchesResearchTarget("https://notexample.com/x", subs), false);
  });
});
