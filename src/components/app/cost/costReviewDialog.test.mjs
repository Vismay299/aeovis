// The shared price dialog's scan-only rules (zero-answer guard, answers ×
// engines breakdown, scan copy) apply only to quotes that count answers.
// Before this, every non-scan action (keywords, SERP, domain, backlinks,
// local, site audit) opened a dialog whose Confirm was always disabled.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { compileJsx, renderToHtml, anyNamedExport, textOf } from "../../../server/renderHarness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const children = ({ children }) => React.createElement(React.Fragment, null, children);

async function loadDialog() {
  return compileJsx(path.join(here, "CostReviewDialog.tsx"), {
    typescript: true,
    modules: new Map([
      ["react", React],
      ["lucide-react", anyNamedExport],
      ["@/components/ui/dialog", { Dialog: children, DialogContent: children, DialogFooter: children, DialogHeader: children, DialogTitle: children }],
      ["@/components/ui/button", { Button: ({ children: c, disabled }) => React.createElement("button", { type: "button", disabled: Boolean(disabled) }, c) }],
      ["@/components/ui/alert", { Alert: children, AlertDescription: children, AlertTitle: children }],
      ["@/components/ui/skeleton", anyNamedExport],
      ["@/shared/pricing", await import("../../../shared/pricing.ts")],
      ["@/shared/telemetry/client", { trackEvent() {} }],
      // The slider is opt-in (`slideToConfirm`), and every proof here leaves it
      // off, so this stub is never rendered; the button path is what is proven.
      ["@/components/kokonutui/slide-to-confirm", { default: () => null }],
    ]),
  });
}

function quote(action, units, totalUsd = 0.6) {
  return { action, currency: "USD", totalUsd, expectedUsd: null, units, lines: [{ label: "line", quantity: 1, unitUsd: totalUsd, totalUsd }], monthly: null, warnings: [], blocked: null };
}
const scanQuote = (answers) => quote("ai_visibility.scan", [
  { key: "questions", label: "questions", count: answers ? 10 : 0 },
  { key: "engines", label: "engines", count: 3 },
  { key: "answers", label: "answers", count: answers },
]);
const domainQuote = quote("domain.lookup.run", [
  { key: "overview", label: "overview", count: 1 },
  { key: "keywords", label: "keywords", count: 100 },
]);

function render(Dialog, props) {
  const html = renderToHtml(Dialog, {
    open: true, title: "Review", confirmLabel: "Run", pendingLabel: "Running…", pending: false,
    priceChanged: null, error: null, onConfirm() {}, onClose() {}, ...props,
  });
  const buttons = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)];
  const confirm = buttons.find(([, , inner]) => textOf(inner).trim() === "Run");
  assert.ok(confirm, "the Confirm button rendered");
  return { text: textOf(html), confirmDisabled: /disabled=""/.test(confirm[1]) };
}

test("a scan quote with zero answers still blocks Confirm", async () => {
  const { CostReviewDialog } = await loadDialog();
  const view = render(CostReviewDialog, { quote: { data: scanQuote(0) } });
  assert.equal(view.confirmDisabled, true);
  assert.match(view.text, /This scan has no answers to collect\./);
});

test("a scan quote with answers can be confirmed and shows the answers breakdown", async () => {
  const { CostReviewDialog } = await loadDialog();
  const view = render(CostReviewDialog, { quote: { data: scanQuote(30) } });
  assert.equal(view.confirmDisabled, false);
  assert.match(view.text, /30 answers \(10 questions × 3 engines\)/);
  assert.match(view.text, /provider cost of answers collected/);
});

test("a non-scan quote (no answers unit) can be confirmed and shows its own units", async () => {
  const { CostReviewDialog } = await loadDialog();
  const view = render(CostReviewDialog, { quote: { data: domainQuote } });
  assert.equal(view.confirmDisabled, false);
  assert.doesNotMatch(view.text, /no answers to collect|answers \(/);
  assert.match(view.text, /1 overview · 100 keywords/);
  assert.match(view.text, /You are charged only what the provider bills, up to this amount\./);
});

test("a changed non-scan price can be accepted, with action-neutral copy", async () => {
  const { CostReviewDialog } = await loadDialog();
  const view = render(CostReviewDialog, { quote: { data: domainQuote }, priceChanged: { approvedMaxUsd: 0.3, quote: domainQuote } });
  assert.equal(view.confirmDisabled, false);
  assert.match(view.text, /The price changed/);
  assert.match(view.text, /This now costs up to \$0\.60\. You approved \$0\.30\./);
  assert.doesNotMatch(view.text, /This scan now costs/);
});

test("a changed scan price keeps the scan copy", async () => {
  const { CostReviewDialog } = await loadDialog();
  const view = render(CostReviewDialog, { quote: { data: scanQuote(30) }, priceChanged: { approvedMaxUsd: 0.3, quote: scanQuote(30) } });
  assert.match(view.text, /This scan now costs up to/);
  assert.equal(view.confirmDisabled, false);
});
