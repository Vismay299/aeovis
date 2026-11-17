import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../app/api/customer/audit/[auditId]/cancel/route.ts";
import { DELETE } from "../../app/api/customer/audit/[auditId]/route.ts";
import { AppError } from "../../shared/http/appError.ts";

const auditId = "6f1d2c3b-0a4e-4b8f-9c1d-2e3f4a5b6c7d";
const context = { params: { auditId } };
const workspace = { user: { id: "user-1", email: "owner@example.com" }, brandKey: "brand-1", role: "member", brand: {}, admin: {} };
const baseDeps = { requireWorkspace: async () => workspace, isFeatureEnabled: async () => true };
function request(body = {}) { return new Request(`https://app.example/api/customer/audit/${auditId}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }

test("cancel returns 202 while active and idempotent 200 when finished", async () => {
  const active = await POST(request({ brand_key: "brand-1" }), context, { ...baseDeps, cancelAudit: async () => ({ status: "cancelling" }) });
  assert.equal(active.status, 202);
  assert.deepEqual(await active.json(), { status: "cancelling" });
  const done = await POST(request(), context, { ...baseDeps, cancelAudit: async () => ({ status: "completed" }) });
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { status: "completed" });
});

test("cancel validates the body and respects feature flags", async () => {
  const invalid = await POST(request({ unexpected: true }), context, baseDeps);
  assert.equal(invalid.status, 400);
  const off = await POST(request(), context, { ...baseDeps, isFeatureEnabled: async () => false });
  assert.equal(off.status, 404);
  assert.equal((await off.json()).code, "feature_unavailable");
  const deleteOff = await DELETE(request(), context, { ...baseDeps, isFeatureEnabled: async () => false });
  assert.equal(deleteOff.status, 404);
  assert.equal((await deleteOff.json()).code, "feature_unavailable");
});

test("delete rejects running audits and non-starters, then returns deleted", async () => {
  const running = await DELETE(request(), context, { ...baseDeps, deleteAudit: async () => { throw new AppError(409, "audit_running", "Cancel the audit before deleting it."); } });
  assert.equal(running.status, 409);
  assert.equal((await running.json()).code, "audit_running");
  const forbidden = await DELETE(request(), context, { ...baseDeps, deleteAudit: async () => { throw new AppError(403, "owner_required", "Only the workspace owner or the person who started this audit can delete it."); } });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, "owner_required");
  const deleted = await DELETE(request(), context, { ...baseDeps, deleteAudit: async () => ({ deleted: true }) });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deleted: true });
});
