# Handoff: scan completeness, Offcult demo and project consolidation — 20 October 2026

> <!-- doc-status -->
> **Status: LIVE.** Resume checkpoint written at the end of the 20 October session. It records what is merged and deployed, what is still owed, and exactly how to continue. It is not release acceptance: P0 remains unaccepted.

Read this first, then [the earlier P0 handoff](./P0-HANDOFF-2026-10-20.md) for P0 history, and [P0 release qualification](./P0-RELEASE-QUALIFICATION.md) for evidence detail. Repository rules in `CLAUDE.md` apply, especially secrets hygiene: never print a credential, and exclude `.env*` from every recursive search.

## Where the project lives now

| Location | State |
|---|---|
| GitHub `main` | `dfc9b40` — PRs #14, #15 and #10 merged. Source of truth. |
| Google Drive project (`My Drive/Projects/AEO`) | On `main` at `dfc9b40`, working tree identical to GitHub, no untracked files, no stashes. **This is the working copy from now on.** |
| Production | Vercel `aeo-vis`, deployment `aeo-1b1yw7p1z` built from `dfc9b40` (GitHub deployment status: success). Public alias `perceev.xyz`. |
| Desktop checkout (`~/Desktop/Projects/AEO`) | Superseded. Safe to delete: no unpushed commits; its stashes and untracked files are archived on GitHub (below). |
| `~/.codex/worktrees/finish-p0/AEO` | Old worktree whose Git data lives in the Desktop folder. All work in it is merged. Delete it with the Desktop folder. |

Archived local-only work on GitHub: `archive/local-wip` (the 15 October audit files plus four early R05 test drafts under `archive/`), and the raw stashes `archive/stash-wip-p0`, `archive/stash-wip-before-pull`, `archive/stash-wip-before-pull-session2`. Two broken clones made on a Windows machine were moved (not deleted) to `My Drive/Projects/AEO-archive-2026-10-20/`.

Before working in the Drive copy, run `npm ci` (and `npm --prefix worker ci` for Playwright): its `node_modules` predates `package.json` on `main`. Expect Google Drive to be slow for Git; one checkout failed mid-way with `mmap failed: Operation canceled` and succeeded on retry. Do not run Git against the Drive folder from two machines at once.

## What was fixed this session (merged in #15, deployed)

The reported problem was "scans run but only 5–10 questions show up". Causes found and fixed:

1. **Dispatch was strictly serial and engine-first** inside a ~75 s chunk, so a stalled hand-off left only one engine's first few questions. Each engine now has its own serial lane (`src/lib/workers/durableProbing.js`); SQL claims still serialize.
2. **Short provider backoffs stalled the scan** until a portal poll or the daily cron. Work due within 10 minutes is now bridged inside the function lifetime (`deferredResumeWaitMs` in `scanWorker.js`).
3. **The report listed only questions with a stored row.** Finalize records `planned_questions`; the customer report lists every planned question in panel order and names engines not collected.
4. **Google AI Overview collection was nearly dead.** Bright Data's rendered-AIO mode (`brd_ai_overview=2`) fails with `No ready cookies`; the adapter now falls back to the standard SERP in the same deadline, remembers the empty pool for 10 minutes, and records `aio_capture_mode` on every row.
5. **Misleading numbers:** headline refusal reason (`entity_resolution_policy_mixed` from empty slices), "answers naming you 0 of 30", Google card "0 of 30 questions answered", dashboard coverage/presence tiles, a false "Google degraded — re-run" banner for validated no-AIO SERPs, the "Who holds the answer" chart that never drew, and Google-only verdict copy.
6. The measurement history now covers a full 200-question × 4-engine panel and shows each question.

Verification at merge: 3,558 tests (3,486 pass, 0 fail, 72 skipped), build, 11 real PostgreSQL workflow groups, 18 local Chromium groups (0 paid requests), CI green. P0 hosted checks on the #14 deployment: 11/11 groups, 0 paid requests, fixture cleaned.

## Real Offcult scan (local, real providers, production code path)

A 30-question India panel for Offcult (oversized/heavyweight tees, anime graphics, streetwear) plus 2 branded diagnostics ran locally through sourcing → durable dispatch → finalize, with an in-memory store mirroring the SQL contract and no database writes:

- 120 of 120 planned observations attempted: ChatGPT, Gemini, Perplexity 32/32 answered; Google 28 valid SERPs, 4 Google "challenge" failures; 0 not attempted. 25 minutes.
- Headline visibility 1.1 % (qualified), rank #11. Bewakoof leads (≈51 %), then The Souled Store, Uniqlo, Bonkers Corner. Offcult named on one non-branded question (ChatGPT) and in every branded check.
- **Google showed no AI Overview on any of the 28 valid searches.** Long chat-style and short keyword-style Indian shopping queries alike rarely carry an inline Overview in the standard SERP. Only Bright Data's rendered mode would catch asynchronously loaded ones, and its cookie pool for India is empty. That is a Bright Data account/zone question for the operator — raise it before demoing Google.

Spend: about USD 7 reserved for the full run, plus a few dollars from an accidental partial re-run during a replay (stopped after two chunks; the replay now refuses unless every row is terminal).

## Production Offcult demo — next steps

The demo tenant was re-registered with **the owner's personal email address** (an earlier invented plus-address was wrong and is unused). Its password is in the private credential file below — read it from the file, never print it.

1. **Owner:** click the verification email perceev sent to the owner's personal email address.
2. **Setup (no provider calls):** `node ~/.aeovis-private/scripts/demo-prod.mjs setup https://perceev.xyz ~/.aeovis-private/demo/offcult-cred.json ~/.aeovis-private/demo/offcult-panel.json ~/.aeovis-private/demo/offcult-prod-state.json` — logs in, creates the Offcult workspace, saves and approves the 30-question panel, prints the workspace key.
3. **Owner-authorised dispatch:** production dispatch is paused with an empty allowlist (last set by QA cleanup; re-read before acting). Allow only this workspace: `select set_probe_rollout(true, true, array['<workspace key>']);` (service role only; the allowlist holds at most one brand).
4. **Paid scan:** same script with `scan`, then `report`. The report phase checks that all 30 planned questions appear on the portal page with every engine, counts AI Overviews and capture modes, and saves a full-page screenshot.
5. **Afterwards:** remove the allowlist — `select set_probe_rollout(true, true, '{}'::text[]);` — and record the result in the qualification record.

Do not call `set_probe_rollout(false, …)`: that unpauses ordinary dispatch for everyone and is a separate release decision.

## Still open

- **P0 step 6 (privacy withdrawal of older QA/canary captures):** blocked by the agent permission policy. The 8 candidate observation IDs (4 hosted canaries from `p0-hosted-provider-evidence.json`, 4 owned-rollout observations from `p0-owned-rollout-evidence.json`) are listed in `~/.aeovis-private/p0-deploy/withdraw-candidates.json`; send them in two batches through the protected `withdraw_redaction` operator action. Needs the owner's explicit go-ahead.
- Fresh positive Google AIO capture fidelity under redaction v2; R02-12 supported-provider idempotency (no adapter declares it); human calibration; the seven-day soak; remaining P1/P2 acceptance. See the backlog.
- A 0-byte file literally named `'+JSON.stringify(v))` is committed on `main` (since `55bb83e`); a one-line cleanup PR can remove it.
- Several dashboard (anonymous free-scan) surfaces still derive per-engine wording from the AIO slice beyond the tiles fixed here; review with a multi-engine scan before using that dashboard in a demo.

## Private local files — paths only

Kept outside Google Drive so credentials are not synced to the cloud. Directory mode 0700, files 0600. Never commit or print their contents.

| Path | Purpose |
|---|---|
| `~/.aeovis-private/demo/offcult-cred.json` | Demo tenant login (the owner's personal email address) |
| `~/.aeovis-private/demo/offcult-panel.json` | The approved 30 + 2 question panel payload (not secret) |
| `~/.aeovis-private/demo/offcult-local-run.json` | Full local real-provider run record and observations |
| `~/.aeovis-private/scripts/` | Demo, report-render and Bright Data diagnostic scripts used this session |
| `~/.aeovis-private/p0-deploy/` | Durable copy of the P0 operator state the earlier handoff kept in `/tmp/aeovis-p0-deploy` |

Credentials for harnesses: the Drive project's `.env.local` (identical to the old Desktop copy). It syncs to Google Drive — consider moving it out of the synced folder and passing it with `--env-file`.
