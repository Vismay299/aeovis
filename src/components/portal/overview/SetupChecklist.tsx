"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/dashboard/DashboardOnboarding.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  ChartLine,
  Check,
  ChevronRight,
  ClipboardCheck,
  ListChecks,
  PenLine,
  Radar,
  RotateCcw,
  Search,
  Users,
} from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { usePortal } from "@/components/portal/PortalShell";
import { trackEvent } from "@/shared/telemetry/client";
import { SETUP_STEPS, type SetupStep } from "@/shared/setup-steps";
import {
  useDismissSetupStep,
  useSetupActivation,
  type SetupActivationResponse,
} from "./hooks/useSetupActivation";

const STEP_ICONS = {
  ListChecks,
  Radar,
  Search,
  ClipboardCheck,
  CalendarClock,
  ChartLine,
  PenLine,
  Users,
} as const;

type StepAction =
  | { label: string; href: string }
  | { label: string; scan: true };

const STEP_ACTIONS: Record<SetupStep, StepAction> = {
  questions: { label: "Review questions", href: "/portal/measurement" },
  scan: { label: "Run scan", scan: true },
  gsc: { label: "Connect", href: "/portal/search-console" },
  audit: { label: "Audit your site", href: "/portal/audit" },
  schedule: { label: "Schedule scans", href: "/portal/settings/schedule" },
  ga4: { label: "Connect", href: "/portal/settings/integrations" },
  draft: { label: "New draft", href: "/portal/content?new=1" },
  team: { label: "Invite", href: "/portal/team" },
};

/** Members cannot complete these three rows themselves; they only see guidance. */
const MEMBER_GUIDANCE_STEPS = new Set<SetupStep>(["gsc", "schedule", "ga4"]);
const MEMBER_GUIDANCE = "Ask a workspace owner to set this up.";

export type SetupChecklistProps = {
  /** Fixture activation for render tests; the real page passes nothing. */
  activation?: SetupActivationResponse;
  /** Fixture role for render tests; defaults to the portal's owner flag. */
  role?: "owner" | "member";
};

export function SetupChecklist({
  activation: provided,
  role,
}: SetupChecklistProps = {}) {
  const { brandKey, isOwner, scan } = usePortal();
  const resolvedRole: "owner" | "member" = role ?? (isOwner ? "owner" : "member");
  const query = useSetupActivation({
    brandKey,
    enabled: provided === undefined,
    scanActive: scan?.active === true,
  });
  const dismiss = useDismissSetupStep(brandKey);
  const [selected, setSelected] = useState<SetupStep | null>(null);
  const loggedError = useRef(false);

  useEffect(() => {
    if (!query.isError || loggedError.current) return;
    loggedError.current = true;
    const message = query.error instanceof Error ? query.error.message : "unknown";
    console.error("[setup] checklist load failed:", message);
  }, [query.isError, query.error]);

  const activation = provided ?? query.data;
  if (!activation) return null;

  const statusById = new Map(
    activation.steps.map((step) => [step.id, step.status]),
  );
  const rows = SETUP_STEPS.filter(
    (step) =>
      statusById.has(step.id) &&
      !(step.ownerOnly && resolvedRole === "member"),
  ).map((step) => ({
    ...step,
    status: statusById.get(step.id) ?? "todo",
    detail:
      resolvedRole === "member" && MEMBER_GUIDANCE_STEPS.has(step.id)
        ? MEMBER_GUIDANCE
        : step.detail,
  }));
  const remaining = rows.filter((row) => row.status === "todo");
  const deferred = rows.filter((row) => row.status === "skipped");
  const completed = rows.filter((row) => row.status === "done");

  if (remaining.length === 0 && deferred.length === 0) return null;

  const trackClick = (step: SetupStep) =>
    trackEvent("dashboard:setup_step_click", { step });

  const setDismissed = (step: SetupStep, dismissed: boolean) => {
    dismiss.mutate(
      { step, dismissed },
      {
        onSuccess: () => {
          setSelected(dismissed ? null : step);
          trackEvent("dashboard:setup_step_defer", { step, dismissed });
        },
      },
    );
  };

  return (
    <section
      aria-label="Setup checklist"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <header className="border-b border-border px-5 py-5 sm:px-6">
        <h2 className="text-lg font-semibold">Get started</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Approve your questions, run a scan and connect your tools.
        </p>
      </header>
      <Accordion
        value={selected ? [selected] : []}
        onValueChange={(value) => {
          const next = remaining.find((step) => step.id === value[0])?.id;
          setSelected(next ?? null);
        }}
      >
        {remaining.map((item) => {
          const Icon = STEP_ICONS[item.icon];
          const action = STEP_ACTIONS[item.id];
          const guidanceOnly =
            resolvedRole === "member" && MEMBER_GUIDANCE_STEPS.has(item.id);
          return (
            <AccordionItem key={item.id} value={item.id}>
              <AccordionTrigger className="items-center gap-3 rounded-none border-0 px-5 py-4 hover:bg-foreground/5 hover:no-underline focus-visible:ring-inset aria-expanded:bg-primary/5 sm:px-6">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/5">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block">{item.label}</span>
                  <span className="mt-1 hidden text-xs font-normal text-muted-foreground sm:block">
                    {item.detail}
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent className="space-y-5 px-5 py-5 sm:px-6">
                {guidanceOnly ? (
                  <p className="text-sm text-muted-foreground">
                    {MEMBER_GUIDANCE}
                  </p>
                ) : "scan" in action ? (
                  <Button
                    disabled={scan?.active}
                    pending={scan?.starting}
                    onClick={() => {
                      trackClick(item.id);
                      scan?.start?.();
                    }}
                  >
                    {action.label}
                  </Button>
                ) : (
                  <Button
                    nativeButton={false}
                    render={<Link href={action.href} />}
                    onClick={() => trackClick(item.id)}
                  >
                    {action.label}
                  </Button>
                )}
                <div className="border-t border-border pt-3">
                  <Button
                    variant="ghost"
                    className="text-muted-foreground"
                    disabled={dismiss.isPending}
                    onClick={() => setDismissed(item.id, true)}
                  >
                    Skip for now
                  </Button>
                </div>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
      {deferred.length > 0 && (
        <Collapsible className="border-t border-border">
          <CollapsibleTrigger className="group flex w-full items-center gap-2 px-5 py-4 text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-6">
            <ChevronRight
              className="size-4 transition-transform group-data-panel-open:rotate-90"
              aria-hidden="true"
            />
            {deferred.length} saved for later
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="space-y-1 px-5 pb-4 sm:px-6">
              {deferred.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-lg bg-foreground/5 px-3 py-2"
                >
                  <span className="text-sm">{item.label}</span>
                  <Button
                    variant="ghost"
                    aria-label={`Restore ${item.label}`}
                    disabled={dismiss.isPending}
                    onClick={() => setDismissed(item.id, false)}
                  >
                    <RotateCcw data-icon="inline-start" aria-hidden="true" />{" "}
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
      {completed.length > 0 && (
        <Collapsible className="border-t border-border">
          <CollapsibleTrigger className="group flex w-full items-center gap-2 px-5 py-4 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-6">
            <Check className="size-4 text-success" aria-hidden="true" />
            {completed.length} completed
            <ChevronRight
              className="ml-auto size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-90"
              aria-hidden="true"
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="space-y-3 px-5 pb-5 sm:px-6">
              {completed.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-3 text-sm text-muted-foreground"
                >
                  <Check
                    className="size-4 shrink-0 text-success"
                    aria-hidden="true"
                  />
                  {item.label}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}
