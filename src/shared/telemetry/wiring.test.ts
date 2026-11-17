/**
 * F26 §6.2.7 / §8 P4.T1.S1 — sink wiring (F26-AC-13).
 *
 * Imports every sink present in the tree, installs a recording tracker through
 * the real wiring functions with an injected capture, calls the sink with one of
 * its registry events, and asserts exactly one recorded call with that name and
 * those props. It also proves the registry is covered: every event name is
 * reachable from a sink, emitted directly in a named source file, or listed in
 * `PENDING_EMITTERS` with its owning feature id. A name in none of the three
 * fails, and so does a listed sink file that disappears.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EVENTS, type EventName } from "./events.ts";
import { runWithTelemetryContext } from "./context.ts";
import { wireServerSinks } from "./wireServerSinks.ts";
import { wireClientSinks, type ClientSinkTracker } from "../../components/app/telemetry/wireClientSinks.ts";
import { trackExport } from "../export/telemetry.ts";
import { trackKeywordResearch } from "../../components/portal/keywords/telemetry.ts";
import { trackDomainEvent, type DomainEvent } from "../../components/portal/domain/telemetry.ts";
import { trackRankEvent, type RankEventName } from "../../components/portal/rank-tracking/telemetry.ts";
import { trackBacklinksEvent, type BacklinksEventName } from "../../components/portal/backlinks/telemetry.ts";
import { trackLocalEvent, type LocalEventName } from "../../components/portal/local/telemetry.ts";
import { trackAuditEvent } from "../../components/portal/audit/telemetry.ts";
import { trackIndexNowEvent, type IndexNowEventName } from "../../components/portal/indexnow/telemetry.ts";
import { trackGa4Event, type Ga4EventName } from "../../components/portal/analytics/telemetry.ts";
import { trackAuthEvent, type AuthEventName } from "../../components/auth/telemetry.ts";
import { trackOnboardingEvent } from "../../components/portal/onboarding/telemetry.ts";

import { captureAuditEvent } from "../../server/audit/telemetry.ts";
import { trackAuthServerEvent } from "../../server/auth/telemetry.ts";
import { trackEmailEvent } from "../../server/email/telemetry.ts";
import { trackOnboardingServerEvent } from "../../server/onboarding/telemetry.ts";
import {
  __lastInitOptionsForTests,
  __resetClientForTests,
  startAnalyticsCapture,
  trackEvent,
} from "./client.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

type RecordedCall = {
  name: string;
  props: Record<string, unknown>;
  userId?: string | null;
  brandKey?: string | null;
};

type SinkCall = (sample: { name: string; props: Record<string, unknown> }) => void | Promise<void>;

type ClientSink = {
  id: string;
  file: string;
  names: readonly EventName[];
  sample: { name: EventName; props: Record<string, unknown> };
  call: SinkCall;
};

type ServerSink = ClientSink & { explicitUserId?: string };

function readProjectFile(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

/** Every client sink of §6.2.7 that exists in the tree, with the events it owns. */
const CLIENT_SINKS: readonly ClientSink[] = [
  {
    id: "export",
    file: "src/shared/export/telemetry.ts",
    names: ["data:export", "data:export_sheets", "data:export_server"],
    sample: {
      name: "data:export",
      props: { source_feature: "scans", format: "csv", result_count: 1, scope: "all" },
    },
    call: (sample) => trackExport(sample.name, sample.props),
  },
  {
    id: "keywords",
    file: "src/components/portal/keywords/telemetry.ts",
    names: [
      "keyword_research:search_complete",
      "keyword_research:serp_open",
      "keyword:save",
      "saved_keywords:bulk_remove",
      "saved_keywords:bulk_tag",
      "saved_keywords:refresh_start",
      "keywords:cluster_apply",
      "keywords:track_question",
    ],
    sample: { name: "keyword_research:serp_open", props: {} },
    call: (sample) => trackKeywordResearch(sample.name, sample.props),
  },
  {
    id: "domain",
    file: "src/components/portal/domain/telemetry.ts",
    names: [
      "domain_overview:lookup",
      "domain_overview:tab",
      "domain_overview:competitors",
      "domain_overview:add_competitor",
    ],
    sample: { name: "domain_overview:tab", props: { tab: "overview" } },
    call: (sample) => trackDomainEvent(sample.name as DomainEvent["event"], sample.props),
  },
  {
    id: "rank-tracking",
    file: "src/components/portal/rank-tracking/telemetry.ts",
    names: [
      "rank_tracking:config_create",
      "rank_tracking:keywords_add",
      "rank_tracking:check_trigger",
      "rank_tracking:pin",
      "rank_tracking:metrics_refresh",
      "rank_tracking:suggestions_open",
      "rank_tracking:export_csv",
      "rank_tracking:track_question",
    ],
    sample: { name: "rank_tracking:pin", props: { pinned: true } },
    call: (sample) => trackRankEvent(sample.name as RankEventName, sample.props),
  },
  {
    id: "backlinks",
    file: "src/components/portal/backlinks/telemetry.ts",
    names: [
      "backlinks:lookup",
      "backlinks:tab",
      "backlinks:expand_domain",
      "backlinks:ahrefs_dr",
      "backlinks:track_history",
    ],
    sample: { name: "backlinks:expand_domain", props: {} },
    call: (sample) => trackBacklinksEvent(sample.name as BacklinksEventName, sample.props),
  },
  {
    id: "local",
    file: "src/components/portal/local/telemetry.ts",
    names: [
      "local:business_saved",
      "local:profile_lookup",
      "local:listings_search",
      "local:reviews_collect",
      "local:updates_collect",
      "local:questions_collect",
      "local:serp_search",
      "local:grid_run",
    ],
    sample: { name: "local:grid_run", props: { size: 3, reused: false, points_found: 1 } },
    call: (sample) => trackLocalEvent(sample.name as LocalEventName, sample.props),
  },
  {
    id: "audit",
    file: "src/components/portal/audit/telemetry.ts",
    names: [
      "site_audit:launch_open",
      "site_audit:large_confirm",
      "site_audit:cancel",
      "site_audit:delete",
      "site_audit:lighthouse_open",
      "site_audit:compare_open",
      "site_audit:view_change",
    ],
    sample: { name: "site_audit:cancel", props: {} },
    call: (sample) => trackAuditEvent(sample.name, sample.props),
  },
  {
    id: "indexnow",
    file: "src/components/portal/indexnow/telemetry.ts",
    names: [
      "indexnow:setup",
      "indexnow:check",
      "indexnow:submit",
      "indexnow:offer_shown",
      "indexnow:offer_dismissed",
    ],
    sample: { name: "indexnow:check", props: { hosts: 1, found: 1, cached: false } },
    call: (sample) => trackIndexNowEvent(sample.name as IndexNowEventName, sample.props),
  },
  {
    id: "analytics",
    file: "src/components/portal/analytics/telemetry.ts",
    names: [
      "ga4:link_start",
      "ga4:property_select",
      "ga4:disconnect",
      "ga4:account_remove",
      "ga4:tab_view",
      "ga4:range_change",
    ],
    sample: { name: "ga4:disconnect", props: {} },
    call: (sample) => trackGa4Event(sample.name as Ga4EventName, sample.props),
  },
  {
    id: "auth",
    file: "src/components/auth/telemetry.ts",
    names: [
      "auth:sign_in_submit",
      "auth:sign_in_success",
      "auth:sign_in_block_unverified",
      "auth:sign_up_submit",
      "auth:sign_up_success",
      "auth:google_start",
      "auth:signup_blocked",
      "auth:verification_resend",
      "auth:verification_issue",
      "auth:verification_success",
      "auth:password_reset_requested",
    ],
    sample: { name: "auth:sign_in_submit", props: { method: "email" } },
    call: (sample) =>
      trackAuthEvent(
        sample.name as AuthEventName,
        sample.props as Record<string, string | number | boolean>,
      ),
  },
  {
    id: "onboarding",
    file: "src/components/portal/onboarding/telemetry.ts",
    names: [
      "onboarding:step_viewed",
      "onboarding:step_skipped",
      "onboarding:website_saved",
      "onboarding:website_save_failed",
      "onboarding:gsc_connect_clicked",
      "onboarding:gsc_property_selected",
      "onboarding:ga4_connect_clicked",
      "onboarding:preferences_saved",
      "onboarding:first_scan_started",
    ],
    sample: { name: "onboarding:step_viewed", props: { step: 1, step_name: "website" } },
    call: (sample) =>
      (
        trackOnboardingEvent as unknown as (
          name: string,
          props: Record<string, unknown>,
        ) => void
      )(sample.name, sample.props),
  },
];

/** Every server sink of §6.2.7 that exists in the tree, with the events it owns. */
const SERVER_SINKS: readonly ServerSink[] = [
  {
    id: "audit-server",
    file: "src/server/audit/telemetry.ts",
    names: ["site_audit:start", "site_audit:complete"],
    sample: {
      name: "site_audit:start",
      props: { max_pages: 50, lighthouse: false, render_js: false, trigger: "manual" },
    },
    call: (sample) => captureAuditEvent(sample.name, sample.props),
  },
  {
    id: "auth-server",
    file: "src/server/auth/telemetry.ts",
    names: ["auth:sign_up_completed"],
    sample: {
      name: "auth:sign_up_completed",
      props: { method: "email", from_free_scan: false, from_domain: false },
    },
    // F24's callback passes the new user's id as the third argument.
    explicitUserId: "user-explicit",
    call: (sample) =>
      trackAuthServerEvent(
        "auth:sign_up_completed",
        { method: "email", from_free_scan: false, from_domain: false },
        "user-explicit",
      ),
  },
  {
    id: "email",
    file: "src/server/email/telemetry.ts",
    names: ["email:sent", "email:skipped", "email:failed", "email:unsubscribed", "email:preferences_changed"],
    sample: { name: "email:sent", props: { template: "scan_report", kind: "transactional", duplicate: false } },
    call: (sample) => trackEmailEvent(sample.name, sample.props),
  },
  {
    id: "onboarding-server",
    file: "src/server/onboarding/telemetry.ts",
    names: ["onboarding:audit_started", "onboarding:free_scan_imported", "onboarding:completed"],
    sample: { name: "onboarding:audit_started", props: { started: true, reason: null } },
    call: (sample) => trackOnboardingServerEvent(sample.name, sample.props),
  },
];

/**
 * Names with a direct emitter (P4.T3). Every row requires its source file to
 * contain the event name, so a refactor that drops an emitter fails here rather
 * than passing on file existence alone.
 */
const DIRECT_EMITTERS: ReadonlyArray<{
  names: readonly EventName[];
  file: string;
  literal: boolean;
}> = [
  { names: ["project_context:updated"], file: "src/app/api/customer/context/route.ts", literal: true },
  { names: ["questions:setup_started"], file: "src/app/api/customer/questions/setup/route.ts", literal: true },
  { names: ["questions:setup_saved"], file: "src/app/api/customer/questions/setup/save/route.ts", literal: true },
  { names: ["questions:approved"], file: "src/app/api/customer/questions/approve/route.ts", literal: true },
  { names: ["questions:generated"], file: "src/app/api/customer/questions/generate/route.ts", literal: true },
  { names: ["questions:researched"], file: "src/app/api/customer/questions/research/route.ts", literal: true },
  { names: ["questions:added"], file: "src/app/api/customer/questions/route.ts", literal: true },
  { names: ["schedule:enabled", "schedule:paused", "schedule:changed"], file: "src/app/api/customer/schedule/route.ts", literal: true },
  { names: ["schedule:skipped"], file: "src/server/schedules/aiVisibilitySchedules.ts", literal: true },
  { names: ["scan:started"], file: "src/app/api/customer/scan/route.js", literal: true },
  { names: ["tool:call"], file: "src/server/tools/run.ts", literal: true },
  { names: ["prompt_explorer:run_started"], file: "src/server/explore/service.ts", literal: true },
  { names: ["prompt_explorer:run_finished"], file: "src/server/explore/job.ts", literal: true },
  { names: ["usage:page_viewed", "usage:range_changed"], file: "src/components/portal/usage/UsagePage.tsx", literal: true },
  { names: ["scan_report:cost_expanded"], file: "src/components/portal/cost/ScanCostCard.tsx", literal: true },
  { names: ["project_context:viewed"], file: "src/components/portal/context/ProjectContextPage.tsx", literal: true },
  { names: ["price:quote_shown", "price:approved", "price:changed"], file: "src/components/app/cost/CostReviewDialog.tsx", literal: true },
  { names: ["prompt_explorer:question_tracked"], file: "src/components/portal/explore/TrackQuestionButton.tsx", literal: true },
  { names: ["question_history:viewed"], file: "src/components/portal/questions/history/QuestionHistoryPage.tsx", literal: true },
  { names: ["question_history:answer_opened"], file: "src/components/portal/questions/history/AnswerPanel.tsx", literal: true },
  { names: ["scan:start_clicked"], file: "src/components/portal/useScanTracker.js", literal: true },
  { names: ["content:draft_requested"], file: "src/components/portal/content/ComposerCard.jsx", literal: true },
  { names: ["content:review_submitted"], file: "src/components/portal/content/DraftEditor.jsx", literal: true },
  { names: ["team:invite_sent"], file: "src/components/portal/team/TeamPage.jsx", literal: true },
  { names: ["gsc:connect_start", "gsc:disconnect"], file: "src/components/portal/gsc/GscPage.jsx", literal: true },
  { names: ["gsc:property_select"], file: "src/components/portal/gsc/PropertyPicker.jsx", literal: true },
  { names: ["privacy:analytics_enabled"], file: "src/components/app/telemetry/useAnalyticsConsent.ts", literal: true },
];

/**
 * Registry names no surface in this tree emits yet, each with the owning
 * feature id. F20's server sink, F22's and F23's sinks are absent from the tree;
 * F27's dashboard setup steps and F15's server-side check completion have no
 * emitter on this branch.
 */
export const PENDING_EMITTERS: Record<string, `F${number}` | "existing"> = {
  "ga4:link_complete": "F20",
  "ga4:report_view": "F20",
  "ga4:opportunities_view": "F20",
  "assistant:session_create": "F22",
  "assistant:session_archive": "F22",
  "assistant:turn": "F22",
  "assistant:tool_call": "F22",
  "assistant:approval": "F22",
  "assistant:skill_activate": "F22",
  "assistant:message_send": "F22",
  "assistant:rewind": "F22",
  "assistant:stop": "F22",
  "assistant:client_error": "F22",
  "report:saved": "F23",
  "report:opened": "F23",
  "report:exported_pdf": "F23",
  "report:shared": "F23",
  "report:unshared": "F23",
  "report:deleted": "F23",
  "report:public_view": "F23",
  "report_template:saved": "F23",
  "report_template:deleted": "F23",
  "report:generate_start": "F23",
  "rank_tracking:check_complete": "F15",
  "dashboard:setup_step_click": "F27",
  "dashboard:setup_step_defer": "F27",
};

function clientRecorder() {
  const calls: RecordedCall[] = [];
  const tracker: ClientSinkTracker = (name, props) => {
    calls.push({ name, props });
  };
  return { calls, tracker };
}

function serverRecorder() {
  const calls: RecordedCall[] = [];
  return {
    calls,
    capture: (call: {
      name: string;
      props: Record<string, unknown>;
      userId?: string | null;
      brandKey?: string | null;
    }) => {
      calls.push(call);
    },
  };
}

function registryNames(): EventName[] {
  return Object.keys(EVENTS) as EventName[];
}

test("every client sink reaches the injected trackEvent exactly once", () => {
  const { calls, tracker } = clientRecorder();
  wireClientSinks({ trackEvent: tracker });

  for (const sink of CLIENT_SINKS) {
    assert.ok(existsSync(join(ROOT, sink.file)), `missing client sink file ${sink.file}`);
    calls.length = 0;
    sink.call(sink.sample);
    assert.equal(calls.length, 1, `${sink.id} recorded ${calls.length} calls`);
    assert.equal(calls[0].name, sink.sample.name);
    assert.deepEqual(calls[0].props, sink.sample.props);
    assert.ok(EVENTS[sink.sample.name], `${sink.sample.name} is not a registry name`);
  }
});

test("every server sink reaches the injected captureServerEvent with the request identity", async () => {
  const { calls, capture } = serverRecorder();
  wireServerSinks({ captureServerEvent: capture });

  for (const sink of SERVER_SINKS) {
    assert.ok(existsSync(join(ROOT, sink.file)), `missing server sink file ${sink.file}`);
    calls.length = 0;
    await runWithTelemetryContext({ userId: "user-context", brandKey: "acme.test" }, async () => {
      await sink.call(sink.sample);
      // The sinks may dispatch synchronously or in a microtask.
      await Promise.resolve();
    });
    assert.equal(calls.length, 1, `${sink.id} recorded ${calls.length} calls`);
    assert.equal(calls[0].name, sink.sample.name);
    assert.deepEqual(calls[0].props, sink.sample.props);
    assert.equal(calls[0].userId, sink.explicitUserId ?? "user-context");
    assert.equal(calls[0].brandKey, "acme.test");
    assert.ok(EVENTS[sink.sample.name], `${sink.sample.name} is not a registry name`);
  }
});

test("wiring is idempotent: a second call keeps one tracker and installs the latest", () => {
  const first = clientRecorder();
  const second = clientRecorder();
  wireClientSinks({ trackEvent: first.tracker });
  wireClientSinks({ trackEvent: first.tracker });
  trackExport("data:export_server", { kind: "csv", format: "csv", row_count: 1 });
  assert.equal(first.calls.length, 1);

  wireClientSinks({ trackEvent: second.tracker });
  trackExport("data:export_server", { kind: "csv", format: "csv", row_count: 1 });
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);

  const serverFirst = serverRecorder();
  wireServerSinks({ captureServerEvent: serverFirst.capture });
  wireServerSinks({ captureServerEvent: serverFirst.capture });
  void captureAuditEvent("site_audit:complete", { status: "completed" });
  assert.equal(serverFirst.calls.length, 1);
});

test("every registry name is sink-reachable, emitted directly, or pending", () => {
  const owners = new Map<EventName, string>();
  const add = (name: string, where: string) => {
    assert.ok(EVENTS[name as EventName], `${where} lists unknown event ${name}`);
    assert.equal(owners.get(name as EventName), undefined, `${name} is listed twice (${where})`);
    owners.set(name as EventName, where);
  };

  for (const sink of [...CLIENT_SINKS, ...SERVER_SINKS]) {
    for (const name of sink.names) add(name, `sink ${sink.id}`);
  }
  for (const emitter of DIRECT_EMITTERS) {
    assert.ok(existsSync(join(ROOT, emitter.file)), `missing emitter file ${emitter.file}`);
    const source = emitter.literal ? readProjectFile(emitter.file) : null;
    for (const name of emitter.names) {
      add(name, `emitter ${emitter.file}`);
      if (source) {
        assert.ok(
          source.includes(`"${name}"`) || source.includes(`'${name}'`) || source.includes(`\`${name}\``),
          `${emitter.file} does not contain the literal ${name}`,
        );
      }
    }
  }
  for (const [name, owner] of Object.entries(PENDING_EMITTERS)) {
    add(name, "PENDING_EMITTERS");
    assert.equal(
      owner,
      EVENTS[name as EventName].owner,
      `${name} is pending under ${owner} but the registry says ${EVENTS[name as EventName].owner}`,
    );
  }

  const missing = registryNames().filter((name) => !owners.has(name));
  assert.deepEqual(missing, [], `registry names with no sink, emitter or PENDING_EMITTERS entry: ${missing.join(", ")}`);
  assert.equal(owners.size, registryNames().length);
});

test("sinks are no-ops when the PostHog env vars are missing", async () => {
  const envKeys = [
    "POSTHOG_PROJECT_KEY",
    "POSTHOG_HOST",
    "TELEMETRY_DISABLED",
    "NEXT_PUBLIC_POSTHOG_KEY",
    "NEXT_PUBLIC_TELEMETRY_DISABLED",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  for (const key of envKeys) saved[key] = process.env[key];

  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;
  let fetched = 0;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

  try {
    for (const key of envKeys) delete process.env[key];

    // Server half: the wired sink goes through the real `captureServerEvent`,
    // which must stop at the missing-key gate before consent, Supabase or a
    // PostHog client. A fetch from this path is the failure the test names.
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      fetched += 1;
      throw new Error("a wired server sink reached the network without POSTHOG_PROJECT_KEY");
    }) as typeof fetch;
    wireServerSinks();
    trackEmailEvent("email:sent", { template: "scan_results", kind: "event", duplicate: false });
    await tick();
    assert.equal(fetched, 0, "a wired server sink reached the network without keys");

    // Client half: the default loader must return null before it touches
    // posthog-js. `window` exists so the check exercises the key gate, not the
    // server-side `typeof window` short circuit.
    (globalThis as { window?: unknown }).window = {};
    __resetClientForTests();
    assert.doesNotThrow(() =>
      trackEvent("data:export", {
        source_feature: "scans",
        format: "csv",
        result_count: 1,
        scope: "all",
      }),
    );
    await tick();
    assert.equal(__lastInitOptionsForTests(), null, "trackEvent initialised posthog-js without a key");
    startAnalyticsCapture();
    await tick();
    assert.equal(
      __lastInitOptionsForTests(),
      null,
      "startAnalyticsCapture initialised posthog-js without a key",
    );

    // Second case: a key is present but the browser kill switch is on.
    __resetClientForTests();
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_qa_placeholder";
    process.env.NEXT_PUBLIC_TELEMETRY_DISABLED = "1";
    assert.doesNotThrow(() =>
      trackEvent("data:export", {
        source_feature: "scans",
        format: "csv",
        result_count: 1,
        scope: "all",
      }),
    );
    startAnalyticsCapture();
    await tick();
    assert.equal(
      __lastInitOptionsForTests(),
      null,
      "TELEMETRY_DISABLED=1 still initialised posthog-js",
    );
  } finally {
    for (const key of envKeys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
    __resetClientForTests();
  }
});
