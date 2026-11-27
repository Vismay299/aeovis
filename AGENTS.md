# AGENTS.md

Rules for every coding agent working in this repository (Claude Code, Cursor,
Codex, OpenCode, Antigravity, and any other). This is the single source of truth
for repository-wide agent instructions. Read this entire file before starting
any work, including research, planning, implementation, review, testing or
starting a subagent. Read applicable scoped instructions and task briefs as well.
`CLAUDE.md` is only a compatibility import; change shared rules here, never in
both files. Follow the user's authorization and applicable safety constraints;
if a task brief contradicts these rules, stop and report the conflict.

## Mandatory PStack workflow

Before investigating, coding, reviewing, writing documentation, or delegating
any repository task, **read `.agents/skills/pstack-workflow/SKILL.md` and follow it**.
Explicitly invoke the native PStack mode if installed; otherwise follow the
repository-local workflow and consult the applicable skills/principles.
This is a requirement for every agent and subagent, not an optional slash
command. Include the skill path and acceptance checks in delegated briefs.
Existing project rules, secrets hygiene, user authorization and CI gates
take precedence over upstream PStack guidance.

## Branches and releases

- `main` is production (Vercel production: perceev.xyz, aeo-vis.vercel.app).
  Never commit to `main` directly.
- `dev` is the working branch (Vercel preview; stable URL
  https://aeo-vis-git-dev-vismays-projects-e0c6f290.vercel.app).
- Do work on a feature branch off `dev`, open a pull request into `dev`, and
  merge it when CI is green. Small changes may go to `dev` directly.
- Release = a pull request from `dev` into `main`, merged with
  **"Create a merge commit"**. Never "Squash and merge" or "Rebase and merge"
  for `dev` → `main`: a squash gives `main` a commit `dev` does not have, the
  branches' histories diverge, and the next release PR re-lists old work and
  can conflict with itself.
- If `main` ever gets a commit `dev` lacks (a hotfix, or a past squash), merge
  `main` back into `dev` straight away (`git checkout dev && git merge origin/main`).
  Do not reset or force-push `dev`.
- Never force-push `dev` or `main`.
- Commit or push only when the person you are working for asks.

## What dev shares with production, and what it does not

- Same code once `dev` is merged into `main`.
- The stable `dev` preview uses the separate **Perceev Dev** Supabase project
  (`ecdftygawkptxfkwdgfd`) and synthetic QA data. Apply new migrations to that
  project before testing code that depends on them.
- Vercel's `dev` branch overrides point app links to the preview and clear
  paid provider, email, and analytics credentials. Keep those overrides
  isolated when adding providers. Vercel crons run on production, and the
  staging database's HTTP job tick is disabled. If you reapply migration 043
  on staging, unschedule `perceev-jobs-tick` again.
- Previews sit behind Vercel Authentication. Use the stable `dev` URL for
  testing. Deployment URLs built before the cutover and other preview
  branches can still use production settings.
- Local development reads `.env.local` by default. Verify the Supabase target
  before running a script or starting a local session that can write data.

## Before you merge

- `npm test` passes.
- `next build` succeeds.
- UI changes are checked in a real browser, not only by tests.
- Never print or commit a credential; see "Secrets hygiene" below.

## Skill routing

When the user's request matches an available skill, invoke it via the harness's
native skill mechanism (the Skill tool in Claude Code). When in doubt, invoke
the skill. The slash commands below are existing workflow names, not a requirement
that every harness support slash commands. If the native mechanism is unavailable,
locate and read the corresponding repository skill and its required references,
then follow its applicable workflow with the tools you have. If a skill or required
capability is missing, report that limitation and use a safe equivalent; do not
claim that a skill or a tool ran when it did not.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Subagents, delegation and context management

- Prefer focused skills and subagents for independent research, architecture,
  implementation, tests and review when they add value. Do not spawn agents for
  trivial tasks or pretend that an unavailable capability exists.
- Use the harness's native subagent/task mechanism. In Claude Code, use Agent
  and existing definitions under `.claude/agents/` when appropriate. For other
  harnesses use their supported equivalent. For a reusable agent definition,
  follow that harness's format; specify the role/name, purpose and invocation
  conditions, allowed tools, scope, inputs, expected output and acceptance checks.
  Do not create a permanent definition when a one-off task prompt suffices.
- Every delegated agent must read the root `AGENTS.md` before work. Pass its
  path and the applicable rules explicitly in the brief; if the harness cannot
  load it, supply the rules directly. Include the task goal, relevant spec and
  file paths, current state, constraints, permitted actions, file ownership,
  acceptance criteria and required evidence. Assume fresh agents have no
  parent conversation context.
- Split independent work into bounded tasks with non-overlapping write sets;
  use separate worktrees when isolation is needed. Serialize shared-file edits,
  migrations and verification that mutates shared state. Never overwrite a
  sibling's changes or allow a worker to broaden its scope.
- Keep the coordinator responsible for the plan, integration, permissions and
  final verification. Delegate review/testing to a fresh agent where possible;
  for substantial changes, do not rely only on the implementer's own verdict.
  Reviewers should return evidence and findings, not silently change code.
- Each worker reports changed files, exact checks and results, unresolved
  risks and blockers. The coordinator reviews the diff, reconciles handoffs,
  runs the required integration checks and distinguishes verified results from
  assumptions. No agent may commit, push, deploy, access production or expand
  permissions beyond the user's authorization.
- Keep context bounded: use separate sessions or agents for distinct tasks;
  preserve decisions and progress in the designated task ledger or handoff
  files, not just in a long chat. Read the current evidence before resuming;
  never assume an earlier claim still holds.
- If the harness cannot spawn subagents, use separate sessions if available,
  otherwise execute roles sequentially with distinct briefs and review passes.
  Disclose reduced independence. Do not weaken any task-specific mandatory
  gate or treat a skipped verification as a pass.
- For the R0-R6 rebuild, follow the role definitions in `.claude/agents/` and
  controller ledger workflow. For feature phases, follow
  `features/_BUILD-PROMPT.md` and `features/00-CONVENTIONS.md`. For frontend
  design work, consult `docs/design/FRONTEND_BUILD_PROMPT.md` when applicable.
  Repository-wide rules above remain binding on every role.

## Secrets hygiene — binding on every session and every agent

This applies to every session and every agent in this project: the main
session, the `rebuild-*` agents, skills, and anything else spawned here. It
lives here once (R6.1.9); every session and delegated agent must receive it,
including when the harness does not load repository instructions automatically.

Two agents working R0.1.6 pasted live credentials into their transcripts by
running an unscoped recursive search that matched `.env.local`: one printed most
of an API key, the other an entire service-account private key. Both disclosed
it themselves, which is the norm to keep. The second leak happened *after* the
first was reported, and nothing about that failure is specific to one agent.

- **Never print a credential value.** Do not echo, `cat`, quote, paraphrase or
  partially redact one — in a command, a tool result you re-quote, or a report. A
  prefix is still a leak. Name the variable instead: "`SUPABASE_SERVICE_ROLE_KEY`
  is set" is the most you ever write. To move a value (e.g. into `vercel env
  add`), pipe it from the file without printing it.
- **Exclude `.env*` from every recursive search.** Pass the filter every time;
  never rely on your pattern being narrow enough to miss a secret.
  - ripgrep: `rg --glob '!.env*' <pattern>`
  - grep: `grep -r --exclude='.env*' <pattern> .`
  - the Grep tool: scope `path` to the subtree you actually mean (`src/`,
    `.claude/`), and when you must search from the repo root pass
    `glob: "!.env*"`.
  - `git grep` searches only tracked files, so it cannot reach `.env.local` —
    prefer it for source archaeology.
  - Never add `--no-ignore`, `-uu` or `--hidden` at the repo root. Those flags
    are exactly what turns a safe search into a leak.
  - Debug output counts: `--debug`/verbose flags on CLIs (e.g. `vercel curl`)
    can print bypass tokens and headers. Do not re-quote them.
- **`.env.example` is safe — read and edit it freely.** It holds placeholder
  names and no values, and several tasks require changing it. The forbidden
  files are the real ones: `.env`, `.env.local`, `.env.*.local`, and anything
  git-ignored. Keep that distinction; a rule banning all `.env*` access would be
  broken within the hour and then ignored entirely.
- **Never invent a realistic-looking key**, even as an illustration. Write
  `sk-EXAMPLE-NOT-A-REAL-KEY`.
- **If a secret appears anyway: stop, do not repeat it, disclose it.** Do not
  re-run the command, do not copy the output into your report, do not quote a
  shortened version of it. In your final report name the file and the variable —
  by name, never by value — so the operator can rotate it. A self-disclosed leak
  is a rotation ticket; a hidden one is a breach.

`src/server/agentSecretsGuard.test.mjs` asserts this section is present here, and
that every `.claude/agents/rebuild-*.md` points to it, and that `CLAUDE.md`
remains an import rather than a second copy.
