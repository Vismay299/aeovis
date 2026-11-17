import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../shared/http/appError.ts";
import { buildKickoff, clearKickoffsForTesting, registerKickoff } from "./kickoff.ts";

const WS = { user: { id: "u1", email: "u@example.test" } } as never;
const ADMIN = {} as never;

test("kickoff: a registered builder returns its label and text", async () => {
  clearKickoffsForTesting();
  registerKickoff("qa_report", async ({ kickoff }) => ({
    label: "Generate the " + String(kickoff.templateId) + " report",
    text: "Use the template " + String(kickoff.templateId) + ".",
  }));
  const built = await buildKickoff({
    admin: ADMIN,
    ws: WS,
    kickoff: { kind: "qa_report", templateId: "tpl-1" },
  });
  assert.deepEqual(built, {
    label: "Generate the tpl-1 report",
    text: "Use the template tpl-1.",
  });
});

test("kickoff: an unknown kind is 409 no_kickoff with the exact copy", async () => {
  clearKickoffsForTesting();
  await assert.rejects(
    buildKickoff({ admin: ADMIN, ws: WS, kickoff: { kind: "nope" } }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "no_kickoff");
      assert.equal(error.message, "There is nothing to start in this chat.");
      return true;
    },
  );
});

test("kickoff: F22 registers none, so an empty registry has nothing to build", async () => {
  clearKickoffsForTesting();
  await assert.rejects(buildKickoff({ admin: ADMIN, ws: WS, kickoff: {} }), { code: "no_kickoff" });
});

test("kickoff: duplicate and invalid kinds are refused", () => {
  clearKickoffsForTesting();
  registerKickoff("qa_once", async () => ({ label: "a", text: "b" }));
  assert.throws(() => registerKickoff("qa_once", async () => ({ label: "a", text: "b" })), {
    code: "duplicate_kickoff_kind",
  });
  assert.throws(() => registerKickoff("Not Valid", async () => ({ label: "a", text: "b" })), {
    code: "invalid_kickoff_kind",
  });
});
