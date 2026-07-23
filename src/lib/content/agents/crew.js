/**
 * The crew — the five specialist sub-agents that execute every Agent run.
 *
 * A custom Agent (e.g. "Listicle Writer") is a configured operator; the crew
 * is the fixed team that carries out its work. These are the agents the user
 * watches work live in the theater. Order = pipeline order.
 *
 * `verb` is the present-continuous line shown while the specialist is active;
 * `role` maps to the co-founder's original agent design.
 */
export const CREW = [
  {
    step: "coordinate",
    name: "Strategist",
    emoji: "🧭",
    role: "Coordinator",
    verb: "Planning the work order",
    blurb: "Reads the gap, picks the angle, fans the query out into sections.",
  },
  {
    step: "research",
    name: "Researcher",
    emoji: "🔍",
    role: "Research agent",
    verb: "Gathering grounded sources",
    blurb: "Mines the AI answers + scrapes winning pages for citable facts.",
  },
  {
    step: "benchmark",
    name: "Analyst",
    emoji: "📊",
    role: "Trend / industry analysis",
    verb: "Tearing down what gets cited",
    blurb: "Classifies the citation format distribution and issues the directive.",
  },
  {
    step: "draft",
    name: "Writer",
    emoji: "✍️",
    role: "Content creator",
    verb: "Drafting the content",
    blurb: "Writes to the agent's format, grounded only in the research pack.",
  },
  {
    step: "review",
    name: "Editor",
    emoji: "🛡️",
    role: "Master accuracy agent",
    verb: "Scoring against the rubric",
    blurb: "Fact-checks, catches slop and YMYL violations, decides pass/fail.",
  },
];

/** The learn specialist runs on human feedback, not in the main pipeline. */
export const LEARNER = {
  step: "learn",
  name: "Learner",
  emoji: "🎓",
  role: "Self-learning from feedback",
  verb: "Distilling your feedback into lessons",
  blurb: "Turns your comments into rules every future run obeys.",
};

export const CREW_BY_STEP = Object.fromEntries(CREW.map((c) => [c.step, c]));

export function crewMember(step) {
  return CREW_BY_STEP[step] || LEARNER;
}
