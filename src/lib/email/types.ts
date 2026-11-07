export type TransactionalTemplate = "scan_finished" | "schedule_skipped" | "spend_cap_reached";

export type EmailCategory = "scan_results" | "schedule_alerts" | "spend_alerts" | "product_updates";

export const TEMPLATE_CATEGORY: Record<TransactionalTemplate, EmailCategory> = {
  scan_finished: "scan_results",
  schedule_skipped: "schedule_alerts",
  spend_cap_reached: "spend_alerts",
};

export const MILESTONES = [
  "workspace_created",
  "first_scan_completed",
  "schedule_set",
  "gsc_connected",
  "audit_run",
  "draft_approved",
  "assistant_used",
] as const;

export type Milestone = (typeof MILESTONES)[number];

export const MILESTONE_PROPERTY: Record<Milestone, string> = {
  workspace_created: "workspaceCreated",
  first_scan_completed: "firstScanCompleted",
  schedule_set: "scheduleSet",
  gsc_connected: "gscConnected",
  audit_run: "auditRun",
  draft_approved: "draftApproved",
  assistant_used: "assistantUsed",
};

export type EmailOutboxRow = {
  id: string;
  kind: "transactional" | "event" | "contact";
  template: string;
  user_id: string;
  brand_key: string | null;
  dedupe_key: string;
  data: Record<string, string>;
  status: "pending" | "sending" | "sent" | "skipped" | "failed";
  attempts: number;
  next_attempt_at: string;
  claimed_until: string | null;
  claimed_by: string | null;
  skip_reason: string | null;
  error_code: string | null;
  loops_duplicate: boolean;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};
