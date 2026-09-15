# Plans

> <!-- doc-status -->
> **Status: LIVE.** How this folder works. Read the status header on any plan before acting on it.

This folder contains implementation plans, design decisions, and feature specifications for the AEO (AnswerRank) project.

## Status headers — mandatory

Every document under `docs/`, plus `DESIGN.md` and `PRODUCT.md`, carries a
status header directly under its title:

```
> <!-- doc-status -->
> **Status: LIVE.** <why this is the authority>
```

Three values, and they describe the document's **authority**, not how much of it
shipped:

| Value | Means |
|---|---|
| `LIVE` | This document is currently authoritative. Implement from it. |
| `SUPERSEDED-BY <link>` | A named later document is authoritative instead. Kept for its rationale; do not implement from it. |
| `HISTORICAL` | A record of past work. Not an authority for current decisions. |

This exists because four documents claimed design authority at once with no
supersession markers between them, so "what does the design say" had four
answers and no way to choose. `DESIGN.md` is the live one; the others now say so
themselves.

`2026-08-29-rebuild-roadmap.md` is **generated** by
`node .claude/orchestration/orchestrate.mjs render` and carries its header
automatically. Never hand-edit it — edits belong in the ledger.

## Closing an item

A checkbox is not evidence. An item is closed when, **in the same commit**:

1. its box is ticked, and
2. the commit body cites the `file:line` where the change actually lives, and
3. the acceptance criterion was exercised — not read, not reasoned about, run.

If the criterion could not be exercised in the environment at hand, the item is
**blocked with the reason**, not closed. A skip is not a success. This is the
rule the whole R0–R6 rebuild exists to install, and the orchestration CLI
enforces it mechanically: `orchestrate.mjs` refuses to close a task without a
passing verification and at least one citation that resolves to a real file.

## Purpose

- Capture **why** a change is being made
- Document the chosen approach (not all alternatives)
- List critical files, reusable utilities, and verification steps
- Serve as reference for future work and for onboarding

## Folder Structure & Naming

```
docs/plans/
├── README.md
├── 2026-07-05-mvp-implementation-plan.md          ← large efforts
└── 2026-07-10-add-competitor-input.md             ← smaller features
```

### Recommended Conventions

- **Date prefix**: `YYYY-MM-DD-` so plans sort chronologically.
- **Slug**: kebab-case, short but descriptive.
- **Large initiatives**: Use subfolders when it makes sense:
  - `docs/plans/mvp/`
  - `docs/plans/features/`
  - `docs/plans/infra/`
- Keep individual plan files self-contained and actionable.

## Current Plans

| Plan | Description |
|------|-------------|
| [2026-07-05-mvp-implementation-plan.md](./2026-07-05-mvp-implementation-plan.md) | Full review of the MVP Implementation Document against the existing Next.js prototype. Includes grilling questions, gaps analysis, and a detailed spec for refining the document. |
| [2026-07-06-visibility-score-accuracy-roadmap.md](./2026-07-06-visibility-score-accuracy-roadmap.md) | Roadmap for multi-signal visibility score accuracy (pre–AIO-only pivot). |
| [2026-07-10-aio-only-branch-fix-plan.md](./2026-07-10-aio-only-branch-fix-plan.md) | Step-by-step fix plan for AIO-only logic on `updated-logic-july10` (gates, coverage, normalize, denominators, branded reuse, tests) — brand-agnostic. |

## How to Create a New Plan

1. Create a new file using the naming convention above.
2. Include these sections (adapt as needed):
   - Context
   - Current State / Relevant Code
   - Recommended Approach
   - Critical Files to Modify
   - Existing Utilities to Reuse
   - Detailed Changes / Steps
   - Verification
3. Reference this README so others know the format.

## Related Documentation

- Main MVP Implementation Document: `../aeo-visibility-tracker-mvp-implementation-document-v1.md`
- See also the root `README.md` for getting started.

---

*This structure is designed to grow as more plans (big and small) are created.*
