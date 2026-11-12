import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";
import * as scheduleShared from "../../../shared/schedule.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.join(here, "NextRunBadge.tsx");
const source = readFileSync(filePath, "utf8");

const { code } = transform(source, {
  transforms: ["jsx", "imports", "typescript"],
  jsxPragma: "React.createElement",
  jsxFragmentPragma: "React.Fragment",
  filePath,
});

const nextLink: any = ({ href, children, ...rest }: any) =>
  React.createElement("a", { href, ...rest }, children);
nextLink.default = nextLink;

const badge = ({ children, variant, className, ...rest }: any) =>
  React.createElement("span", { "data-slot": "badge", "data-variant": variant, className, ...rest }, children);

const tooltip = ({ children }: any) =>
  React.createElement("div", { "data-slot": "tooltip" }, children);

const tooltipTrigger = ({ children, render }: any) =>
  render ? React.cloneElement(render, {}, children) : React.createElement("span", {}, children);

const tooltipContent = ({ children }: any) =>
  React.createElement("div", { "data-slot": "tooltip-content" }, children);

const pricingShared = {
  formatUsd: (n: number) => `$${Number(n).toFixed(2)}`,
};

function loadNextRunBadge() {
  const customRequire = (id: string) => {
    if (id === "react") return React;
    if (id === "next/link") return nextLink;
    if (id === "lucide-react") return { CalendarClock: () => null };
    if (id === "@/components/ui/badge") return { Badge: badge };
    if (id === "@/components/ui/tooltip")
      return {
        Tooltip: tooltip,
        TooltipTrigger: tooltipTrigger,
        TooltipContent: tooltipContent,
      };
    if (id === "@/components/portal/PortalShell")
      return {
        usePortal: () => ({
          brandKey: "test-brand",
          isOwner: true,
          features: { customer_scheduling: true },
        }),
      };
    if (id === "@/shared/pricing") return pricingShared;
    if (id === "@/shared/schedule") return scheduleShared;
    if (id === "./hooks/useSchedule")
      return { useSchedule: () => ({ isLoading: false, data: null }) };
    throw new Error(`Unexpected import in test: ${id}`);
  };

  const moduleObj = { exports: {} as any };
  const fn = new Function("require", "module", "exports", "React", code);
  fn(customRequire, moduleObj, moduleObj.exports, React);
  return moduleObj.exports.NextRunBadge;
}

const NextRunBadge = loadNextRunBadge();

function renderBadge(props: any) {
  return renderToStaticMarkup(React.createElement(NextRunBadge, props));
}

test("NextRunBadge: returns nothing when customer_scheduling flag is off", () => {
  const html = renderBadge({
    enabled: false,
    schedule: { status: "on", nextRunAt: "2026-10-27T03:30:00.000Z" },
  });
  assert.equal(html, "");
});

test("NextRunBadge: returns nothing while loading", () => {
  const html = renderBadge({
    enabled: true,
    isLoading: true,
    schedule: null,
  });
  assert.equal(html, "");
});

test("NextRunBadge: status on without skip shows Next scan and tooltip with price", () => {
  const html = renderBadge({
    enabled: true,
    isOwner: true,
    schedule: {
      status: "on",
      interval: "weekly",
      approvedMaxUsd: 24,
      nextRunAt: "2026-10-27T03:30:00.000Z",
      lastRunAt: "2026-10-20T03:30:00.000Z",
      lastSkip: null,
    },
  });
  assert.match(html, /Next scan/);
  assert.match(html, /Weekly/);
  assert.match(html, /\$24\.00/);
  assert.match(html, /data-variant="secondary"/);
});

test("NextRunBadge: status on with recent skip shows warning badge linking to schedule settings", () => {
  const html = renderBadge({
    enabled: true,
    isOwner: true,
    schedule: {
      status: "on",
      interval: "weekly",
      approvedMaxUsd: 24,
      nextRunAt: "2026-10-27T03:30:00.000Z",
      lastRunAt: "2026-10-13T03:30:00.000Z",
      lastSkip: {
        reason: "price_changed",
        at: "2026-10-20T03:30:00.000Z",
        message: "The scan now costs more than you approved.",
      },
    },
  });
  assert.match(html, /Next scan/);
  assert.match(html, /last one skipped/);
  assert.match(html, /href="\/portal\/settings\/schedule"/);
  assert.match(html, /data-variant="warning"/);
});

test("NextRunBadge: status operator shows Next scan text badge", () => {
  const html = renderBadge({
    enabled: true,
    isOwner: true,
    schedule: {
      status: "operator",
      nextRunAt: "2026-10-27T03:30:00.000Z",
    },
  });
  assert.match(html, /Next scan/);
  assert.doesNotMatch(html, /last one skipped/);
});

test("NextRunBadge: status off or paused shows link for owners", () => {
  const htmlOff = renderBadge({
    enabled: true,
    isOwner: true,
    schedule: { status: "off" },
  });
  assert.match(htmlOff, /Scheduled scans off/);
  assert.match(htmlOff, /href="\/portal\/settings\/schedule"/);

  const htmlPaused = renderBadge({
    enabled: true,
    isOwner: true,
    schedule: { status: "paused" },
  });
  assert.match(htmlPaused, /Scheduled scans off/);
  assert.match(htmlPaused, /href="\/portal\/settings\/schedule"/);
});

test("NextRunBadge: status off or paused shows plain text for members", () => {
  const htmlOff = renderBadge({
    enabled: true,
    isOwner: false,
    schedule: { status: "off" },
  });
  assert.match(htmlOff, /Scheduled scans off/);
  assert.doesNotMatch(htmlOff, /href="\/portal\/settings\/schedule"/);

  const htmlPaused = renderBadge({
    enabled: true,
    isOwner: false,
    schedule: { status: "paused" },
  });
  assert.match(htmlPaused, /Scheduled scans off/);
  assert.doesNotMatch(htmlPaused, /href="\/portal\/settings\/schedule"/);
});
