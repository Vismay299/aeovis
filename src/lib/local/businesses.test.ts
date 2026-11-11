import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../http/appError.ts";
import { listBusinesses, removeBusiness, saveBusiness, updateBusinessRole } from "./businesses.ts";
import { localKit, makeWs } from "./testKit.ts";

const ws = makeWs();

test("saveBusiness stores identity only and the profile stays null", async () => {
  const { deps, store } = localKit();
  const saved = await saveBusiness(ws, { role: "own", title: "Offcult Store", cid: "123", latitude: 19.076, longitude: 72.8777 }, deps);
  assert.equal(saved.role, "own");
  assert.equal(saved.profile, null);
  assert.equal(saved.profileFetchedAt, null);
  assert.equal(saved.cid, "123");
  assert.equal([...store.businesses.values()][0]?.profile, null);
});

test("saveBusiness needs a CID or a place ID", async () => {
  const { deps } = localKit();
  await assert.rejects(
    saveBusiness(ws, { role: "competitor", title: "Name only" }, deps),
    (err: unknown) => err instanceof AppError && err.status === 400 && err.code === "identifier_required",
  );
});

test("a second own business demotes the first to competitor", async () => {
  const { deps } = localKit();
  const first = await saveBusiness(ws, { role: "own", title: "First", cid: "1" }, deps);
  const second = await saveBusiness(ws, { role: "own", title: "Second", placeId: "ChIJ2" }, deps);
  const list = await listBusinesses(ws, deps);
  assert.deepEqual(
    list.map((b) => [b.title, b.role]),
    [
      ["Second", "own"],
      ["First", "competitor"],
    ],
  );
  assert.notEqual(first.id, second.id);
});

test("the eleventh competitor is refused with 409 competitor_limit", async () => {
  const { deps } = localKit();
  for (let i = 1; i <= 10; i += 1) await saveBusiness(ws, { role: "competitor", title: `C${i}`, cid: String(i) }, deps);
  await assert.rejects(
    saveBusiness(ws, { role: "competitor", title: "C11", cid: "11" }, deps),
    (err: unknown) => err instanceof AppError && err.status === 409 && err.code === "competitor_limit",
  );
});

test("listBusinesses lists own first, then competitors by title, scoped to the workspace", async () => {
  const { deps } = localKit();
  await saveBusiness(ws, { role: "competitor", title: "Zed", cid: "3" }, deps);
  await saveBusiness(ws, { role: "competitor", title: "Alpha", cid: "2" }, deps);
  await saveBusiness(ws, { role: "own", title: "Mine", cid: "1" }, deps);
  await saveBusiness(makeWs("other.example"), { role: "own", title: "Elsewhere", cid: "9" }, deps);
  assert.deepEqual((await listBusinesses(ws, deps)).map((b) => b.title), ["Mine", "Alpha", "Zed"]);
});

test("updateBusinessRole changes the role and 404s for another workspace's business", async () => {
  const { deps } = localKit();
  const a = await saveBusiness(ws, { role: "competitor", title: "A", cid: "1" }, deps);
  const updated = await updateBusinessRole(ws, a.id, "own", deps);
  assert.equal(updated.role, "own");
  await assert.rejects(
    updateBusinessRole(makeWs("other.example"), a.id, "competitor", deps),
    (err: unknown) => err instanceof AppError && err.status === 404 && err.code === "business_not_found",
  );
});

test("removeBusiness deletes it, and a second delete is 404", async () => {
  const { deps, store } = localKit();
  const a = await saveBusiness(ws, { role: "own", title: "A", cid: "1" }, deps);
  await removeBusiness(ws, a.id, deps);
  assert.equal(store.businesses.size, 0);
  await assert.rejects(
    removeBusiness(ws, a.id, deps),
    (err: unknown) => err instanceof AppError && err.code === "business_not_found",
  );
});

test("a new own business is refused with 409 when demoting the old one would leave 11 competitors, and nothing changes", async () => {
  const { deps, store } = localKit();
  await saveBusiness(ws, { role: "own", title: "Mine", cid: "1" }, deps);
  for (let i = 1; i <= 10; i += 1) await saveBusiness(ws, { role: "competitor", title: `C${i}`, cid: String(100 + i) }, deps);
  const rolesBefore = [...store.businesses.values()].map((b) => [b.id, b.role]);
  await assert.rejects(
    saveBusiness(ws, { role: "own", title: "New own", cid: "999" }, deps),
    (err: unknown) => err instanceof AppError && err.status === 409 && err.code === "competitor_limit",
  );
  assert.deepEqual([...store.businesses.values()].map((b) => [b.id, b.role]), rolesBefore, "the demotion is rolled back and no row is added");
  assert.equal([...store.businesses.values()].filter((b) => b.role === "own").length, 1);
});

test("promoting one of ten competitors to own is net zero and still works", async () => {
  const { deps } = localKit();
  await saveBusiness(ws, { role: "own", title: "Mine", cid: "1" }, deps);
  const rivals = [];
  for (let i = 1; i <= 10; i += 1) rivals.push(await saveBusiness(ws, { role: "competitor", title: `C${i}`, cid: String(100 + i) }, deps));
  const promoted = await updateBusinessRole(ws, rivals[3]!.id, "own", deps);
  assert.equal(promoted.role, "own");
  const list = await listBusinesses(ws, deps);
  assert.equal(list.filter((b) => b.role === "competitor").length, 10);
  assert.equal(list.filter((b) => b.role === "own").length, 1);
  assert.equal(list.find((b) => b.title === "Mine")?.role, "competitor");
});
