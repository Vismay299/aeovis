// F23 §8 P5.T1.S1 — the browser-check fixture switch. With `F23_FIXTURE_DOCUMENTS=1`
// outside production, the document routes and the share page answer a fixed pair
// of ids and tokens from hand-written documents under `tests/fixtures/f23/` with
// no database, session or flag read, so the browser check runs against `next dev`
// with no seed data.
//
// This is the only place the switch is defined, so the production guard cannot
// drift between the three callers. It reads the environment only, never a request
// value, and nothing here is ever logged.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const BENIGN_REPORT_ID = "11111111-1111-1111-1111-111111111111";
const HOSTILE_REPORT_ID = "22222222-2222-2222-2222-222222222222";
const BENIGN_TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HOSTILE_TOKEN = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BENIGN_DOCUMENT = "tests/fixtures/f23/documents/benign.html";
const HOSTILE_DOCUMENT = "tests/fixtures/f23/documents/hostile.html";

export const FIXTURE_REPORT_TITLE = "Synthetic fixture report";
export const FIXTURE_REPORT_HOST = "acme.example";

/** True only when the fixture flag is set and the runtime is not production. */
export function isFixtureMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.F23_FIXTURE_DOCUMENTS === "1" && env.NODE_ENV !== "production";
}

export function fixtureDocumentPathForReport(reportId: string): string | null {
  if (reportId === BENIGN_REPORT_ID) return BENIGN_DOCUMENT;
  if (reportId === HOSTILE_REPORT_ID) return HOSTILE_DOCUMENT;
  return null;
}

export function fixtureDocumentPathForToken(token: string): string | null {
  if (token === BENIGN_TOKEN) return BENIGN_DOCUMENT;
  if (token === HOSTILE_TOKEN) return HOSTILE_DOCUMENT;
  return null;
}

/** Reads a fixture document; a missing file is a 404 at the call site, never a throw. */
export async function readFixtureDocument(relativePath: string): Promise<string | null> {
  try {
    return await readFile(resolve(process.cwd(), relativePath), "utf8");
  } catch {
    return null;
  }
}
