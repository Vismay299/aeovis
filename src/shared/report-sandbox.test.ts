// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/report-sandbox.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  PRINT_SCRIPT,
  PRINT_SCRIPT_SHA256,
  REPORT_CSP,
  REPORT_IFRAME_SANDBOX,
  reportCsp,
  reportDocumentResponse,
  textResponse,
  withPrintScript,
} from "./report-sandbox.ts";

// F23-AC-08: the print script is appended once, last and attribute-free, and the
// CSP authorises exactly its hash. The digest is hardcoded because the CSP needs
// it synchronously, so this recomputes it from the script text: editing the
// script without editing the constant would silently break "Export".

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

test("the hardcoded digest is the SHA-256 of the print script", () => {
  const digest = createHash("sha256").update(PRINT_SCRIPT, "utf8").digest();
  assert.equal(base64(digest), PRINT_SCRIPT_SHA256);
});

test("the print CSP authorises exactly that hash and nothing else", () => {
  const csp = reportCsp(true);
  assert.match(csp, /^sandbox allow-popups allow-popups-to-escape-sandbox allow-scripts allow-modals;/);
  assert.ok(csp.includes(`script-src 'sha256-${PRINT_SCRIPT_SHA256}'`));
  assert.equal((csp.match(/script-src/g) ?? []).length, 1);
  // The report's own inline scripts stay blocked: the only script source is the
  // one hash. (`style-src 'unsafe-inline'` is unrelated and remains.)
  assert.equal(/script-src[^;]*'unsafe-inline'/.test(csp), false);
});

test("the normal CSP is REPORT_CSP byte for byte", () => {
  assert.equal(reportCsp(false), REPORT_CSP);
  assert.equal(reportCsp(), REPORT_CSP);
  assert.equal(REPORT_CSP.includes("allow-scripts"), false);
});

test("the iframe sandbox never grants same-origin", () => {
  assert.equal(REPORT_IFRAME_SANDBOX, "allow-popups allow-popups-to-escape-sandbox");
  assert.equal(REPORT_IFRAME_SANDBOX.includes("allow-same-origin"), false);
  assert.equal(REPORT_CSP.includes("allow-same-origin"), false);
});

test("print mode splices the script immediately before </body>", () => {
  const html = "<!doctype html>\n<html><body><p>report</p></body></html>";
  const out = withPrintScript(html);
  assert.equal(out, `<!doctype html>\n<html><body><p>report</p><script>${PRINT_SCRIPT}</script></body></html>`);
  assert.equal((out.match(/<script>/g) ?? []).length, 1, "exactly one script tag is added");
  assert.ok(out.indexOf("<script>") > out.indexOf("<p>report</p>"), "the script is last");
});

test("a document without </body> splices before </html>", () => {
  const html = "<!doctype html>\n<html><p>report</p></html>";
  const out = withPrintScript(html);
  assert.equal(out, `<!doctype html>\n<html><p>report</p><script>${PRINT_SCRIPT}</script></html>`);
  assert.ok(out.endsWith(`<script>${PRINT_SCRIPT}</script></html>`));
});

test("a document with neither closing tag gets the script appended", () => {
  const out = withPrintScript("<p>half a report");
  assert.equal(out, `<p>half a report<script>${PRINT_SCRIPT}</script>`);
});

test("a dangling opening tag cannot absorb the print script's attributes", () => {
  // A report that stopped mid-attribute: the splice lands inside the unclosed
  // tag, so an attributed script tag would merge into it. The print tag has no
  // attributes at all, so the worst case is one valueless attribute name.
  const html = '<!doctype html><html><body><script src="x" </body></html>';
  const out = withPrintScript(html);
  assert.ok(out.includes(`<script>${PRINT_SCRIPT}</script>`), "the print tag carries no attributes");
  assert.equal(out.includes(`<script type=`), false);
  assert.equal(out.includes(`<script nonce=`), false);
});

test("the document response carries the sandbox header set", () => {
  const response = reportDocumentResponse("<html><body>x</body></html>", {
    cacheControl: "private, no-store",
    noindex: true,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("Content-Security-Policy"), REPORT_CSP);
  assert.equal(response.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("the public document response omits the robots tag only when asked", () => {
  const response = reportDocumentResponse("<html><body>x</body></html>", {
    cacheControl: "public, max-age=0, s-maxage=60",
  });
  assert.equal(response.headers.get("X-Robots-Tag"), null);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=0, s-maxage=60");
});

test("textResponse is plain text and never cached", async () => {
  const response = textResponse("This report isn't shared.", 404);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Content-Type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(await response.text(), "This report isn't shared.");
});
