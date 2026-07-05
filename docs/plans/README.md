# Plans

This folder contains implementation plans, design decisions, and feature specifications for the AEO (AnswerRank) project.

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
