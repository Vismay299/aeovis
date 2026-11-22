# AGENTS.md

Rules for every coding agent working in this repository (Claude Code, Cursor,
Codex, OpenCode, Antigravity, and any other). `CLAUDE.md` holds the same
rules for Claude plus the binding secrets-hygiene section; read it too.

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
- Same Vercel environment variables: Preview carries every Production
  variable, including the Supabase keys and feature flags.
- **Same database.** There is no separate dev database. Scans, drafts,
  deletions and spend on a dev preview are real and visible to customers.
- Scheduled jobs (`vercel.json` crons) run only on production.
- `APP_URL` is the production address, so emails and redirects generated on
  dev link to perceev.xyz.
- Previews sit behind Vercel Authentication.
- Local development reads `.env.local`, which may not match production.

## Before you merge

- `npm test` passes.
- `next build` succeeds.
- UI changes are checked in a real browser, not only by tests.
- Never print or commit a credential; see "Secrets hygiene" in `CLAUDE.md`.
