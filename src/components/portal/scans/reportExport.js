import {
  engineLabel,
  groupQuestions,
  questionHasAnswer,
  questionNamesBrand,
} from "./reportData.js";

const HEADERS = [
  "Question",
  "Engine",
  "Status",
  "Names you",
  "Cited",
  "Position",
  "Answer",
];

function answered(row) {
  return row.answered === true && !row.raw?.error;
}

function rowForAnswer(question, row) {
  const hasAnswer = answered(row);
  const failed = Boolean(row.raw?.error);
  return [
    question,
    engineLabel(row.engine),
    failed ? "Collection failed" : hasAnswer ? "Answered" : "No answer",
    hasAnswer && typeof row.mentioned === "boolean"
      ? (row.mentioned ? "Yes" : "No")
      : "",
    hasAnswer && typeof row.brand_cited === "boolean"
      ? (row.brand_cited ? "Yes" : "No")
      : "",
    hasAnswer
      && row.position !== null
      && row.position !== undefined
      && row.position !== ""
      && Number.isFinite(Number(row.position))
      ? Number(row.position)
      : "",
    hasAnswer && typeof row.answer_text === "string" ? row.answer_text : "",
  ];
}

/** Map report answers to export rows using the same question/filter semantics as QuestionsCard. */
export function questionExportRows(results, planned, filters = {}) {
  const { view = "all", search = "", engine = "all" } = filters;
  const needle = String(search || "").trim().toLowerCase();
  const groups = groupQuestions(results, planned);
  const visible = groups.filter((question) => {
    const hasEngine = engine === "all"
      || question.rows.some((row) => row.engine === engine)
      || question.missing.includes(engine);
    if (!hasEngine || (needle && !question.query.toLowerCase().includes(needle))) return false;
    if (view === "naming") return questionNamesBrand(question, engine);
    if (view === "missing") return questionHasAnswer(question, engine) && !questionNamesBrand(question, engine);
    if (view === "unanswered") return !questionHasAnswer(question, engine);
    return true;
  });

  const rows = visible.flatMap((question) => {
    const answers = engine === "all"
      ? question.rows
      : question.rows.filter((row) => row.engine === engine);
    const missing = engine === "all"
      ? question.missing
      : question.missing.includes(engine) ? [engine] : [];
    return [
      ...answers.map((row) => rowForAnswer(question.query, row)),
      ...missing.map((name) => [question.query, engineLabel(name), "Not collected", "", "", "", ""]),
    ];
  });

  return { headers: [...HEADERS], rows };
}
