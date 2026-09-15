# Scoring & Analytics Track — Execution Plan
## PM2 Session | 2026-09-13

---

## Ledger State (R2/R4/R5)

| Phase | Done | Todo | Ready Now | Status |
|-------|------|------|-----------|--------|
| R2 Scoring Truth | 57/69 | 12 | **5** | 83% — 3 downstream chains unblocked |
| R4 Ground Truth & Analytics | 2/10 | 8 | **3** | 20% — R4.3 cluster fully ready |
| R5 Content OS Quality | 3/12 | 8 | **1 + 1 operator** | 25% — R5.1.2 unblocked, critical path opens |

**Total ready in my track: 9 tasks (7 agent-executable, 1 operator-gated, 1 test)**

---

## Key Actions This Session

### 1. R5.1.2 UNBLOCKED ✅
R5.1.3 (OpenRouter key) is done. R5.1.2's deps (R5.1.1, R0.1.6, R3.6.1) are all done. I unblocked it via the ledger. This is the **single highest-priority task in the entire rebuild** — it gates the entire R5.3→R5.4 chain (5 tasks deep). It is operator-gated (`needs-llm`, `needs-secrets`) and requires the operator to execute a three-gate checklist.

**Action:** Signal to operator to claim R5.1.2 and run the key re-enable checklist.

### 2. R4.3 cluster — 3 tasks ready, zero in-flight
R4.3.1 (data), R4.3.4 (frontend), R4.3.5 (backend) are all ready with R4.3.2 and R4.3.3 done. This is the most productive cluster to attack. R4.3.1 is on the critical path for R4.4.1→R4.5.1.

### 3. R2.1.4 test unblocks two downstream chains
R2.1.4 → R2.4.1 → R2.4.2 (hero/history/sidebar scores)
R2.8.1 → R2.8.2 (engine gauges)
Plus R2.9.1 (provenance strip) needs R2.6.1.

---

## Task Assignments

### Dev3 — Scoring & Metric (backend + test lanes)

| Priority | Task | Lane | Title | Why This Task |
|----------|------|------|-------|---------------|
| **P1** | R2.6.1 | backend | Finalize writes per-prompt brands_elicited | Field exists, nothing writes it. Unblocks R2.6.2 and R2.9.1. Anchored to scanWorker.js. |
| **P2** | R2.1.4 | test | Tests: fully-errored engine renders failed | Critical path — unblocks R2.4.1 chain + R2.8.1. Assert 100%-errored engine contributes nothing to index. |
| **P3** | R4.3.5 | backend | sov_state columns → metrics API | Backend pass-through of sov_state/sov_state_reason + scanWorker comment fix. Anchored at route.js:76, scanWorker.js:1867. |

**Dependency notes for Dev3:**
- R2.6.1: deps R2.3.1 ✅ done. After R2.6.1, R2.6.2 and R2.9.1 become ready.
- R2.1.4: deps R2.1.3 ✅ done. After R2.1.4, R2.4.1 becomes ready → then R2.4.2.
- R4.3.5: deps R4.3.2 ✅ done. Can start immediately.

### Dev4 — Analytics & Content (data + frontend lanes)

| Priority | Task | Lane | Title | Why This Task |
|----------|------|------|-------|---------------|
| **P1** | R4.3.1 | data | crawlability_audits history & change detection | Critical path for entire R4.4→R4.5 chain. "Your site started blocking GPTBot on Tuesday" becomes an event. |
| **P2** | R4.3.4 | frontend | Metrics endpoint passes SOV state to client | Fixes bare null so client can render em-dash + state chip. Frontend half of the R4.3.5 backend task. |
| **P3** | R2.8.1 | frontend | Gate Studio and Opportunities on data quality | Studio says "no gaps" on all-errored scan. Unblocks R2.8.2 (engine gauges). |
| **P4** | R2.8.20 | frontend | ContentLiftPanel fabricated-URL row | Already-gated frontend fix; R5.2.1 API returns truth, component ignores it. |
| **P5** | R2.7.17 | frontend | Ungated readers count errored rows | Chip says "Names you" while row says "Error". Standalone fix in AnswersView.jsx + lift route. |

**Dependency notes for Dev4:**
- R4.3.1: deps R3.2.1 ✅ done. After R4.3.1, R4.4.1 becomes ready.
- R4.3.4: deps R4.3.2 ✅ done. Frontend companion to Dev3's R4.3.5.
- R2.8.1: deps R2.1.3 ✅ done. After R2.8.1, R2.8.2 becomes ready.
- R2.8.20: deps R5.2.1 ✅ done. Standalone.
- R2.7.17: no deps. Standalone. Complex design decision required (see below).

### Operator

| Task | Lane | Title | Why Operator |
|------|------|-------|-------------|
| **R5.1.2** | docs | Key re-enable checklist | Three gates: (1) check:secrets passes, (2) metered call proves price known in catalogue, (3) SOV exits 'not assessed'. Requires live LLM key. Unblocks entire R5.3→R5.4 chain. |
| **R5.2.2** | backend | Publish step with verification | Operator pastes live URL, system verifies it resolves and content matches before stage flips to PUBLISHED. This is the backend publish gate. |

---

## Critical Path Map

```
R5.1.2 [OPERATOR] ──→ R5.3.1 ──→ R5.3.2 ──→ R5.3.3 ──→ R5.4.1 ──→ R5.4.3
                                                         ↑
R5.4.2 ──────────────────────────────────────────────────┘
                                                         
R2.6.1 [Dev3] ──→ R2.6.2
                  R2.9.1

R2.1.4 [Dev3] ──→ R2.4.1 ──→ R2.4.2
              └──→ R2.8.1 [Dev4] ──→ R2.8.2

R4.3.1 [Dev4] ──→ R4.4.1 ──→ R4.5.1
R4.3.4 [Dev4]  (parallel with R4.3.5 [Dev3])
R4.3.5 [Dev3]  (parallel with R4.3.4 [Dev4])

R5.2.2 [OPERATOR] ──→ R5.2.3
                     R5.4.3
```

**Longest chain:** R5.1.2 → ... → R5.4.3 (6 tasks). This is the #1 bottleneck.

---

## Coordination Notes

### R4.3.4 + R4.3.5 — Split Frontend/Backend
These two tasks fix the same defect from both ends:
- **R4.3.5 (Dev3/backend):** Make `sov_state` and `sov_state_reason` survive the metrics API route at `route.js:76-88`. Fix the stale scanWorker comment. Update PROD_MIGRATIONS.md.
- **R4.3.4 (Dev4/frontend):** Make the client render em-dash + state chip instead of bare null. Consumer of the API response.

**Coordination:** Dev3 should go first (backend API change), then Dev4 picks up the frontend to consume the new fields. Or they can work in parallel since the frontend can mock the new fields for testing.

### R2.7.17 — Design Decision Required
This task is complex. It requires deciding and documenting ONE rule: does a citation measured on a surviving search leg count as "visibility" when the answer leg failed? Current state:
- `probeResultContract.js:397` enforces `visible = brand_mentioned_in_text || brand_cited`
- `probeAio` leaves all derived flags at initialiser on error (so not visible)
- `probeTextEngine` preserves visible on error (so visible if cited)
- Two engines follow different rules — that's the real defect

**Recommendation:** Dev4 picks this up after R2.8.1 since it's frontend-heavy and the design decision affects AnswersView.jsx, the lift route, and probeAio.

### R5.1.2 Operator Checklist (Three Gates)
1. **Gate 1:** `check:secrets` passes — should already pass with R5.1.3 done
2. **Gate 2:** One metered call proves cost lands in price table — since z-ai/glm-5.2:free is priced at prompt 0/completion 0, the gate is "the price must be KNOWN in the catalogue", not "must be non-zero"
3. **Gate 3:** SOV surfaces exit 'not assessed' — verify the SOV display shows a measured value

### Test Coverage Notes
- R2.1.4 [test] is the only test-lane task ready, but every backend task should include tests per standing rule 6
- R2.6.1 explicitly requires "a test covers it"
- R4.3.5 explicitly requires "a test drives a self-only-roster series through the route and asserts not_assessed is distinguishable from measured_zero"

---

## Execution Sequence (Recommended)

### Wave 1 — Immediate (no dependencies between these)
1. **R5.1.2** [operator] — Claim and run checklist. Highest leverage.
2. **R2.6.1** [Dev3] — Write brands_elicited. Quick backend fix, unblocks 2 tasks.
3. **R4.3.1** [Dev4] — crawlability_audits history. Critical path for R4.
4. **R5.2.2** [operator] — Publish step verification. Unblocks R5.2.3 + R5.4.3.

### Wave 2 — After Wave 1
5. **R2.1.4** [Dev3] — After R2.6.1, pivot to this test. Critical path for R2 scoring.
6. **R4.3.5** [Dev3] — Backend sov_state pass-through (can parallel with Dev4's R4.3.4).
7. **R4.3.4** [Dev4] — Frontend sov_state rendering (companion to R4.3.5).
8. **R2.8.1** [Dev4] — Gate Studio/Opportunities. After R4.3.1 or in parallel.

### Wave 3 — After Wave 2
9. **R2.8.20** [Dev4] — ContentLiftPanel fabricated-URL (standalone, can slip in anytime).
10. **R2.7.17** [Dev4] — Ungated readers design decision + fix (complex, last in queue).

---

## Summary

- **9 tasks ready** across R2/R4/R5 (7 agent, 1 operator-gated, 1 operator)
- **R5.1.2 unblocked** — highest-priority action; gates 5 downstream R5 tasks
- **R4.3 cluster** (3 tasks) is fully unblocked and should be attacked as a unit
- **Dev3** should lead with R2.6.1 → R2.1.4 → R4.3.5 (backend-heavy)
- **Dev4** should lead with R4.3.1 → R4.3.4 → R2.8.1 (data + frontend)
- **Operator** should claim R5.1.2 and R5.2.2 immediately
- **R2.7.17** requires a design decision on visibility semantics before implementation
- **R5 critical path** is 6 tasks deep starting from R5.1.2 — operator speed is the bottleneck
