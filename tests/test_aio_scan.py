"""AEO / AIO scan pipeline end-to-end backend tests.
Tests POST /api/scan and GET /api/scan/{job_id}/status with real BrightData.
"""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "http://localhost:3000").rstrip("/")

# --- Fixture: run scan once and share across tests ---
@pytest.fixture(scope="module")
def scan_result():
    payload = {
        "brand": "Wrike",
        "url": "wrike.com",
        "industry": "saas",
        "competitors": "Asana, Monday.com, Trello",
    }
    r = requests.post(f"{BASE_URL}/api/scan", json=payload, timeout=30)
    assert r.status_code in (200, 201), f"POST /api/scan failed: {r.status_code} {r.text[:400]}"
    body = r.json()
    job_id = body.get("job_id") or body.get("jobId") or body.get("id")
    assert job_id, f"No job_id in response: {body}"
    print(f"\n[scan] job_id={job_id}")

    # Poll status (5s * 60 = 5 min max)
    status_url = f"{BASE_URL}/api/scan/{job_id}/status"
    record = None
    for attempt in range(60):
        time.sleep(5)
        s = requests.get(status_url, timeout=30)
        if s.status_code != 200:
            print(f"[poll {attempt}] http={s.status_code}")
            continue
        data = s.json()
        status = data.get("status")
        print(f"[poll {attempt}] status={status}")
        if status == "complete":
            record = data.get("run_record") or data.get("runRecord") or data
            break
        if status in ("failed", "error"):
            pytest.fail(f"Scan failed: {data}")
    assert record, "Scan did not complete within timeout"
    return {"job_id": job_id, "record": record, "raw": data}


# --- Basic scan creation & completion ---
class TestScanLifecycle:
    def test_scan_completes(self, scan_result):
        rec = scan_result["record"]
        assert isinstance(rec, dict) and rec, "run_record missing/empty"

    def test_required_top_level_fields(self, scan_result):
        rec = scan_result["record"]
        required = [
            "visibility_pct", "mention_rate_pct", "brand_citation_share_pct",
            "branded_visibility_pct", "aio_coverage_pct", "aio_error_rate_pct",
            "data_source_issue", "scoring_version", "platform",
        ]
        missing = [f for f in required if f not in rec]
        assert not missing, f"Missing top-level fields: {missing}. Keys present: {list(rec.keys())}"
        assert rec["scoring_version"] == "v7-aio-only", f"scoring_version={rec['scoring_version']}"
        assert rec["platform"] == "google_ai_overview", f"platform={rec['platform']}"
        assert isinstance(rec["data_source_issue"], bool)

    def test_results_array_shape(self, scan_result):
        rec = scan_result["record"]
        results = rec.get("results") or []
        assert isinstance(results, list) and len(results) > 0, "results[] empty"
        needed = {
            "prompt", "is_branded_query", "aio_present", "aio_text",
            "aio_citations", "aio_references", "brand_mentioned_in_text",
            "brand_cited", "visible", "competitors_found_in_text", "competitors_cited",
        }
        first = results[0]
        missing = needed - set(first.keys())
        assert not missing, f"Result row missing keys: {missing}. Have: {list(first.keys())}"


# --- Branded vs non-branded queries ---
class TestQueryComposition:
    def test_at_least_one_branded(self, scan_result):
        results = scan_result["record"]["results"]
        branded = [r for r in results if r.get("is_branded_query")]
        assert len(branded) >= 1, "Expected at least 1 branded query"
        for r in branded:
            assert "wrike" in r["prompt"].lower(), f"branded query missing brand word: {r['prompt']}"

    def test_at_least_ten_non_branded(self, scan_result):
        results = scan_result["record"]["results"]
        non_branded = [r for r in results if not r.get("is_branded_query")]
        assert len(non_branded) >= 10, f"Expected >=10 non-branded, got {len(non_branded)}"
        for r in non_branded:
            assert "wrike" not in r["prompt"].lower(), f"non-branded query contains brand: {r['prompt']}"


# --- Parser: AIO text + references ---
class TestParserOutput:
    def test_at_least_one_aio_present_with_text_and_refs(self, scan_result):
        results = scan_result["record"]["results"]
        non_branded = [r for r in results if not r.get("is_branded_query")]
        with_aio = [
            r for r in non_branded
            if r.get("aio_present") and (r.get("aio_text") or "").strip()
            and isinstance(r.get("aio_references"), list) and len(r["aio_references"]) > 0
        ]
        if not with_aio:
            # Report but don't hard-fail if BrightData returned nothing at all
            aio_count = sum(1 for r in non_branded if r.get("aio_present"))
            pytest.fail(
                f"No non-branded row has aio_present=True with non-empty aio_text AND aio_references. "
                f"aio_present=True count={aio_count}. Parser likely broken."
            )
        print(f"[parser] {len(with_aio)} non-branded rows have aio text + references")

    def test_visible_flag_alignment(self, scan_result):
        """For any non-branded row where AIO present AND Wrike appears in text/refs -> visible must be True."""
        results = scan_result["record"]["results"]
        checked = 0
        for r in results:
            if r.get("is_branded_query"):
                continue
            if not r.get("aio_present"):
                continue
            text = (r.get("aio_text") or "").lower()
            refs = r.get("aio_references") or []
            in_text = "wrike" in text
            in_refs = any("wrike.com" in (ref.get("href") or ref.get("url") or "").lower() for ref in refs if isinstance(ref, dict))
            if in_text or in_refs:
                assert r.get("visible") is True, f"visible flag misaligned for prompt={r['prompt']!r}"
                checked += 1
        print(f"[visible] verified alignment on {checked} rows (0 is acceptable — AIOs are stochastic)")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
