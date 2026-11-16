import test from "node:test";
import assert from "node:assert/strict";

import {
  MISSING_FLAGS_MESSAGE,
  RefusalError,
  parseArgs,
  isLoopbackHost,
  targetHosts,
  assertTargetAllowed,
  assertSupabaseConfigured,
  resolveRecipient,
  buildFixtureData,
  runTestSend,
  TEMPLATES,
} from "../../../scripts/qa/send-f25-test-email.mjs";
import { TEMPLATE_KEYS, validateTemplateData } from "./templates.ts";

const ENV_OK = {
  NEXT_PUBLIC_SUPABASE_URL: "https://your-project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "EXAMPLE-NOT-A-REAL-KEY",
};

const CONFIRMED_USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "user@example.test",
  email_confirmed_at: "2026-10-22T14:30:00Z",
};

function fakeAdmin({ users = [CONFIRMED_USER], listError = null, insertError = null } = {}) {
  const calls = { listPages: 0, inserts: [] };
  const admin = {
    auth: {
      admin: {
        async listUsers({ page }) {
          calls.listPages += 1;
          if (listError) return { data: null, error: listError };
          return { data: { users: page === 1 ? users : [] }, error: null };
        },
      },
    },
    from(table) {
      return {
        insert(row) {
          calls.inserts.push({ table, row });
          return {
            select() {
              return {
                async single() {
                  return insertError
                    ? { data: null, error: insertError }
                    : { data: { id: "22222222-2222-4222-8222-222222222222" }, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  return { admin, calls };
}

const FULL_ARGS = ["--to", "user@example.test", "--template", "scan_finished", "--confirm"];

test("refuses with the documented line when no flags are passed", () => {
  assert.throws(() => parseArgs([]), (err) => {
    assert.ok(err instanceof RefusalError);
    assert.equal(err.message, "Refusing: pass --to, --template and --confirm");
    return true;
  });
});

test("refuses when any one required flag is missing", () => {
  for (const argv of [
    ["--template", "scan_finished", "--confirm"],
    ["--to", "user@example.test", "--confirm"],
    ["--to", "user@example.test", "--template", "scan_finished"],
  ]) {
    assert.throws(() => parseArgs(argv), { message: MISSING_FLAGS_MESSAGE });
  }
});

test("refuses a flag with no value without echoing the next flag", () => {
  assert.throws(() => parseArgs(["--to", "--template", "scan_finished", "--confirm"]), {
    message: MISSING_FLAGS_MESSAGE,
  });
});

test("refuses an unknown template", () => {
  assert.throws(
    () => parseArgs(["--to", "user@example.test", "--template", "contact_signup", "--confirm"]),
    { message: `Refusing: --template must be one of ${TEMPLATES.join(", ")}` },
  );
});

test("refuses an unknown argument", () => {
  assert.throws(() => parseArgs([...FULL_ARGS, "--force"]), { message: "Refusing: unknown argument" });
});

test("refuses a value that is not a single email address", () => {
  for (const to of ["not-an-address", "two@example.test other@example.test"]) {
    assert.throws(
      () => parseArgs(["--to", to, "--template", "scan_finished", "--confirm"]),
      { message: "Refusing: --to must be a single email address" },
    );
  }
});

test("accepts the documented invocation", () => {
  assert.deepEqual(parseArgs(FULL_ARGS), {
    to: "user@example.test",
    template: "scan_finished",
    confirm: true,
  });
});

test("treats only the loopback hosts as local", () => {
  for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ["db.example.test", "10.0.0.5", ""]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test("reads target hosts from names only and never echoes a URL", () => {
  assert.deepEqual(
    targetHosts({
      PGHOST: "localhost",
      DATABASE_URL: "postgres://user:secret@127.0.0.1:5432/perceev_qa",
      NEXT_PUBLIC_SUPABASE_URL: "https://your-project.supabase.co",
    }),
    ["localhost", "127.0.0.1", "your-project.supabase.co"],
  );
});

test("refuses a non-loopback target without --confirm, allows loopback without it", () => {
  assert.doesNotThrow(() => assertTargetAllowed(["localhost", "127.0.0.1"], { confirm: false }));
  assert.throws(() => assertTargetAllowed(["your-project.supabase.co"], { confirm: false }), {
    message: MISSING_FLAGS_MESSAGE,
  });
  assert.doesNotThrow(() => assertTargetAllowed(["your-project.supabase.co"], { confirm: true }));
});

test("refuses when the Supabase admin configuration is missing", () => {
  assert.throws(() => assertSupabaseConfigured({}), {
    message: "Refusing: Supabase admin configuration is required",
  });
  assert.throws(
    () => assertSupabaseConfigured({ NEXT_PUBLIC_SUPABASE_URL: ENV_OK.NEXT_PUBLIC_SUPABASE_URL }),
    { message: "Refusing: Supabase admin configuration is required" },
  );
  assert.doesNotThrow(() => assertSupabaseConfigured(ENV_OK));
});

test("resolves --to to a confirmed user, case-insensitively", async () => {
  const { admin } = fakeAdmin({
    users: [{ ...CONFIRMED_USER, email: "Owner@Example.Test" }],
  });
  assert.deepEqual(await resolveRecipient(admin, "owner@example.test"), {
    id: CONFIRMED_USER.id,
  });
});

test("refuses an unknown or unconfirmed recipient without printing the address", async () => {
  const unknown = fakeAdmin({ users: [] });
  await assert.rejects(() => resolveRecipient(unknown.admin, "user@example.test"), (err) => {
    assert.equal(err instanceof RefusalError, true);
    assert.equal(err.message.includes("example.test"), false);
    return true;
  });
  const unconfirmed = fakeAdmin({
    users: [{ ...CONFIRMED_USER, email_confirmed_at: null }],
  });
  await assert.rejects(() => resolveRecipient(unconfirmed.admin, "user@example.test"), {
    message: "Refusing: no confirmed user matches --to",
  });
});

test("every fixture template passes the allow-list and carries no answer text", () => {
  const forbidden = [
    "ACME is the best solution for startups",
    "CompetitorX",
    "CompetitorY",
    "What is the best CRM software for startups?",
    "competitorx.example.com",
  ];
  for (const template of TEMPLATES) {
    const data = buildFixtureData(template, { appUrl: "https://perceev.com" });
    assert.deepEqual(Object.keys(data).sort(), [...TEMPLATE_KEYS[template]].sort(), template);
    assert.doesNotThrow(() => validateTemplateData(template, data), template);
    const walk = JSON.stringify(data);
    for (const needle of forbidden) {
      assert.equal(walk.includes(needle), false, `${template} leaked ${needle}`);
    }
  }
});

test("writes exactly one pending outbox row and returns its id", async () => {
  const { admin, calls } = fakeAdmin();
  const result = await runTestSend({
    argv: FULL_ARGS,
    env: ENV_OK,
    deps: { admin, uuid: () => "33333333-3333-4333-8333-333333333333" },
  });

  assert.deepEqual(result, { id: "22222222-2222-4222-8222-222222222222" });
  assert.equal(calls.inserts.length, 1);
  const [insert] = calls.inserts;
  assert.equal(insert.table, "email_outbox");
  assert.equal(insert.row.kind, "transactional");
  assert.equal(insert.row.template, "scan_finished");
  assert.equal(insert.row.user_id, CONFIRMED_USER.id);
  assert.equal(insert.row.status, "pending");
  assert.equal(insert.row.brand_key, null);
  assert.equal(
    insert.row.dedupe_key,
    "manual-test:scan_finished:33333333-3333-4333-8333-333333333333",
  );
  assert.doesNotThrow(() => validateTemplateData("scan_finished", insert.row.data));
});

test("a refused invocation never reaches the service-role client or writes a row", async () => {
  const { admin, calls } = fakeAdmin();
  for (const argv of [
    [],
    ["--to", "user@example.test", "--template", "scan_finished"],
    ["--to", "user@example.test", "--template", "signed_up", "--confirm"],
    ["--confirm", "--template", "scan_finished"],
  ]) {
    await assert.rejects(() => runTestSend({ argv, env: ENV_OK, deps: { admin } }));
  }
  assert.equal(calls.listPages, 0);
  assert.equal(calls.inserts.length, 0);
});

test("a missing Supabase key is refused before any user read", async () => {
  const { admin, calls } = fakeAdmin();
  await assert.rejects(
    () =>
      runTestSend({
        argv: FULL_ARGS,
        env: { NEXT_PUBLIC_SUPABASE_URL: ENV_OK.NEXT_PUBLIC_SUPABASE_URL },
        deps: { admin },
      }),
    { message: "Refusing: Supabase admin configuration is required" },
  );
  assert.equal(calls.listPages, 0);
  assert.equal(calls.inserts.length, 0);
});

test("no confirmed recipient means no outbox row", async () => {
  const { admin, calls } = fakeAdmin({ users: [] });
  await assert.rejects(() => runTestSend({ argv: FULL_ARGS, env: ENV_OK, deps: { admin } }), {
    message: "Refusing: no confirmed user matches --to",
  });
  assert.equal(calls.inserts.length, 0);
});

test("a failed insert is refused without exposing the provider error", async () => {
  const { admin } = fakeAdmin({ insertError: { message: "permission denied for table email_outbox" } });
  await assert.rejects(
    () => runTestSend({ argv: FULL_ARGS, env: ENV_OK, deps: { admin } }),
    { message: "Refusing: the outbox row was not written" },
  );
});
