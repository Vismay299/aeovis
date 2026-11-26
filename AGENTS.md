# AGENTS.md

Rules for every coding agent working in this repository (Claude Code, Cursor,
Codex, OpenCode, Antigravity, and any other). `CLAUDE.md` holds the same
rules for Claude plus the binding secrets-hygiene section; read it too.

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
- Never print or commit a credential; see "Secrets hygiene" in `CLAUDE.md`.
