"use client";

import { useId, useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { Badge, Card, EmptyState, ProgressBar, Tabs, formatPct } from "../ui";
import {
  engineLabel,
  engineOptions,
  finiteNumber,
  groupQuestions,
  questionNamesBrand,
  readCompetitors,
  readEngineScores,
} from "./reportData";
import "./scans.css";

/** One row per engine with its score. Renders nothing when engine_scores is unusable. */
export function EngineScoresCard({ engineScores }) {
  const rows = readEngineScores(engineScores);
  if (!rows.length) return null;
  return (
    <Card title="By engine" description="How often each engine's answers named your brand.">
      <div className="pv-scans-rows">
        {rows.map((row) => (
          <div key={row.name} className="pv-scans-rows__item">
            <div className="pv-scans-rows__head">
              <span className="pv-scans-rows__name">{engineLabel(row.name)}</span>
              <span className="pv-scans-rows__value">{formatPct(row.pct)}</span>
            </div>
            <ProgressBar value={row.pct} size="sm" label={`${engineLabel(row.name)} score`} />
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Ranked "who the engines named instead of you". Renders nothing when there is no roster. */
export function CompetitorsCard({ competitors, engines, brand }) {
  const { rows, hasCounts } = useMemo(
    () => readCompetitors({ competitors, engines, brand }),
    [competitors, engines, brand],
  );
  if (!rows.length) return null;

  const max = hasCounts ? Math.max(1, ...rows.map((row) => row.count ?? 0)) : 1;
  return (
    <Card
      title="Competitors"
      description="Brands the engines named instead of you."
      footer={!hasCounts ? <span className="pv-scans-card-foot">Mention counts were not recorded for this scan.</span> : null}
    >
      <div className="pv-scans-rows">
        {rows.map((row) => {
          const count = finiteNumber(row.count);
          const width = count === null ? 0 : Math.round((count / max) * 100);
          return (
            <div key={row.name} className="pv-scans-rows__item">
              <div className="pv-scans-rows__head">
                <span className={`pv-scans-rows__name${row.isBrand ? " pv-scans-rows__you" : ""}`}>
                  {row.name}
                  {row.isBrand ? " (you)" : ""}
                </span>
                <span className={`pv-scans-rows__value${count === null ? " is-empty" : ""}`}>
                  {count === null ? "—" : `${count} ${count === 1 ? "mention" : "mentions"}`}
                </span>
              </div>
              {hasCounts ? (
                <div
                  className={`pv-scans-meter${row.isBrand ? " is-you" : " is-rival"}`}
                  role="img"
                  aria-label={count === null ? `${row.name}: no count recorded` : `${row.name}: ${count} mentions`}
                >
                  <span className="pv-scans-meter__fill" style={{ transform: `scaleX(${width / 100})` }} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function AnswerBlock({ row }) {
  const text = typeof row.answer_text === "string" && row.answer_text.trim() ? row.answer_text : "";
  const position = finiteNumber(row.position);
  return (
    <div className="pv-scans-answer">
      <div className="pv-scans-answer__head">
        <span className="pv-scans-answer__engine">{engineLabel(row.engine)}</span>
        {position !== null ? <Badge>#{position}</Badge> : null}
        {row.brand_cited ? <Badge tone="brand">Cited</Badge> : null}
      </div>
      <p className={`pv-scans-answer__text${text ? "" : " is-empty"}`}>
        {text || (row.answered === false ? "The engine did not return an answer." : "No answer text was recorded.")}
      </p>
    </div>
  );
}

/** One badge per engine, plus Cited and #position for the rows that carry them. */
function EngineBadges({ rows }) {
  return rows.flatMap((row, index) => {
    const label = engineLabel(row.engine);
    const key = `${row.engine || "engine"}-${index}`;
    const position = finiteNumber(row.position);
    const badges = [
      row.answered === false
        ? <Badge key={`${key}-status`}>{label}: No answer</Badge>
        : (
          <Badge key={`${key}-status`} tone={row.mentioned === true ? "good" : "neutral"}>
            {label}: {row.mentioned === true ? "Mentioned" : "Not mentioned"}
          </Badge>
        ),
    ];
    if (row.brand_cited === true) badges.push(<Badge key={`${key}-cited`} tone="brand">Cited</Badge>);
    if (position !== null) badges.push(<Badge key={`${key}-pos`}>#{position}</Badge>);
    return badges;
  });
}

function QuestionRow({ question, engine }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const rows = engine === "all" ? question.rows : question.rows.filter((row) => row.engine === engine);

  return (
    <li className="pv-scans-q">
      <button
        type="button"
        className="pv-scans-q__toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="pv-scans-q__text">{question.query}</span>
        <span className="pv-scans-q__badges">
          <EngineBadges rows={rows} />
        </span>
        <span className="pv-scans-q__chev" aria-hidden="true"><ChevronRight /></span>
      </button>
      {open ? (
        <div id={id} className="pv-scans-q__answers">
          {rows.map((row, index) => (
            <AnswerBlock key={`${row.id || row.engine || "row"}-${index}`} row={row} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

/** Questions grouped by text, with tabs, search and an engine filter. */
export function QuestionsCard({ results }) {
  const [view, setView] = useState("all");
  const [search, setSearch] = useState("");
  const [engine, setEngine] = useState("all");
  const searchId = useId();
  const engineId = useId();

  const questions = useMemo(() => groupQuestions(results), [results]);
  const engines = useMemo(() => engineOptions(results), [results]);

  const scoped = useMemo(
    () => (engine === "all" ? questions : questions.filter((q) => q.rows.some((row) => row.engine === engine))),
    [questions, engine],
  );
  const naming = scoped.filter((q) => questionNamesBrand(q, engine));
  const notNaming = scoped.filter((q) => !questionNamesBrand(q, engine));

  const needle = search.trim().toLowerCase();
  const visible = (view === "naming" ? naming : view === "missing" ? notNaming : scoped)
    .filter((q) => !needle || q.query.toLowerCase().includes(needle));

  const tabs = [
    { value: "all", label: "All", count: scoped.length },
    { value: "naming", label: "Naming you", count: naming.length },
    { value: "missing", label: "Not naming you", count: notNaming.length },
  ];

  const clear = () => { setSearch(""); setView("all"); setEngine("all"); };

  return (
    <Card title="Questions" description="Each buyer question, and what every engine answered." flush>
      {questions.length === 0 ? (
        <EmptyState title="No questions were recorded">
          This scan did not store any answers to show.
        </EmptyState>
      ) : (
        <>
          <div className="pv-scans-toolbar">
            <Tabs items={tabs} value={view} onChange={setView} label="Filter questions" />
            <div className="pv-scans-toolbar__filters">
              <label className="pv-scans-search" htmlFor={searchId}>
                <span className="pv-scans-sr">Search questions</span>
                <Search aria-hidden="true" />
                <input
                  id={searchId}
                  className="pv-input"
                  type="search"
                  placeholder="Search questions"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              {engines.length ? (
                <label htmlFor={engineId} className="pv-scans-sr">Engine</label>
              ) : null}
              {engines.length ? (
                <select
                  id={engineId}
                  className="pv-select"
                  value={engine}
                  onChange={(event) => setEngine(event.target.value)}
                >
                  <option value="all">All engines</option>
                  {engines.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              ) : null}
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="pv-scans-noresult">
              No questions match these filters.
              <button type="button" className="pv-btn pv-btn--ghost pv-btn--sm" onClick={clear}>
                Clear filters
              </button>
            </div>
          ) : (
            <ul className="pv-scans-qlist">
              {visible.map((question) => (
                <QuestionRow key={question.query} question={question} engine={engine} />
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
