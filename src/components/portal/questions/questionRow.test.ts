import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

const here = path.dirname(fileURLToPath(import.meta.url));

function loadTsx(relPath: string, req: (id: string) => any) {
  const filePath = path.join(here, relPath);
  const source = readFileSync(filePath, "utf8");
  const { code } = transform(source, {
    transforms: ["jsx", "imports", "typescript"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath,
  });
  const moduleObj = { exports: {} as any };
  const fn = new Function("require", "module", "exports", "React", code);
  fn(req, moduleObj, moduleObj.exports, React);
  return moduleObj.exports;
}

const nextLink: any = ({ href, children, ...rest }: any) =>
  React.createElement("a", { href, ...rest }, children);
nextLink.default = nextLink;

const button = ({ children, render, ...rest }: any) => {
  const props = { ...rest };
  delete props.variant;
  delete props.size;
  delete props.nativeButton;
  if (render && React.isValidElement(render)) {
    return React.cloneElement(render as any, props, children);
  }
  return React.createElement("button", { type: "button", ...props }, children);
};

const badge = ({ children, ...rest }: any) =>
  React.createElement("span", { "data-badge": "true", ...rest }, children);

const historyIcon = (props: any) => React.createElement("svg", { "data-icon": "history", ...props });

function renderActions(available: boolean) {
  const historyAvailability = { QUESTION_HISTORY_AVAILABLE: available };
  const req = (id: string) => {
    if (id === "react") return React;
    if (id === "next/link") return nextLink;
    if (id === "lucide-react") return { History: historyIcon };
    if (id === "@/components/ui/button") return { Button: button };
    if (id === "@/components/ui/badge") return { Badge: badge };
    if (id === "./history/historyAvailability") return historyAvailability;
    if (id === "./history/QuestionHistoryLink") {
      return loadTsx("history/QuestionHistoryLink.tsx", (inner: string) => {
        if (inner === "react") return React;
        if (inner === "next/link") return nextLink;
        if (inner === "lucide-react") return { History: historyIcon };
        if (inner === "@/components/ui/button") return { Button: button };
        if (inner === "./historyAvailability") return historyAvailability;
        throw new Error(`Unexpected import in QuestionHistoryLink: ${inner}`);
      });
    }
    throw new Error(`Unexpected import in QuestionRow: ${id}`);
  };
  const mod = loadTsx("QuestionRow.tsx", req);
  const QuestionRowActions = mod.QuestionRowActions;
  const question = {
    id: "q-123",
    text: "What is Aeovis?",
    topic: "General",
    origin: "manual",
    status: "active" as const,
    branded: false,
    createdAt: "2026-10-21T09:40:00.000Z",
  };
  return renderToStaticMarkup(
    React.createElement(QuestionRowActions, { question, tab: "active" })
  );
}

test("question row renders QuestionHistoryLink when QUESTION_HISTORY_AVAILABLE is true", () => {
  const html = renderActions(true);
  assert.match(html, /aria-label="Question history"/);
  assert.match(html, />History</);
  assert.match(html, /href="\/portal\/questions\/q-123"/);
});

test("question row renders nothing for history link when QUESTION_HISTORY_AVAILABLE is false", () => {
  const html = renderActions(false);
  assert.doesNotMatch(html, /aria-label="Question history"/);
  assert.doesNotMatch(html, />History</);
  assert.doesNotMatch(html, /\/portal\/questions\/q-123/);
});
