/**
 * R3.2.4 — arms the live-write guard for EVERY test process. Preload only.
 *
 * WHY THIS FILE EXISTS
 * `src/lib/liveWriteGuard.js` refuses undeclared writes, but the first cut of
 * it was installed by hand at module scope in the three live-DB test files.
 * That made "the harness refuses writes by default" true of the three files
 * that remembered, and of nothing else. It was not true of the suite: six
 * other test files were calling real writers — 16 `update()`s on
 * `content_jobs`, 8 `open_scan_run()` RPCs, an `insert()` on `content_runs`,
 * one on `content_events`, one on `scan_jobs` — and were kept off production
 * only by `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` happening to be unset in
 * whichever shell ran them. `src/lib/liveDbGate.js` tells authors to run live
 * tests with `--env-file=.env.local`; following that instruction turned any of
 * those six into a production write. That is the same "luck rather than
 * design" the original incident was about.
 *
 * So this module is preloaded into every test process:
 *
 *     node --import ./src/lib/liveWriteGuardAuto.mjs --test "src/**\/*.test.mjs"
 *
 * `--import` lives in `process.execArgv`, which the node test runner passes
 * down to the child process it spawns per test file, so a file added tomorrow
 * is guarded without anybody remembering anything.
 *
 * THE POLICY IT INSTALLS IS `allow: []` — nothing is writable. A test that
 * legitimately needs to write a disposable table installs its own guard on top
 * of this one and names the table; installs stack, and the innermost policy is
 * the one in force. Uninstalling that inner guard narrows back to this one, it
 * does not disarm the process.
 *
 * IT NEVER SILENTLY DOES NOTHING. If the guard cannot arm (a transport it
 * could not patch), `installLiveWriteGuard` prints that on stderr and leaves
 * the corresponding `covers` flag false; this module additionally refuses to
 * pretend, and re-raises anything thrown while installing, which fails the
 * process before a single test runs. A test run that appears guarded and is
 * not is worse than one that is openly unguarded.
 *
 * IT IS NOT THE ONLY ARMING, AND IT WAS NOT ENOUGH ON ITS OWN. A preload wired
 * into npm scripts only guards processes those scripts start, and live tests
 * did not run under them: CI runs `test:scoring` with no `DATABASE_URL`, so
 * every gated live case skips there, and the gate's own reason string told
 * authors to run `node --env-file=.env.local --test <file>` — no preload. So
 * this file guarded the 1600 hermetic tests and none of the ones that could
 * reach production. `armedLiveDbGate()` in `src/lib/liveDbGate.js` closes that:
 * it arms the guard from inside the gate, so a live test is covered however it
 * is invoked, and `npm run test:live` carries this preload as well.
 *
 * Not wired into `next dev`, `next build` or the workers: this is a test-only
 * preload, named only in the `test`, `test:scoring` and `test:live` scripts in
 * package.json.
 */

import path from "node:path";

import { installLiveWriteGuard } from "./liveWriteGuard.js";

/**
 * Name the refusal after the file that caused it. Under `node --test` the
 * runner spawns one child per test file with that file as the entry point, so
 * `argv[1]` is the offending test — which is the first thing an author needs
 * to know and the last thing a shared label would tell them.
 */
function entryLabel() {
  const entry = process.argv[1];
  if (!entry) return "auto:(no entry file)";
  try {
    const rel = path.relative(process.cwd(), entry);
    return `auto:${rel && !rel.startsWith("..") ? rel.split(path.sep).join("/") : entry}`;
  } catch {
    return `auto:${entry}`;
  }
}

const guard = await installLiveWriteGuard({ label: entryLabel(), allow: [] });

if (!guard.covers.supabase || !guard.covers.pg) {
  // Do not throw — a missing optional driver must not stop the suite — but do
  // not let it pass as armed either. installLiveWriteGuard has already written
  // the reason to stderr; this line is the one-line summary that survives a
  // scroll-back.
  process.stderr.write(
    ` LIVE WRITE GUARD (${guard.label}): PARTIALLY ARMED — ` +
      `supabase=${guard.covers.supabase} pg=${guard.covers.pg}. ` +
      `Writes over the unpatched transport are NOT refused.\n`
  );
}

export default guard;
