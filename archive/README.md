# Local-only work archived before retiring the Desktop checkout

> <!-- doc-status -->
> **Status: HISTORICAL.** Snapshot of files that existed only in local checkouts on 20 October 2026. Kept for reference, not part of the running test suite.

These files were found only in local working copies (the Desktop checkout and the Google Drive `wip-p0` stash) when the project was consolidated onto GitHub `main` at `dfc9b40`:

- `docs/audits/2026-10-15-collection-evidence.json`, `docs/audits/2026-10-15-collection-reliability.md` and `scripts/audit-scan-collection.mjs`: the 15 October collection-reliability investigation.
- `archive/r05-*.test.mjs`: four early R05 test drafts. They are kept under `archive/` so the `src/**/*.test.mjs` suite does not run them; later R05 tests on `main` superseded them.

The raw stashes are also preserved as branches: `archive/stash-wip-p0`, `archive/stash-wip-before-pull` and `archive/stash-wip-before-pull-session2`.
