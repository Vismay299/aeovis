import test from "node:test";
import assert from "node:assert/strict";
import { deliverOutboxRow, buildContactPayload } from "./deliver.ts";
import { LoopsError } from "../../shared/providers/loops/client.ts";
import type { EmailOutboxRow } from "./types.ts";
import type { EmailConfig } from "./config.ts";

function createFakeAdmin(overrides?: {
  user?: any;
  userError?: any;
  brand?: any;
  membership?: any;
  membershipsForUser?: any;
  milestones?: any;
  prefs?: any;
  updatedRows?: any[];
}) {
  const updatedRows: any[] = overrides?.updatedRows ?? [];

  const admin: any = {
    auth: {
      admin: {
        getUserById: async (id: string) => {
          if (overrides?.userError) return { data: null, error: overrides.userError };
          if (overrides?.user) return { data: { user: overrides.user }, error: null };
          return {
            data: {
              user: {
                id,
                email: "user@example.test",
                email_confirmed_at: "2026-10-01T00:00:00Z",
                user_metadata: { full_name: "Test User" },
              },
            },
            error: null,
          };
        },
      },
    },
    from: (table: string) => {
      let selectedFields = "*";
      let filterCol: string | null = null;
      let filterVal: any = null;
      let secondFilterCol: string | null = null;
      let secondFilterVal: any = null;
      let inCol: string | null = null;
      let inVals: any[] | null = null;
      let updatePayload: any = null;

      const builder: any = {
        select: (fields: string) => {
          selectedFields = fields;
          return builder;
        },
        eq: (col: string, val: any) => {
          if (!filterCol) {
            filterCol = col;
            filterVal = val;
          } else {
            secondFilterCol = col;
            secondFilterVal = val;
          }
          return builder;
        },
        in: (col: string, vals: any[]) => {
          inCol = col;
          inVals = vals;
          return builder;
        },
        maybeSingle: async () => {
          if (table === "customer_brands") {
            if (overrides?.brand !== undefined) return { data: overrides.brand, error: null };
            return { data: { brand_key: filterVal, is_active: true }, error: null };
          }
          if (table === "customer_brand_memberships") {
            if (overrides?.membership !== undefined) return { data: overrides.membership, error: null };
            return { data: { brand_key: filterVal, user_id: secondFilterVal, role: "member" }, error: null };
          }
          if (table === "user_email_preferences") {
            if (overrides?.prefs !== undefined) return { data: overrides.prefs, error: null };
            return {
              data: {
                user_id: filterVal,
                product_updates: false,
                scan_results: true,
                schedule_alerts: true,
                spend_alerts: true,
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        update: (payload: any) => {
          updatePayload = payload;
          return builder;
        },
        then: (resolve: any) => {
          if (table === "email_outbox" && updatePayload) {
            updatedRows.push({ ...updatePayload, filterCol, filterVal });
            return resolve({ data: [updatePayload], error: null });
          }
          if (table === "customer_brand_memberships") {
            const data = overrides?.membershipsForUser ?? [{ brand_key: "brand-1", customer_brands: { is_active: true } }];
            return resolve({ data, error: null });
          }
          if (table === "workspace_milestones") {
            const data = overrides?.milestones ?? [{ milestone: "workspace_created" }];
            return resolve({ data, error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return builder;
    },
  };

  return { admin, updatedRows };
}

function baseRow(overrides?: Partial<EmailOutboxRow>): EmailOutboxRow {
  return {
    id: "outbox-1",
    kind: "transactional",
    template: "scan_finished",
    user_id: "user-1",
    brand_key: "brand-1",
    dedupe_key: "scan_finished:scan-1:user-1",
    data: { brandName: "Brand 1", scanDate: "22 Oct 2026" },
    status: "pending",
    attempts: 0,
    next_attempt_at: "2026-10-22T10:00:00Z",
    claimed_until: null,
    claimed_by: null,
    skip_reason: null,
    error_code: null,
    loops_duplicate: false,
    created_at: "2026-10-22T10:00:00Z",
    updated_at: "2026-10-22T10:00:00Z",
    sent_at: null,
    ...overrides,
  };
}

function baseConfig(overrides?: Partial<EmailConfig>): EmailConfig {
  return {
    apiKey: "loops-api-key",
    productUpdatesListId: "list-updates-id",
    templateIds: {
      scan_finished: "tmpl-scan-finished",
      schedule_skipped: "tmpl-schedule-skipped",
      spend_cap_reached: "tmpl-spend-cap",
    },
    linkSecret: "a-secret-that-is-at-least-32-characters-long",
    appUrl: "https://app.perceev.com",
    ...overrides,
  };
}

test("deliverOutboxRow skips with flag_off when lifecycle_email feature flag is off", async () => {
  const { admin, updatedRows } = createFakeAdmin();
  const row = baseRow();

  const res = await deliverOutboxRow(row, {
    admin,
    config: baseConfig(),
    isFeatureEnabled: async () => false,
  });

  assert.equal(res, "skipped");
  assert.equal(updatedRows.length, 1);
  assert.equal(updatedRows[0].status, "skipped");
  assert.equal(updatedRows[0].skip_reason, "flag_off");
});

test("deliverOutboxRow skips with loops_not_configured when apiKey is missing", async () => {
  const { admin, updatedRows } = createFakeAdmin();
  const row = baseRow();

  const res = await deliverOutboxRow(row, {
    admin,
    config: baseConfig({ apiKey: null }),
    isFeatureEnabled: async () => true,
  });

  assert.equal(res, "skipped");
  assert.equal(updatedRows[0].skip_reason, "loops_not_configured");
});

test("deliverOutboxRow skips with template_not_configured when transactional template ID is missing", async () => {
  const { admin, updatedRows } = createFakeAdmin();
  const row = baseRow();

  const res = await deliverOutboxRow(row, {
    admin,
    config: baseConfig({ templateIds: { scan_finished: null, schedule_skipped: null, spend_cap_reached: null } }),
    isFeatureEnabled: async () => true,
  });

  assert.equal(res, "skipped");
  assert.equal(updatedRows[0].skip_reason, "template_not_configured");
});

test("deliverOutboxRow skips with recipient_unavailable when user missing or unconfirmed", async () => {
  // Unconfirmed email
  const { admin, updatedRows } = createFakeAdmin({
    user: { id: "user-1", email: "user@example.test", email_confirmed_at: null },
  });
  const row = baseRow();

  const res = await deliverOutboxRow(row, {
    admin,
    config: baseConfig(),
    isFeatureEnabled: async () => true,
  });

  assert.equal(res, "skipped");
  assert.equal(updatedRows[0].skip_reason, "recipient_unavailable");
});

test("deliverOutboxRow skips with not_member when brand inactive or user not member", async () => {
  // Brand inactive
  const { admin: adminInactive, updatedRows: rowsInactive } = createFakeAdmin({
    brand: { brand_key: "brand-1", is_active: false },
  });
  await deliverOutboxRow(baseRow(), {
    admin: adminInactive,
    config: baseConfig(),
    isFeatureEnabled: async () => true,
  });
  assert.equal(rowsInactive[0].skip_reason, "not_member");

  // User not a member
  const { admin: adminNoMem, updatedRows: rowsNoMem } = createFakeAdmin({
    brand: { brand_key: "brand-1", is_active: true },
    membership: null,
  });
  await deliverOutboxRow(baseRow(), {
    admin: adminNoMem,
    config: baseConfig(),
    isFeatureEnabled: async () => true,
  });
  assert.equal(rowsNoMem[0].skip_reason, "not_member");
});

test("deliverOutboxRow skips with preference_off when category preference is false", async () => {
  const { admin, updatedRows } = createFakeAdmin({
    prefs: { user_id: "user-1", scan_results: false, schedule_alerts: true, spend_alerts: true, product_updates: false },
  });

  const res = await deliverOutboxRow(baseRow(), {
    admin,
    config: baseConfig(),
    isFeatureEnabled: async () => true,
  });

  assert.equal(res, "skipped");
  assert.equal(updatedRows[0].skip_reason, "preference_off");
});

test("deliverOutboxRow: successful send sets status 'sent', sent_at, loops_duplicate", async () => {
  const { admin, updatedRows } = createFakeAdmin();
  const row = baseRow();
  let txCallArgs: any = null;

  const fakeLoops = {
    updateLoopsContact: async () => {},
    sendLoopsEvent: async () => ({ duplicate: false }),
    sendLoopsTransactional: async (args: any) => {
      txCallArgs = args;
      return { duplicate: false };
    },
  };

  const fixedNow = new Date("2026-10-22T12:00:00Z");
  const res = await deliverOutboxRow(row, {
    admin,
    config: baseConfig(),
    isFeatureEnabled: async () => true,
    loopsClient: fakeLoops,
    now: fixedNow,
  });

  assert.equal(res, "sent");
  assert.equal(updatedRows.length, 1);
  assert.equal(updatedRows[0].status, "sent");
  assert.equal(updatedRows[0].sent_at, fixedNow.toISOString());
  assert.equal(updatedRows[0].loops_duplicate, false);

  // Assert idempotencyKey === row.id and unsubscribeUrl injected
  assert.equal(txCallArgs.idempotencyKey, row.id);
  assert.ok(txCallArgs.dataVariables.unsubscribeUrl.includes("scan_results"));
});

test("deliverOutboxRow: 429 at attempt 1 sets pending with next_attempt_at = now + 2 min", async () => {
  const { admin, updatedRows } = createFakeAdmin();
  const row = baseRow({ attempts: 1 });

  const fakeLoops = {
    updateLoopsContact: async () => {},
    sendLoopsEvent: async () => ({ duplicate: false }),
    sendLoopsTransactional: async () => {
      throw new LoopsError(429, "rate_limited");
    },
  };

  const fixedNow = new Date("2026-10-22T12:00:00Z");
  const res = await deliverOutboxRow(row, {
    admin,
    config: baseConfig(),
    isFeatureEnabled: async () => true,
    loopsClient: fakeLoops,
    now: fixedNow,
  });

  assert.equal(res, "retry");
  assert.equal(updatedRows.length, 1);
  assert.equal(updatedRows[0].status, "pending");
  assert.equal(updatedRows[0].error_code, "rate_limited");
  // 2^1 minutes = 2 minutes later
  assert.equal(updatedRows[0].next_attempt_at, new Date("2026-10-22T12:02:00Z").toISOString());
});

test("deliverOutboxRow: 500 at attempt 5 sets status failed", async () => {
  const { admin, updatedRows } = createFakeAdmin();
  const row = baseRow({ attempts: 5 });

  const fakeLoops = {
    updateLoopsContact: async () => {},
    sendLoopsEvent: async () => ({ duplicate: false }),
    sendLoopsTransactional: async () => {
      throw new LoopsError(500, "server");
    },
  };

  const res = await deliverOutboxRow(row, {
    admin,
    config: baseConfig(),
    isFeatureEnabled: async () => true,
    loopsClient: fakeLoops,
  });

  assert.equal(res, "failed");
  assert.equal(updatedRows.length, 1);
  assert.equal(updatedRows[0].status, "failed");
  assert.equal(updatedRows[0].error_code, "server");
});

test("deliverOutboxRow: 400 immediately sets failed with rejected_400", async () => {
  const { admin, updatedRows } = createFakeAdmin();
  const row = baseRow({ attempts: 1 });

  const fakeLoops = {
    updateLoopsContact: async () => {},
    sendLoopsEvent: async () => ({ duplicate: false }),
    sendLoopsTransactional: async () => {
      throw new LoopsError(400, "rejected");
    },
  };

  const res = await deliverOutboxRow(row, {
    admin,
    config: baseConfig(),
    isFeatureEnabled: async () => true,
    loopsClient: fakeLoops,
  });

  assert.equal(res, "failed");
  assert.equal(updatedRows.length, 1);
  assert.equal(updatedRows[0].status, "failed");
  assert.equal(updatedRows[0].error_code, "rejected_400");
});

test("buildContactPayload has seven milestone booleans and mailingLists only for contact_signup with optIn", async () => {
  const { admin } = createFakeAdmin({
    membershipsForUser: [{ brand_key: "brand-1", customer_brands: { is_active: true } }],
    milestones: [{ milestone: "workspace_created" }, { milestone: "first_scan_completed" }],
  });

  const rowSignup = baseRow({ kind: "contact", template: "contact_signup" });
  const user = {
    id: "user-1",
    email: "user@example.test",
    user_metadata: { full_name: "Jane Doe" },
  } as any;
  const cfg = baseConfig();

  // With product updates ON
  const payloadOn = await buildContactPayload(
    admin,
    rowSignup,
    user,
    { user_id: "user-1", product_updates: true, scan_results: true, schedule_alerts: true, spend_alerts: true, product_updates_changed_at: null, product_updates_source: null },
    cfg,
  );
  assert.equal(payloadOn.source, "perceev-signup");
  assert.equal(payloadOn.firstName, "Jane");
  assert.equal(payloadOn.lastName, "Doe");
  assert.equal(payloadOn.workspaceCount, 1);
  assert.equal(payloadOn.workspaceCreated, true);
  assert.equal(payloadOn.firstScanCompleted, true);
  assert.equal(payloadOn.scheduleSet, false);
  assert.equal(payloadOn.gscConnected, false);
  assert.equal(payloadOn.auditRun, false);
  assert.equal(payloadOn.draftApproved, false);
  assert.equal(payloadOn.assistantUsed, false);
  assert.deepEqual(payloadOn.mailingLists, { "list-updates-id": true });

  // With product updates OFF
  const payloadOff = await buildContactPayload(
    admin,
    rowSignup,
    user,
    { user_id: "user-1", product_updates: false, scan_results: true, schedule_alerts: true, spend_alerts: true, product_updates_changed_at: null, product_updates_source: null },
    cfg,
  );
  assert.equal(payloadOff.mailingLists, undefined);

  // For milestone update row (not contact_signup)
  const rowMilestone = baseRow({ kind: "contact", template: "contact_milestones" });
  const payloadMilestone = await buildContactPayload(
    admin,
    rowMilestone,
    user,
    { user_id: "user-1", product_updates: true, scan_results: true, schedule_alerts: true, spend_alerts: true, product_updates_changed_at: null, product_updates_source: null },
    cfg,
  );
  assert.equal(payloadMilestone.source, "perceev-app");
  assert.equal(payloadMilestone.mailingLists, undefined);
});
