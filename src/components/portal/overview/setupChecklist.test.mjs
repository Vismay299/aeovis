import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import {
  compileJsx,
  renderToHtml,
  textOf,
} from "../../../server/renderHarness.mjs";
import { createFakeReactQuery } from "../../../server/fakeReactQuery.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const SETUP_IDS = [
  "questions",
  "scan",
  "gsc",
  "audit",
  "schedule",
  "ga4",
  "draft",
  "team",
];

function activationWith(status, ids = SETUP_IDS) {
  return {
    brandKey: "acme",
    steps: ids.map((id) => ({ id, status })),
  };
}

function buttonStub({ children, render, pending, disabled, ...props }) {
  if (render) return React.cloneElement(render, {}, children);
  return React.createElement(
    "button",
    { ...props, disabled: disabled || pending },
    children,
  );
}

const accordionStub = {
  Accordion: ({ children }) => React.createElement(React.Fragment, null, children),
  AccordionItem: ({ children }) =>
    React.createElement(React.Fragment, null, children),
  AccordionTrigger: ({ children, ...props }) =>
    React.createElement("button", { type: "button", ...props }, children),
  AccordionContent: ({ children }) =>
    React.createElement(React.Fragment, null, children),
};

const collapsibleStub = {
  Collapsible: ({ children }) =>
    React.createElement(React.Fragment, null, children),
  CollapsibleTrigger: ({ children, ...props }) =>
    React.createElement("button", { type: "button", ...props }, children),
  CollapsibleContent: ({ children }) =>
    React.createElement(React.Fragment, null, children),
};

/**
 * Compile the real hook and component against the render harness. The fake
 * query client never fetches because the activation prop disables the query
 * and the tests pass fixture rows, so nothing here touches the network.
 */
async function loadChecklist({ track = [] } = {}) {
  const telemetry = {
    trackEvent: (name, props) => track.push({ name, props }),
  };
  const reactQuery = createFakeReactQuery(React);
  const setupSteps = await import("../../../shared/setup-steps.ts");
  const fetchJson = await import("../../../shared/query/fetchJson.ts");
  const keys = await import("../../../shared/query/keys.ts");

  const hook = await compileJsx(
    path.join(here, "hooks/useSetupActivation.ts"),
    {
      typescript: true,
      modules: new Map([
        ["react", React],
        ["@tanstack/react-query", reactQuery],
        ["@/shared/query/fetchJson", fetchJson],
        ["@/shared/query/keys", keys],
      ]),
    },
  );

  const portal = {
    brandKey: "acme",
    isOwner: true,
    scan: { start: () => {}, starting: false, active: false },
  };

  const mod = await compileJsx(path.join(here, "SetupChecklist.tsx"), {
    typescript: true,
    modules: new Map([
      ["react", React],
      ["next/link", { __esModule: true, default: "a" }],
      ["@/components/ui/accordion", accordionStub],
      ["@/components/ui/button", { Button: buttonStub }],
      // The drawn tick on done rows is decoration, like the lucide icons.
      ["@/components/ui/spinner", { SuccessCheck: () => null }],
      ["@/components/ui/collapsible", collapsibleStub],
      ["@/components/portal/PortalShell", { usePortal: () => portal }],
      ["@/shared/telemetry/client", telemetry],
      ["@/shared/setup-steps", setupSteps],
      ["./hooks/useSetupActivation", hook],
    ]),
    autoNull: ["lucide-react"],
  });

  return { SetupChecklist: mod.SetupChecklist, track };
}

test("a checklist with every row dismissed keeps them under 'saved for later'", async () => {
  const { SetupChecklist } = await loadChecklist();
  const html = renderToHtml(SetupChecklist, {
    activation: activationWith("skipped"),
  });
  assert.match(html, /8 saved for later/);
  assert.doesNotMatch(html, /Review questions/);
  assert.doesNotMatch(html, /Skip for now/);
});

test("a checklist with every row done renders nothing", async () => {
  const { SetupChecklist } = await loadChecklist();
  const html = renderToHtml(SetupChecklist, {
    activation: activationWith("done"),
  });
  assert.equal(html, "");
});

test("members see owner-row guidance and no owner actions, while their own action stays", async () => {
  const { SetupChecklist } = await loadChecklist();
  const activation = {
    brandKey: "acme",
    steps: [
      { id: "questions", status: "todo" },
      { id: "gsc", status: "todo" },
      { id: "schedule", status: "todo" },
      { id: "ga4", status: "todo" },
      { id: "team", status: "todo" },
      { id: "scan", status: "done" },
    ],
  };

  const memberHtml = renderToHtml(SetupChecklist, { activation, role: "member" });
  const memberText = textOf(memberHtml);
  assert.match(memberText, /Ask a workspace owner to set this up\./);
  assert.match(memberText, /Review questions/);
  assert.match(memberHtml, /href="\/portal\/measurement"/);
  assert.doesNotMatch(memberHtml, /href="\/portal\/search-console"/);
  assert.doesNotMatch(memberHtml, /href="\/portal\/settings\/schedule"/);
  assert.doesNotMatch(memberHtml, /href="\/portal\/settings\/integrations"/);
  assert.doesNotMatch(memberText, /Invite a teammate/);

  const ownerHtml = renderToHtml(SetupChecklist, { activation, role: "owner" });
  const ownerText = textOf(ownerHtml);
  assert.match(ownerHtml, /href="\/portal\/search-console"/);
  assert.match(ownerHtml, /href="\/portal\/settings\/schedule"/);
  assert.match(ownerHtml, /href="\/portal\/settings\/integrations"/);
  assert.match(ownerText, /Invite a teammate/);
  assert.doesNotMatch(ownerText, /Ask a workspace owner to set this up\./);
});
