/**
 * The documents behind the sample workspace's two reports (src/shared/sample).
 * Fictional Brightwave data, built from the same generated scan reports the
 * sample portal shows, so the figures agree. Served by /r/[reportId] only for
 * the sample report ids; every other id takes the normal, authenticated path.
 */
import REPORTS from "../../shared/sample/fixtures/data/scans.json" with { type: "json" };
import { SAMPLE_REPORT_IDS } from "../../shared/sample/fixtures/reports.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function isSampleReportId(id) {
  return Object.values(SAMPLE_REPORT_IDS).includes(id);
}

export function sampleReportHtml(id) {
  const latest = REPORTS.at(-1).scan;
  const first = REPORTS[0].scan;
  const monthly = id === SAMPLE_REPORT_IDS.monthly;
  const pct = (v) => (v == null ? "—" : `${Math.round(v)}%`);
  const engines = Object.entries(latest.engines || {}).map(([k, v]) => [{ aio: "Google AI Overview", chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity" }[k] || k, v?.visibility_pct ?? v?.share_of_ai_pct]);
  const title = monthly ? "Brightwave — monthly check-in" : "Brightwave — AI visibility audit";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#0a0a0b;--ink:#f5f5f5;--dim:#a1a1aa;--line:#26262b;--card:#121214}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:780px;margin:0 auto;padding:48px 24px 64px}
.tag{font:500 11px/1 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
h1{font-weight:300;font-size:40px;line-height:1.05;letter-spacing:-.03em;margin:10px 0 6px}
h2{font-weight:500;font-size:18px;margin:36px 0 10px}
.note{border:1px solid var(--line);border-radius:12px;padding:10px 14px;color:var(--dim);font-size:13px;margin:18px 0}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.big{font-weight:300;font-size:34px;letter-spacing:-.04em}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:8px 0;border-bottom:1px solid var(--line)}th{color:var(--dim);font-weight:500}
li{margin:6px 0}
</style></head><body><main>
<p class="tag">${monthly ? "Monthly leadership update" : "AI Visibility Audit"} · Sample</p>
<h1>${esc(title)}</h1>
<p class="note">Sample report. Brightwave and its rivals are fictional and every number is invented to show what Perceev produces.</p>
<div class="grid">
<div class="card"><div class="tag">AI visibility</div><div class="big">${pct(latest.visibility_pct)}</div><div style="color:var(--dim);font-size:13px">from ${pct(first.visibility_pct)} six weeks ago</div></div>
<div class="card"><div class="tag">Questions naming you</div><div class="big">${latest.prompts_mentioned}/${latest.prompts_tracked}</div></div>
<div class="card"><div class="tag">Leading rival</div><div class="big">NorthPeak</div></div>
</div>
<h2>By engine</h2>
<table><tr><th>Engine</th><th>Answers naming Brightwave</th></tr>${engines.map(([n, v]) => `<tr><td>${esc(n)}</td><td>${pct(v)}</td></tr>`).join("")}</table>
<h2>${monthly ? "What changed this month" : "Where rivals win"}</h2>
<ul>
<li>NABH reporting questions still go to NorthPeak; answers cite its accreditation guide and nabh.co.</li>
<li>The readmission benchmarks article is now cited by Perplexity and Gemini.</li>
<li>"Best software for a 200-bed hospital" answers list suites; Brightwave is missing because no page says which hospital sizes it fits.</li>
</ul>
<h2>Next steps</h2>
<ol>
<li>Publish the NABH quality indicators guide (draft is in Content Studio).</li>
<li>Add a "who it's for" section to /platform naming 100–400 bed hospitals.</li>
<li>Re-scan after both are live and compare.</li>
</ol>
</main></body></html>`;
}
