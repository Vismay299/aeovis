# Rebuild orchestration

One controller, five worker roles, one ledger. Built to execute *The Real-Surface
Rebuild* (R0-R6) without the failure mode the rebuild itself exists to fix:
work that reports success it did not earn.

## Why it is shaped this way

The roadmap's companion analysis found 37 places where the product renders
success, cleanliness, or freshness it did not earn. The same class of failure
attacks a plan: tasks get marked done because code was written, not because the
behaviour changed. So the ledger refuses to close a task without (a) a passing
verification from an agent that did not write the code, and (b) a file:line
citation that resolves to a real file. Those two rules are the whole design.

## The pieces

```
.claude/agents/
  rebuild-controller.md    dispatches, closes, commits. Writes no app code.
  rebuild-surveyor.md      read-only recon; re-verifies findings against source
  rebuild-implementer.md   builds one task
  rebuild-test-author.md   tests, fixtures, guard walkers
  rebuild-verifier.md      adversarial; the only agent that closes a task
  rebuild-scribe.md        journal, ADRs, contracts, runbooks
.claude/skills/rebuild/    /rebuild — boots the controller
.claude/orchestration/
  tasks.json               the ledger: 121 tasks, deps, tags, state, evidence
  orchestrate.mjs          the only writer of tasks.json
docs/plans/2026-08-29-rebuild-roadmap.md   generated tracker — do not hand-edit
```

## The flow

```
controller: next --phase R0
    |
    +-- surveyor      re-verify the finding at HEAD (anchors are from 5111219)
    |                 "does not reproduce" is a success, not a dead end
    +-- implementer   claim -> build -> submit --evidence
    +-- test-author   coverage the acceptance criteria demand
    +-- verifier      reproduce the old failure, prove the fix, pass or fail
    |
    v
controller: verify --verdict pass -> render -> commit (code + tracker, one diff)
```

An implementer can never close its own task; the CLI rejects `verify` from the
same flow that submitted, because closing is the controller's act on a separate
verifier's word.

## Task states

`todo -> in_progress -> in_verification -> done`, with `blocked` reachable from
anywhere and a failed verification returning to `in_progress`.

## Gated tasks

27 tasks carry a tag for work that cannot be honestly finished without something
this environment lacks:

| tag | meaning |
|---|---|
| `needs-llm` | needs a working LLM key; gated behind the R5.1.2 re-enable checklist |
| `needs-secrets` | needs live vendor credentials |
| `needs-vercel` | needs Vercel project access (env vars, cron) |
| `needs-decision` | needs a human decision recorded in an ADR first |
| `needs-soak` | needs multi-day live data |

The rule the controller applies: do the part that is possible, then `block` with
the reason. Never close a gated task because its code was written but never run.
That is the product's own bug, committed against the plan.

## Commands

```bash
node .claude/orchestration/orchestrate.mjs status --phase R0
node .claude/orchestration/orchestrate.mjs next --phase R0 --limit 5
node .claude/orchestration/orchestrate.mjs show R2.3.1
node .claude/orchestration/orchestrate.mjs validate
node .claude/orchestration/orchestrate.mjs render
```

`validate` is the invariant check: no unknown deps, no cycles, nothing `done`
without evidence and a passing verification. Run it before every commit.
