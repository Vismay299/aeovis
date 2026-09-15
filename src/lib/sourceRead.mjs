/**
 * R6.4.16 — Shared source-reading guard for test files.
 *
 * A guard that reads working-tree source with fs during a test run can observe
 * a half-written file (a "torn read"). This module provides one shared read
 * helper that is robust to that race: read, and on a parse or emptiness
 * anomaly re-read once before asserting; never swallow a genuine failure.
 *
 * WHY NOT A RETRY LOOP. One retry is the minimum that distinguishes "the file
 * was being written when I read it" from "the file is genuinely empty/broken".
 * A second retry would mask a real defect. If the re-read also fails, the
 * file is in the state the test says it is.
 *
 * WHY NOT SKIP WHEN DIRTY. The accept criterion explicitly forbids this: the
 * tree is dirty almost all the time during a parallel-agent rebuild, and
 * disabling guards when they are most needed is the one thing worse than a
 * flaky guard.
 */

import { readFile } from "node:fs/promises";

/**
 * Read a source file, retrying once on a torn read (empty or suspiciously
 * short content).
 *
 * @param {string|URL} pathOrUrl — the file to read
 * @param {object} [opts]
 * @param {string} [opts.label] — human-readable name for error messages
 * @param {number} [opts.minLength] — minimum expected byte length (default 1)
 * @returns {Promise<string>} the file content
 * @throws {Error} if after one retry the content is still below minLength
 */
export async function readSourceGuarded(pathOrUrl, { label, minLength = 1 } = {}) {
  const name = label ?? String(pathOrUrl);
  let content = await readFile(pathOrUrl, "utf8");

  if (content.length >= minLength) return content;

  // Anomaly: content is shorter than expected. Re-read once.
  const retry = await readFile(pathOrUrl, "utf8");
  if (retry.length >= minLength) return retry;

  // Still anomalous after one retry — this is the genuine state of the file.
  throw new Error(
    `source-read anomaly: ${name} is ${retry.length} byte(s) after one retry ` +
      `(expected >= ${minLength}). If the file is genuinely this short, lower ` +
      `minLength; if it is a torn read, the retry should have recovered it.`
  );
}

/**
 * Read and parse a JSON file, retrying once on parse failure (corrupted or
 * partial write).
 *
 * @param {string|URL} pathOrUrl — the file to read
 * @param {object} [opts]
 * @param {string} [opts.label] — human-readable name for error messages
 * @returns {Promise<any>} the parsed JSON object
 * @throws {Error} if after one retry the content still fails to parse
 */
export async function readJsonGuarded(pathOrUrl, { label } = {}) {
  const name = label ?? String(pathOrUrl);
  const content = await readFile(pathOrUrl, "utf8");

  try {
    return JSON.parse(content);
  } catch (firstErr) {
    // Parse failed — could be a torn read. Retry once.
    const retry = await readFile(pathOrUrl, "utf8");
    try {
      return JSON.parse(retry);
    } catch {
      // Second failure: this is the genuine state of the file.
      throw new Error(
        `source-read anomaly: ${name} failed to parse as JSON after one retry. ` +
          `First error: ${firstErr.message}`
      );
    }
  }
}
