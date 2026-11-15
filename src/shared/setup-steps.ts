// Portions ported from upstream (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/dashboard/dashboardSteps.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export type SetupStep =
  | "questions"
  | "scan"
  | "gsc"
  | "audit"
  | "schedule"
  | "ga4"
  | "draft"
  | "team";

export const SETUP_STEPS: readonly {
  id: SetupStep;
  label: string;
  detail: string;
  icon:
    | "ListChecks"
    | "Radar"
    | "Search"
    | "ClipboardCheck"
    | "CalendarClock"
    | "ChartLine"
    | "PenLine"
    | "Users";
  flag?: "site_audit" | "customer_scheduling" | "ga4";
  ownerOnly?: boolean;
}[] = [
  {
    id: "questions",
    label: "Approve your questions",
    detail:
      "Choose the buyer questions every scan asks. Scans start once they're approved.",
    icon: "ListChecks",
  },
  {
    id: "scan",
    label: "Run your first AI visibility scan",
    detail:
      "See whether ChatGPT, Gemini, Perplexity and Google's AI Overviews name you.",
    icon: "Radar",
  },
  {
    id: "gsc",
    label: "Connect Google Search Console",
    detail:
      "Import the searches and pages that already bring people to your site.",
    icon: "Search",
  },
  {
    id: "audit",
    label: "Audit your site",
    detail:
      "Find blocked AI crawlers, broken links and missing structured data.",
    icon: "ClipboardCheck",
    flag: "site_audit",
  },
  {
    id: "schedule",
    label: "Schedule scans",
    detail: "Track changes weekly; you approve the monthly cost once.",
    icon: "CalendarClock",
    flag: "customer_scheduling",
  },
  {
    id: "ga4",
    label: "Connect Google Analytics",
    detail: "See which pages bring engaged visitors.",
    icon: "ChartLine",
    flag: "ga4",
  },
  {
    id: "draft",
    label: "Create your first content draft",
    detail:
      "Turn a question you're losing into an article AI engines can cite.",
    icon: "PenLine",
  },
  {
    id: "team",
    label: "Invite a teammate",
    detail: "Share the work, or keep things solo for now.",
    icon: "Users",
    ownerOnly: true,
  },
] as const;

export type SetupActivation = {
  completed: Record<SetupStep, boolean>;
  dismissed: SetupStep[];
};

export function getSetupStepStatus(
  a: SetupActivation,
  step: SetupStep,
): "done" | "skipped" | "todo" {
  if (a.completed[step]) return "done";
  if (a.dismissed.includes(step)) return "skipped";
  return "todo";
}

export function visibleSetupSteps(
  features: Record<string, boolean>,
  role: "owner" | "member",
): SetupStep[] {
  return SETUP_STEPS.filter((s) => {
    if (s.flag && !features[s.flag]) return false;
    if (s.ownerOnly && role !== "owner") return false;
    return true;
  }).map((s) => s.id);
}
