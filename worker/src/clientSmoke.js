/**
 * Client smoke (R1.2.21) — construct the fleet's REAL Supabase client, offline.
 *
 * WHY THIS EXISTS. The fleet was deployed to the ratified host on 2026-09-17 and
 * never completed a pass. Every pass died in resolveClient() with
 *   "Node.js detected but native WebSocket not found ... Ensure you are running
 *    Node.js 22+"
 * because the image was built FROM node:20 and @supabase/supabase-js builds a
 * realtime client at construction, which needs the native WebSocket that only
 * exists from Node 22. Nothing caught it: `--selftest` needs no credentials by
 * design (R1.2.2), so it never constructs a client, and CI ran `--selftest`
 * inside the image and reported green for an image that could not do its job.
 * The production ledger showed it plainly once anyone looked — zero
 * `probe-fleet` rows against 82 from the scan sweep — but a missing row is the
 * quietest possible failure.
 *
 * So this constructs the client through the SAME function the fleet uses
 * (resolveClient in ./lib/queue.js), with placeholder credentials. It opens no
 * connection and sends nothing: construction is synchronous and local. If the
 * runtime cannot build the client, this exits non-zero — in `npm run check`, in
 * CI on the host, and in CI inside the built image.
 *
 * The URL and key below are PLACEHOLDERS, deliberately unusable, and must stay
 * that way (CLAUDE.md, secrets hygiene): nothing here may ever need a real value.
 */
import { resolveClient, resetQueueClient } from "./lib/queue.js";

const PLACEHOLDER = Object.freeze({
  supabaseUrl: "https://example-not-a-real-project.supabase.co",
  supabaseKey: "sk-EXAMPLE-NOT-A-REAL-KEY",
});

function main() {
  resetQueueClient();
  let client;
  try {
    client = resolveClient(PLACEHOLDER);
  } catch (err) {
    console.error(
      `[fleet] client smoke FAILED on Node ${process.version}: the Supabase client could not be ` +
        `constructed — ${err.message}\n` +
        `This is the failure that kept the deployed fleet from ever completing a pass. ` +
        `worker/Dockerfile and worker/package.json "engines" must agree on a Node that has a native WebSocket (22+).`
    );
    process.exit(1);
  }
  if (!client || typeof client.from !== "function" || typeof client.rpc !== "function") {
    console.error(
      `[fleet] client smoke FAILED on Node ${process.version}: resolveClient returned ` +
        `${client === null ? "null" : typeof client}, not a usable client.`
    );
    process.exit(1);
  }
  resetQueueClient();
  console.log(`[fleet] client smoke ok on Node ${process.version}: the Supabase client constructs.`);
}

main();
