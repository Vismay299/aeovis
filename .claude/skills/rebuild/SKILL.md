---
name: rebuild
description: Run the Perceev R0-R6 real-surface rebuild through its orchestration system. Use when the user asks to work the rebuild roadmap, advance a phase (R0-R6), continue the rebuild, check rebuild progress, or work a specific rebuild task id like R2.3.1. Spawns the rebuild-controller, which dispatches implementer, test-author, verifier, surveyor and scribe subagents against the task ledger.
---

# Rebuild orchestration

The rebuild has 121 tasks across seven phases, tracked in
`.claude/orchestration/tasks.json` and driven by one controller agent.

## Start it

Spawn `rebuild-controller` with the Agent tool. Pass it the scope the user asked
for and nothing else — it reads its own state:

- "advance the rebuild" -> current phase, next ready batch
- "work R0" / "continue R2" -> `--phase R0`
- "do R2.3.1" -> that task and its unmet dependencies
- "where does the rebuild stand" -> no dispatch, just `status` and a read of the
  tracker; do not spawn workers for a question

The controller owns dispatch. Do not spawn implementers yourself alongside it —
two dispatchers on one ledger will collide on the same files.

## If nested subagents are unavailable

Some Claude Code versions do not let a subagent spawn subagents. If the controller
reports it cannot dispatch, act as the controller from the main session: follow
`.claude/agents/rebuild-controller.md` yourself and spawn the workers directly.
The protocol is identical — only who runs the loop changes.

## Read first

- `.claude/orchestration/README.md` — how the system fits together
- `docs/plans/2026-08-29-rebuild-roadmap.md` — the human tracker (generated)
- `docs/BUILD_JOURNAL.md` — the 37 findings this rebuild closes

## The one rule

A task closes only when a verifier that did not write the code has exercised the
acceptance criterion and the close carries file:line evidence. The CLI enforces
both. If you find yourself wanting to bypass it, the task is not done.
