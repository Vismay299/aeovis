# P0 provider dispatch operations

> <!-- doc-status -->
> **Status: LIVE.** Implementation runbook. Production application and live provider qualification are unverified.

Updated 19 October 2026. Migration: `027_durable_probe_dispatch.sql`.

The production scan worker now uses PostgreSQL to authorize each logical
prompt/surface observation. It stores dispatch intent before the network call,
then atomically commits the attempt and the `prompt_results` projection. The
frozen panel and requested surfaces remain the denominator when dispatch stops.
Provider requests are serial within each chunk so a permanent failure can stop
the next dependent request; independent workers coordinate through SQL.

## Offered configuration

| Surface | Adapter selection | Credential variables | Circuit scope |
|---|---|---|---|
| Google AIO | Bright Data SERP | `BRIGHTDATA_API_KEY`; optional selected zone | Bright Data credential identity |
| ChatGPT | Native OpenAI when its key exists; otherwise OpenRouter | `OPENAI_API_KEY` or canonical `LLM_API_KEY` (legacy alias supported by registry) | Selected provider + effective credential identity |
| Perplexity | Native answer/search legs when its key exists; otherwise OpenRouter Sonar | `PERPLEXITY_API_KEY` or `LLM_API_KEY` | Selected provider + effective credential identity |
| Gemini | OpenRouter scan adapter | `LLM_API_KEY` | Shared gateway credential identity |

The standalone native Gemini utility is not the offered scan adapter. Model
selection uses existing `OPENROUTER_*_MODEL`/native model settings. Fingerprints
and configuration versions contain hashes, never credential values. Rotating a
key invalidates old readiness and gives the new account its own circuit.
Deployment environment and actual model/location qualification need QA/live
evidence; this table describes selection in code.

## Limits, recovery and uncertainty

- `SCAN_PROBE_RESERVATION_USD` is a positive estimate reserved **per attempt**,
  default USD 1. Configure it conservatively for the selected model/tools.
  `SCAN_MAX_COST_PER_SCAN` and `SCAN_MAX_COST_PER_DAY` optionally cap authorized
  measured charges plus outstanding reservations. Zero refuses new dispatch;
  malformed values fail before dispatch. Atomic reservations cannot race past
  the ceiling. They are estimates, **not a guaranteed provider invoice ceiling**;
  actual charges can exceed an estimate. Missing charge data keeps its
  reservation and `unknown_billed` state rather than becoming free.
- Adapter retries are disabled on the durable path. Native Perplexity still
  makes two separately bounded legs per observation. A canary reserves two
  request units for native Perplexity and Google (zone lookup plus SERP), one
  for each single gateway/native answer. Request units are conservative ceilings.
- Maximum three durable attempts per observation, versioned seeded backoff,
  observed Retry-After and a frozen 24-hour observation deadline. Answers and
  validated no-AIO SERPs are terminal. Deferred work resumes through poll/cron;
  future retry times do not trigger immediate self-continuation loops.
- Each attempt has a 120-second fenced lease and a 70-second request envelope.
  Body reads remain under the adapter abort deadline. No offered adapter claims
  provider idempotency. An expired intent is **ambiguous**, retains its spend
  reservation and cannot automatically dispatch again. Late receipts are
  retained separately and cannot replace a current result.
- Authentication/permission failures: repair the selected route or credential.
  Spend-limit failures: review the account limit/funding manually. Temporary
  throttling: wait for the observed reset. Challenge: inspect access state.
  Provider capacity: inspect cookies/session/zone capacity. Parse failure:
  inspect sanitized parser/evidence identity and update fixtures; never invent
  a Google answer or silently change location.
- Permanent account faults open a shared circuit for 15 minutes. Ordinary
  questions cannot close it. After cooldown a single canary can hold recovery;
  other contenders are refused. An independent Google account still proceeds.

## Readiness and explicit canaries

`/api/health` reads stored canary metadata and dispatches zero provider requests.
It reports configured/unverified/ready/degraded/blocked/stale separately. A
valid canary expires after one hour. Read failures degrade health instead of
pretending history is empty. Public output excludes queries and raw captures.

Run canaries deliberately with a server-only QA environment and an agreed
budget. Example syntax below is **not evidence of a live run**:

```sh
node scripts/ops/provider-canary.mjs --engines chatgpt,gemini,perplexity,aio \
  --slot qa-YYYY-MM-DD-HH --max-requests 6 --max-spend-usd 4 --reserve-usd 1
```

Use the same slot across concurrent dispatchers. Its SQL budget is immutable:
changing ceilings on another dispatcher is refused. Repeated successful slots
make no further requests. Retryable failed canaries retain their due time and
attempt limit; a new slot represents a deliberate new check. No script changes
credentials, provider funding, accounts or production configuration.

## Rollout and rollback

1. Pause existing scan dispatchers, including old deployments and fleet
   continuations. Apply 027 through the migration runner to an isolated QA DB.
   Run `PGHOST=127.0.0.1 PGDATABASE=perceev_qa node scripts/qa/check-probe-dispatch.mjs`
   after the full migrations. The check refuses non-loopback or non-QA identities.
2. Inspect legacy adoption: surviving valid rows stay terminal; failed rows are
   historical attempts and only typed retryable work can resume. Verify
   prompt/result counts and sourcing costs before enabling an owned workspace.
3. Deploy compatible readers and the worker, then run bounded QA canaries and
   full/partial/all-error scans. Save actual request IDs, receipts and browser
   evidence. Production and live qualification remain open until this happens.
4. To stop new dispatch, set `probe_dispatch_control.paused=true` as an operator.
   Claims fail before network calls; existing leased attempts may finish and
   retain evidence. Keep schema and readers installed.
5. Before running an old worker during rollback, stop **all** old and new
   dispatchers, drain live leases and reconcile uncertainty. An old worker does
   not understand the new SQL pause; deploying it alone is not a safe rollback.
   Do not drop the ledger or rewrite historical reports.

For an ambiguous call, inspect the provider's actual request ledger and late
receipts. Only if evidence proves no accepted dispatch may the operator call
`reconcile_probe_dispatch(id, token, 'confirm_not_dispatched', evidence_note)`.
That releases its unknown reservation and permits a new fenced attempt. If the
call cannot be resolved, use `close_failed`; unknown spend remains unknown.
Both require an explicit evidence note and append a reconciliation record.
Never use this action to infer exactly-once billing from a missing response.

The database job kills a child after committed intent and fences late owners.
The provider return in that test is synthetic; it does not verify a vendor's
idempotency or billing. Live rollout/rollback and the required browser checks
remain separate acceptance work.
