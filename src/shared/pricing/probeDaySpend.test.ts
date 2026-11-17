import test from "node:test";
import assert from "node:assert/strict";
import { probeDaySpendToday } from "./probeDaySpend.ts";

// Fake PostgREST that honours .range() and caps each response at 1000 rows, like hosted Supabase.
function fakeAdmin(tables: Record<string, any[]>, opts: { failTable?: string } = {}) {
  const inCalls: number[] = [];
  return {
    inCalls,
    admin: {
      from(table: string) {
        let rows = tables[table] ?? [];
        let range: [number, number] = [0, 999];
        const q: any = {
          select: () => q,
          gte: () => q,
          not: () => q,
          order: () => q,
          in: (col: string, ids: string[]) => {
            inCalls.push(ids.length);
            rows = rows.filter((r) => ids.includes(r[col]));
            return q;
          },
          range: (from: number, to: number) => {
            range = [from, to];
            return q;
          },
          then: (resolve: any) => {
            if (opts.failTable === table) return resolve({ data: null, error: { message: "boom" } });
            const [from, to] = range;
            return resolve({ data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null });
          },
        };
        return q;
      },
    } as any,
  };
}

test("probeDaySpendToday sums past the 1000-row PostgREST cap", async () => {
  const attempts = Array.from({ length: 2500 }, () => ({ charged_usd: null, reserved_usd: 0.2 }));
  const { admin } = fakeAdmin({ probe_attempts: attempts });
  assert.equal(await probeDaySpendToday(admin), 500);
});

test("probeDaySpendToday chunks scan ids and does not count covered scans as legacy", async () => {
  const scans = Array.from({ length: 250 }, (_, i) => ({ id: `s${i}`, cost_total: 1 }));
  const jobs = scans.map((s, i) => ({ id: `j${i}`, result_id: s.id }));
  const { admin, inCalls } = fakeAdmin({ scans, scan_jobs: jobs });
  assert.equal(await probeDaySpendToday(admin), 0);
  assert.ok(inCalls.every((n) => n <= 100), `id list too long: ${inCalls}`);
});

test("probeDaySpendToday throws when scan_jobs fails instead of counting every scan as legacy", async () => {
  const { admin } = fakeAdmin({ scans: [{ id: "s1", cost_total: 5 }] }, { failTable: "scan_jobs" });
  await assert.rejects(() => probeDaySpendToday(admin));
});
