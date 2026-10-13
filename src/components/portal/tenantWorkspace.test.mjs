import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import React from "react";
import { compileJsx, renderToHtml } from "../../lib/renderHarness.mjs";
import * as reportData from "./scans/reportData.js";
import * as contentShared from "./content/shared.js";
import { FORMATS } from "../../lib/content/agents/formats.js";

const here = import.meta.dirname;
const context = { brandKey: "workspace-trace", brand: { display_name: "trace" }, refreshOverview() {}, redirectToLogin() {}, scan: { start() {} } };
const navigation = { useRouter: () => ({ replace() {}, push() {} }), usePathname: () => "/portal/content", useSearchParams: () => new URLSearchParams() };
async function primitives() {
  return compileJsx(path.join(here, "ui.jsx"), {
    modules: new Map([["react", React],["next/link", { default: ({ children, ...props }) => React.createElement("a", props, children) }]]), autoNull: ["lucide-react"],
  });
}

test("the actual tenant Studio opens with its workflow canvas and customer agent panel", async () => {
  const ui = await primitives();
  const canvas = await compileJsx(path.join(here, "../studio/AgentCanvas.jsx"), { modules: new Map([["react", React]]), autoNull: ["lucide-react"] });
  const studio = await compileJsx(path.join(here, "content/ContentStudio.jsx"), {
    modules: new Map([["react", React],
      ["next/navigation", navigation], ["../PortalShell", { usePortal: () => context }], ["../ui", ui],
      ["../status", { CONTENT_JOB_ACTIVE: [] }], ["./shared", { contentRequest() {} }],
      ["@/components/studio/AgentCanvas", canvas],
      ["@/components/studio/AgentsPanel", { AgentsPanel: (props) => React.createElement("div", { "data-api": props.apiBase, "data-customer": props.customer }, "Workspace agents") }],
    ]),
    autoNull: ["lucide-react", "./ComposerCard", "./GenerationQueue", "./DraftsLibrary", "./DraftEditor", "./content.css"],
  });
  const html = renderToHtml(studio.default);
  assert.match(html, /Content workflow/);
  assert.match(html, /Researcher/);
  assert.match(html, /No active run/);
  assert.match(html, /data-api="\/api\/customer\/agents"/);
  assert.match(html, /data-customer="true"/);
  assert.match(html, /aria-selected="true">Workspace &amp; canvas/);
});

test("tenant Scans renders a runnable mock inside the tenant page rather than linking out", async () => {
  const ui = await primitives();
  const mock = await compileJsx(path.join(here, "scans/MockScanPanel.jsx"), {
    modules: new Map([["react", React],["../ui", ui], ["./reportData", reportData]]), autoNull: ["lucide-react", "./mock-scan.css"],
  });
  const page = await compileJsx(path.join(here, "../../app/portal/scans/page.jsx"), {
    modules: new Map([["react", React],["next/navigation", navigation], ["@/components/portal/PortalShell", { usePortal: () => context }],
      ["@/components/portal/ui", ui], ["@/components/portal/scans/MockScanPanel", mock], ["@/components/portal/scans/reportData", reportData]]),
    autoNull: ["lucide-react", "@/components/portal/ScanProgressCard", "@/components/portal/scans/scans.css"],
  });
  const html = renderToHtml(page.default);
  assert.match(html, /Run mock scan/);
  assert.match(html, /Test the scan and report workflow for trace/);
  assert.match(html, /Simulation only/);
  assert.doesNotMatch(html, /href="\/demo"/);
});

test("a selected FAQ agent shows its output format rather than the base article pipeline", async () => {
  const composer = await compileJsx(path.join(here,"content/ComposerCard.jsx"),{
    modules:new Map([["react",React],["../ui",await primitives()],["./shared",contentShared],["@/lib/content/agents/formats",{FORMATS}]]),
    autoNull:["lucide-react"],
  });
  const html=renderToHtml(composer.default,{brandKey:"workspace-trace",selectedAgent:{id:"own-agent",name:"FAQ Writer",format:"faq",base:"geo_article"}});
  assert.match(html,/<option[^>]*>FAQ page<\/option>/);
  assert.doesNotMatch(html,/<option[^>]*>Article \(GEO\)<\/option>/);
});
