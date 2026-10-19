import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { levelForCase } from "./caseInventory.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const LEVEL_SUITE = { D: "database", B: "browser", L: "live", M: "manual", S: "soak" };

// Evidence is a reviewable attestation from a dedicated job or a human, not a
// substitute for that job. Bind it to this exact source and fixture inventory.
export async function loadReleaseEvidence(filename, { commit, manifestHash, now = Date.now() }) {
  const packet = JSON.parse(await readFile(filename, "utf8"));
  const require = (condition, message) => { if (!condition) throw new Error(`release evidence: ${message}`); };
  require(packet.schemaVersion === 1, "unsupported schemaVersion");
  require(packet.commit === commit, "commit does not match the checkout");
  require(packet.manifestHash === manifestHash, "fixture manifest hash does not match");
  require(packet.sourceClean === true, "evidence was produced from uncommitted source");
  require(packet.environment === "qa", "environment must be qa");
  require(Array.isArray(packet.cases) && packet.cases.length > 0, "no case evidence");
  const base = await realpath(path.dirname(filename));
  const byCase = new Map();
  for (const row of packet.cases) {
    require(row && typeof row === "object", "invalid case row");
    require(LEVEL_SUITE[levelForCase(row.case)] === row.suite && row.suite, `wrong external suite for ${row.case}`);
    require(!byCase.has(row.case), `duplicate case ${row.case}`);
    require(["pass", "fail", "blocked", "skipped"].includes(row.outcome), `invalid outcome for ${row.case}`);
    const start = Date.parse(row.startedAt), end = Date.parse(row.endedAt);
    require(Number.isFinite(start) && Number.isFinite(end) && end >= start && end <= now + 60_000, `invalid timestamps for ${row.case}`);
    require(typeof row.expected === "string" && row.expected.trim() && typeof row.actual === "string" && row.actual.trim(), `expected/actual required for ${row.case}`);
    require(typeof row.command === "string" && row.command.trim(), `command or review procedure required for ${row.case}`);
    require(Array.isArray(row.artifacts), `artifacts required for ${row.case}`);
    if (row.outcome === "pass") {
      require(row.artifacts.length > 0, `passing ${row.case} has no artifacts`);
      if (row.suite === "manual") {
        require(row.review?.reviewer?.trim() && row.review?.rubric?.trim() && row.review?.decision === "approved", `signed reviewer/rubric/decision required for ${row.case}`);
      }
    }
    for (const artifact of row.artifacts) {
      require(typeof artifact.path === "string" && !path.isAbsolute(artifact.path), `artifact must be relative for ${row.case}`);
      const resolved = await realpath(path.resolve(base, artifact.path));
      require(resolved.startsWith(base + path.sep), `artifact escapes packet directory for ${row.case}`);
      require(sha256(await readFile(resolved)) === artifact.sha256, `artifact hash mismatch for ${row.case}`);
    }
    byCase.set(row.case, row);
  }
  return byCase;
}
