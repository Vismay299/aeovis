import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractFreeScanQuestions,
  readFreeScanPrefill,
  importFreeScanQuestions,
} from "./freeScanHandoff.ts";
import { AppError } from "../../shared/http/appError.ts";

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/f27"
);

const validScan = JSON.parse(
  fs.readFileSync(path.join(FIXTURES_DIR, "free-scan-row.json"), "utf8")
);
const otherHostScan = JSON.parse(
  fs.readFileSync(path.join(FIXTURES_DIR, "free-scan-other-host.json"), "utf8")
);
const claimedScan = JSON.parse(
  fs.readFileSync(path.join(FIXTURES_DIR, "free-scan-claimed.json"), "utf8")
);

function makeFakeAdmin(scansTable: Record<string, unknown>[]) {
  return {
    from: (table: string) => {
      assert.equal(table, "scans");
      return {
        select: (_cols: string) => ({
          eq: (col: string, val: string) => ({
            maybeSingle: async () => {
              assert.equal(col, "id");
              const row = scansTable.find((s) => s.id === val);
              return { data: row ?? null, error: null };
            },
          }),
        }),
      };
    },
  } as any;
}

test("extractFreeScanQuestions extracts 24 valid distinct questions from free-scan-row.json", () => {
  const extracted = extractFreeScanQuestions(validScan);
  assert.equal(extracted.length, 24);
  // Ensure duplicates, controls, branded, and short queries were excluded
  assert.ok(!extracted.some((q) => q.toLowerCase().includes("control query test")));
  assert.ok(!extracted.some((q) => q.toLowerCase().includes("acme")));
  assert.ok(!extracted.some((q) => q === "Short?"));
});

test("F27-AC-06 importFreeScanQuestions imports 24 questions in order with correct parameters", async () => {
  const recordedCalls: Array<Record<string, unknown>> = [];
  const fakeAdmin = makeFakeAdmin([validScan]);

  const mockAdd = async (_admin: any, input: any) => {
    recordedCalls.push(input);
    return { question: {} as any, created: true, revived: false };
  };

  const ws = {
    brandKey: "brand-123",
    brand: {
      brand_key: "brand-123",
      website_host: "acme.example",
    },
  };

  const now = () => new Date("2026-11-15T12:00:00Z").getTime();

  // Console spy to ensure NO question text is logged
  const logged: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args) => logged.push(args.join(" "));
  console.warn = (...args) => logged.push(args.join(" "));
  console.error = (...args) => logged.push(args.join(" "));

  try {
    const result = await importFreeScanQuestions(
      fakeAdmin,
      ws,
      validScan.id,
      "user-456",
      { addWorkspaceQuestion: mockAdd as any, now }
    );

    assert.equal(result.imported, 24);
    assert.equal(result.reason, "ok");
    assert.equal(recordedCalls.length, 24);

    for (const call of recordedCalls) {
      assert.equal(call.brandKey, "brand-123");
      assert.equal(call.createdBy, "user-456");
      assert.equal(call.status, "paused");
      assert.equal(call.origin, "promptgen");
      assert.equal(call.topic, "From your free scan");
      assert.deepEqual(call.sourceRef, { kind: "free_scan", id: validScan.id });
      assert.equal(typeof call.text, "string");
      assert.ok((call.text as string).length >= 8);
    }

    // Verify console spy never saw question text
    for (const call of recordedCalls) {
      const qText = call.text as string;
      for (const logLine of logged) {
        assert.ok(!logLine.includes(qText), "Question text leaked into console logs!");
      }
    }
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
});

test("F27-AC-06 importFreeScanQuestions returns appropriate failure reasons", async () => {
  const ws = {
    brandKey: "brand-123",
    brand: {
      brand_key: "brand-123",
      website_host: "acme.example",
    },
  };
  const now = () => new Date("2026-11-15T12:00:00Z").getTime();

  // 1. Unknown id
  const adminEmpty = makeFakeAdmin([]);
  const resNotFound = await importFreeScanQuestions(
    adminEmpty,
    ws,
    "00000000-0000-4000-8000-000000000000",
    "user-1",
    { now }
  );
  assert.equal(resNotFound.imported, 0);
  assert.equal(resNotFound.reason, "not_found");

  // 2. Claimed scan
  const adminClaimed = makeFakeAdmin([claimedScan]);
  const resClaimed = await importFreeScanQuestions(
    adminClaimed,
    ws,
    claimedScan.id,
    "user-1",
    { now }
  );
  assert.equal(resClaimed.imported, 0);
  assert.equal(resClaimed.reason, "not_anonymous");

  // 3. Other host
  const adminOtherHost = makeFakeAdmin([otherHostScan]);
  const resOtherHost = await importFreeScanQuestions(
    adminOtherHost,
    ws,
    otherHostScan.id,
    "user-1",
    { now }
  );
  assert.equal(resOtherHost.imported, 0);
  assert.equal(resOtherHost.reason, "host_mismatch");

  // 4. 31-day-old scan
  const oldScan = {
    ...validScan,
    id: "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d99",
    created_at: "2026-10-01T10:00:00Z",
  };
  const adminOld = makeFakeAdmin([oldScan]);
  const resTooOld = await importFreeScanQuestions(
    adminOld,
    ws,
    oldScan.id,
    "user-1",
    { now }
  );
  assert.equal(resTooOld.imported, 0);
  assert.equal(resTooOld.reason, "too_old");
});

test("F27-AC-06 importFreeScanQuestions stops at question_limit and reports reason", async () => {
  const ws = {
    brandKey: "brand-123",
    brand: {
      brand_key: "brand-123",
      website_host: "acme.example",
    },
  };
  const now = () => new Date("2026-11-15T12:00:00Z").getTime();
  let count = 0;

  const mockAddWithLimit = async () => {
    count++;
    if (count === 10) {
      throw new AppError(409, "question_limit", "You can track up to 100 questions.");
    }
    return { question: {} as any, created: true, revived: false };
  };

  const fakeAdmin = makeFakeAdmin([validScan]);
  const res = await importFreeScanQuestions(
    fakeAdmin,
    ws,
    validScan.id,
    "user-1",
    { addWorkspaceQuestion: mockAddWithLimit as any, now }
  );

  assert.equal(res.imported, 9);
  assert.equal(res.reason, "question_limit");
});

test("F27-AC-07 readFreeScanPrefill shapes", async () => {
  const now = () => new Date("2026-11-15T12:00:00Z").getTime();
  const fakeAdmin = makeFakeAdmin([validScan]);

  // Valid scan id
  const prefill = await readFreeScanPrefill(
    fakeAdmin,
    validScan.id,
    "acme.example",
    { now }
  );
  assert.deepEqual(prefill, {
    website: "https://acme.example",
    brandName: "Acme",
    questionCount: 24,
  });

  // Domain alone
  const domainOnlyPrefill = await readFreeScanPrefill(
    fakeAdmin,
    null,
    "acme.example",
    { now }
  );
  assert.deepEqual(domainOnlyPrefill, {
    website: "https://acme.example",
    brandName: null,
    questionCount: 0,
  });

  // Mismatching domain ignores scan and falls back to domain
  const mismatchPrefill = await readFreeScanPrefill(
    fakeAdmin,
    validScan.id,
    "other.example",
    { now }
  );
  assert.deepEqual(mismatchPrefill, {
    website: "https://other.example",
    brandName: null,
    questionCount: 0,
  });
});
