import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compileJsx } from "../../../server/renderHarness.mjs";
import * as reportData from "./reportData.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function QuestionHistoryLinkStub({ questionId, fromScan }) {
  const href = fromScan
    ? `/portal/questions/${encodeURIComponent(questionId)}?from_scan=${encodeURIComponent(fromScan)}`
    : `/portal/questions/${encodeURIComponent(questionId)}`;
  return React.createElement(
    "a",
    {
      href,
      "data-testid": "question-history-link",
      "aria-label": "Question history",
    },
    "History"
  );
}

test("F12-AC-11 report history link appears only for linked questions with from_scan", async () => {
  const nextLink = { __esModule: true, default: "a" };
  const ui = await compileJsx(path.join(here, "../ui.jsx"), {
    modules: new Map([["next/link", nextLink]]),
    autoNull: ["lucide-react"],
  });

  const cards = await compileJsx(path.join(here, "ReportCards.jsx"), {
    modules: new Map([
      ["react", React],
      ["../ui", ui],
      ["./reportData", reportData],
      ["./scans.css", {}],
      [
        "@/components/portal/questions/history/QuestionHistoryLink",
        { QuestionHistoryLink: QuestionHistoryLinkStub },
      ],
    ]),
    autoNull: ["lucide-react"],
    exposeInternals: ["QuestionRow"],
  });

  const { QuestionRow, QuestionsCard } = cards;
  assert.ok(QuestionRow, "QuestionRow should be exported via exposeInternals");
  assert.ok(QuestionsCard, "QuestionsCard should be exported");

  const scanId = "scan-987";
  const questionIdByQuery = {
    "what is acme?": "q-111",
    // "how does acme work?" is unlinked
  };

  const linkedQuestion = {
    query: "What is Acme?",
    rows: [
      {
        id: "r-1",
        engine: "chatgpt",
        answered: true,
        mentioned: true,
        brand_cited: true,
        text: "Acme is great",
      },
    ],
    missing: [],
  };

  const unlinkedQuestion = {
    query: "How does Acme work?",
    rows: [
      {
        id: "r-2",
        engine: "gemini",
        answered: true,
        mentioned: false,
        brand_cited: false,
        text: "It works well",
      },
    ],
    missing: [],
  };

  // Test 1: QuestionRow for linked question renders QuestionHistoryLink when open
  // Note: in QuestionRow, open state defaults to false in SSR unless toggled, but QuestionRow renders button
  // Let's test QuestionsCard rendering both questions
  const results = [
    {
      id: "r-1",
      query: "What is Acme?",
      engine: "chatgpt",
      answered: true,
      mentioned: true,
      brand_cited: true,
    },
    {
      id: "r-2",
      query: "How does Acme work?",
      engine: "gemini",
      answered: true,
      mentioned: false,
      brand_cited: false,
    },
  ];

  const html = renderToStaticMarkup(
    React.createElement(QuestionsCard, {
      results,
      planned: ["What is Acme?", "How does Acme work?"],
      questionIdByQuery,
      scanId,
    })
  );

  // Both question texts should be visible in the card
  assert.match(html, /What is Acme\?/);
  assert.match(html, /How does Acme work\?/);

  // Directly render QuestionRow with open simulating expanded state (by mocking useState or testing QuestionRow markup)
  // Let's verify QuestionRow function directly:
  // When open=true (we can test with a mocked useState where default is true):
  const reactWithOpenTrue = {
    ...React,
    useState: (initial) => [true, () => {}],
  };

  const cardsOpen = await compileJsx(path.join(here, "ReportCards.jsx"), {
    modules: new Map([
      ["react", reactWithOpenTrue],
      ["../ui", ui],
      ["./reportData", reportData],
      ["./scans.css", {}],
      [
        "@/components/portal/questions/history/QuestionHistoryLink",
        { QuestionHistoryLink: QuestionHistoryLinkStub },
      ],
    ]),
    autoNull: ["lucide-react"],
    exposeInternals: ["QuestionRow"],
  });

  const QuestionRowOpen = cardsOpen.QuestionRow;

  const linkedHtml = renderToStaticMarkup(
    React.createElement(QuestionRowOpen, {
      question: linkedQuestion,
      engine: "all",
      questionIdByQuery,
      scanId,
    })
  );

  assert.match(
    linkedHtml,
    /href="\/portal\/questions\/q-111\?from_scan=scan-987"/,
    "Linked question row must render history link with from_scan"
  );
  assert.match(linkedHtml, /aria-label="Question history"/);
  assert.match(linkedHtml, /History/);

  // Test 2: Unlinked question row must not render history link even when open
  const unlinkedHtml = renderToStaticMarkup(
    React.createElement(QuestionRowOpen, {
      question: unlinkedQuestion,
      engine: "all",
      questionIdByQuery,
      scanId,
    })
  );

  assert.doesNotMatch(
    unlinkedHtml,
    /data-testid="question-history-link"/,
    "Unlinked question row must not render history link"
  );
  assert.doesNotMatch(unlinkedHtml, /aria-label="Question history"/);

  // Test 3: If questionIdByQuery is missing/undefined, no error occurs and no link rendered
  const noQueryMapHtml = renderToStaticMarkup(
    React.createElement(QuestionRowOpen, {
      question: linkedQuestion,
      engine: "all",
      scanId,
    })
  );
  assert.doesNotMatch(noQueryMapHtml, /data-testid="question-history-link"/);
});
