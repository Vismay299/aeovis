/** Assistant: a configured assistant with two past conversations about Brightwave. */
import { BRAND, RIVALS, daysAgo } from "./brand.js";
import { reports } from "./core.js";

const S1 = "f1000000-0000-4000-8000-000000000001";
const S2 = "f1000000-0000-4000-8000-000000000002";

export const config = () => ({
  approvalTtlSeconds: 900, configured: true, turnMaxUsd: 0.5,
  skills: [
    { name: "ai-visibility-audit", title: "AI Visibility Audit", description: "Reviews the latest scan and explains where AI answers name rivals instead of you.", version: "1.0.0" },
    { name: "content-brief", title: "Content brief", description: "Turns a lost question into a brief your writers can use.", version: "1.0.0" },
  ],
  suggestions: ["Where do AI answers name NorthPeak but not us?", "Which questions should we add to our panel?", "Can AI crawlers read brightwave.io?", "What should we write next to get cited?"],
});

export const sessions = () => ({
  sessions: [
    { id: S1, title: "Where does NorthPeak beat us?", createdAt: daysAgo(1, 11), updatedAt: daysAgo(1, 11, 4) },
    { id: S2, title: "Brief for a NABH indicators guide", createdAt: daysAgo(6, 15), updatedAt: daysAgo(6, 15, 9) },
  ],
});

function scanTool() {
  const latest = reports().at(-1);
  const rows = latest.results.slice(0, 12).map((r) => ({ question: r.query, engine: r.engine, answered: r.answered, mentioned: r.mentioned, cited: r.brand_cited, competitorsNamed: (r.raw?.competitors_found_in_text || []).slice(0, 2) }));
  return {
    type: "tool-get_scan_report", toolCallId: "sample_call_scan", state: "output-available",
    input: { scanId: latest.scan.id },
    output: { data: { engines: Object.keys(latest.scan.engines || {}), competitors: RIVALS.map((r) => r.name), coverage: { planned: latest.results.length, answered: latest.results.length, notAnswered: 0, failed: 0 }, rows } },
  };
}

export function session(id) {
  const latest = reports().at(-1).scan;
  if (id === S1) {
    return {
      session: { id: S1, title: "Where does NorthPeak beat us?", createdAt: daysAgo(1, 11), updatedAt: daysAgo(1, 11, 4), hasKickoff: false },
      activeTurn: null,
      messages: [
        { id: "su1", role: "user", metadata: { kind: "chat", source: "composer" }, parts: [{ type: "text", text: "Where do AI answers name NorthPeak but not us?" }] },
        {
          id: "sa1", role: "assistant", metadata: { costKnown: true, costUsd: 0.0034, turnId: "sample_turn_1" },
          parts: [
            scanTool(),
            { type: "text", text: `In your latest scan ${BRAND} was named on ${latest.prompts_mentioned} of ${latest.prompts_tracked} questions. NorthPeak takes most of the rest, and the pattern is clear:\n\n1. **NABH reporting questions.** Answers cite nabh.co and NorthPeak's accreditation guide; none cite brightwave.io.\n2. **Readmission benchmarks.** Your benchmarks article is cited by Perplexity but not by ChatGPT or Google's AI Overview.\n3. **"Best software for a 200-bed hospital".** Answers list suites; ${BRAND} is missing because no page says which hospital sizes it fits.\n\nThe quickest win is a page on NABH quality indicators with the full list and how ${BRAND} reports each one. Want me to draft a brief?` },
          ],
        },
      ],
    };
  }
  if (id === S2) {
    return {
      session: { id: S2, title: "Brief for a NABH indicators guide", createdAt: daysAgo(6, 15), updatedAt: daysAgo(6, 15, 9), hasKickoff: false },
      activeTurn: null,
      messages: [
        { id: "su2", role: "user", metadata: { kind: "chat", source: "composer" }, parts: [{ type: "text", text: "Write a brief for a NABH quality indicators guide." }] },
        { id: "sa2", role: "assistant", metadata: { costKnown: true, costUsd: 0.0051, turnId: "sample_turn_2" }, parts: [{ type: "text", text: "**Working title:** NABH quality indicators: the full list, and how to report each one\n\n**Who it is for:** quality managers preparing for NABH 5th edition assessment.\n\n**Must include:** the indicator list by chapter, the formula and data source for each, a worked readmission-rate example, and a short section on automating the monthly return.\n\n**Sources to beat:** nabh.co (the standard itself) and northpeak.com/guides/nabh (cited in 9 answers).\n\nI've added it to Content Studio as a draft for your review." }] },
      ],
    };
  }
  return undefined;
}
