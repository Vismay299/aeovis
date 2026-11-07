import test from "node:test";
import assert from "node:assert/strict";
import { checkLlmsTxt } from "./llmsTxt.ts";

test("checkLlmsTxt verifies valid markdown, html, missing, and network failures", async () => {
  const mockFetch = async (url: string) => {
    if (url.includes("/valid-md")) {
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/markdown; charset=utf-8" }),
        text: () => "# Offcult\n\nWelcome to Offcult.",
      };
    }
    if (url.includes("/valid-plain")) {
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        text: () => "# Offcult\n\nText summary.",
      };
    }
    if (url.includes("/html")) {
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        text: () => "<html><body># Offcult</body></html>",
      };
    }
    if (url.includes("/no-h1")) {
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        text: () => "Just some text without an H1 markdown title.",
      };
    }
    if (url.includes("/404")) {
      return {
        status: 404,
        headers: new Headers(),
        text: () => "Not Found",
      };
    }
    if (url.includes("/network-err")) {
      throw new Error("ECONNREFUSED");
    }
    return { status: 500, headers: new Headers(), text: () => "" };
  };

  const rMd = await checkLlmsTxt("https://example.com/valid-md", { safeFetch: mockFetch as any });
  assert.equal(rMd.status, "present");
  assert.equal(rMd.firstLine, "# Offcult");

  const rPlain = await checkLlmsTxt("https://example.com/valid-plain", { safeFetch: mockFetch as any });
  assert.equal(rPlain.status, "present");

  const rHtml = await checkLlmsTxt("https://example.com/html", { safeFetch: mockFetch as any });
  assert.equal(rHtml.status, "invalid");

  const rNoH1 = await checkLlmsTxt("https://example.com/no-h1", { safeFetch: mockFetch as any });
  assert.equal(rNoH1.status, "invalid");

  const r404 = await checkLlmsTxt("https://example.com/404", { safeFetch: mockFetch as any });
  assert.equal(r404.status, "missing");

  const rErr = await checkLlmsTxt("https://example.com/network-err", { safeFetch: mockFetch as any });
  assert.equal(rErr.status, "unreachable");
});
