# F00 — <Feature name>

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F00 |
| Wave | 0–5 |
| Comparison rows covered | <exact row names from the teardown> |
| Depends on | F.. (merged) |
| Blocks | F.. |
| Reserved migrations | NNN–NNN |
| Feature flag | `FEATURE_<NAME>` |
| Spend features | `<feature.key>` … (or "none") |
| OpenSEO reference | `openseo:<main paths>` at `c5f8db1` |

## 1. Summary

Two or three sentences: what the customer gets and why it matters to Perceev.

## 2. What OpenSEO does (observed)

Numbered facts, each with `openseo:<path>:<line>`. Mark anything inferred as **(inferred)**. Include data model, flows, limits, costs, UI states.

## 3. What Perceev has today

What exists, with our paths, and what is missing. Note any existing behaviour this feature must not break (P0 controls, R14 panels, current portal pages, tests that assert on markup).

## 4. Target behaviour and acceptance criteria

Numbered, testable statements with IDs `F00-AC-01` … Each says how it is verified (unit, route, DB, browser, live).

## 5. Scope

**In scope:** bullet list. **Out of scope:** bullet list (including deferred Mixed rows and anything owned by another spec, with its ID).

## 6. Design

### 6.1 Data model
Full SQL for every new table, index, constraint, RLS policy and function, in the reserved migration files. Show column comments where meaning is not obvious.

### 6.2 Server modules
File-by-file: path, exported functions with TypeScript signatures, what each does, errors thrown.

### 6.3 Jobs
Job kinds, payload types, steps (name, timeout, retries, billed), sleeps, progress reporting, completion and failure states, retention.

### 6.4 Provider calls and cost
Endpoint, request body, response fields used, unit cost and estimate formula, cache namespace/TTL/scope, spend feature key, fixture file names.

### 6.5 API routes
For each: method, path, auth, zod request schema, response JSON example, error codes, idempotency, `pollAfterSeconds` behaviour.

### 6.6 UI
Routes, navigation entry, page layout (described against F04 components), every state (loading skeleton, empty, filtered-empty, error, partial, running with progress, completed), copy for headings/buttons/errors, interactions, URL state, accessibility notes, phone layout.

### 6.7 Permissions, privacy, observability
Who can do what; what is logged; PostHog events (F26 names); what must never be logged.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:...` | `src/...` | COPY / PORT / PATTERN | … |

## 8. Implementation plan

Phases are PR-sized. Every subtask names exact files and ends in a verifiable result. No "etc.", no "as needed".

### Phase 1 — <name>
**Goal:** one sentence.

- [ ] **P1.T1 <task>**
  - [ ] **P1.T1.S1** <subtask>. *Files:* `…`. *Do:* … *Verify:* `<command>` → expected result.
  - [ ] **P1.T1.S2** …
- [ ] **P1.T2 …**

**Checkpoint:** commands to run and what must be true before the phase PR merges. List the acceptance criteria this phase completes.

### Phase 2 — …

## 9. Test plan

Table of test files and the cases each covers, mapped to acceptance criteria. Fixtures needed and how to record them safely.

## 10. Rollout and rollback

Env vars (names only), flag defaults, migration order, backfill, enabling steps for the owner, how to turn it off, data cleanup.

## 11. Risks and open questions

Each with a proposed default so implementation is never blocked.

## 12. Definition of done

Checklist: all phases merged, all ACs covered by passing tests, build green, docs and `features/README.md` status updated, owner-run live check result recorded (if any).
