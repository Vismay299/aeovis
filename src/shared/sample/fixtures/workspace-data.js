/** Questions, context, team, usage, notifications and privacy for the sample workspace. */
import { BRAND, BRAND_KEY, DOMAIN, RIVALS, WEBSITE, daysAgo, dayKey, stable } from "./brand.js";
import { reports } from "./core.js";

function questionTexts() {
  const latest = reports().at(-1);
  const seen = new Map();
  for (const r of latest.results) if (!seen.has(r.query)) seen.set(r.query, r.raw?.topic || "Hospital analytics");
  return [...seen.entries()];
}

export function questionsState() {
  const qs = questionTexts().map(([text, topic], i) => ({
    id: `sq-${i + 1}`, text, topic, origin: i % 5 === 0 ? "prompt_research" : i % 3 === 0 ? "ai_generate" : "manual",
    status: "active", branded: false, cohort: "core", replacedBy: null, duplicateReason: null,
    createdAt: daysAgo(60 - (i % 10)), archivedAt: null,
  }));
  const topics = [...new Set(qs.map((q) => q.topic))].map((name) => ({ name, active: qs.filter((q) => q.topic === name).length, paused: 0 }));
  return {
    brandKey: BRAND_KEY,
    revision: 7,
    settings: { persona: "A hospital administrator shortlisting analytics vendors", country: "in", language: "en", researchKeywords: ["hospital analytics software", "nabh compliance software", "readmission tracking"] },
    questions: qs,
    topics,
    approved: { version: 3, approvedAt: daysAgo(45), questionCount: qs.length, diagnosticCount: 0, carriesQuestionIds: true },
    diff: { approvedVersion: 3, added: 0, removed: 0, contextChanged: false, dirty: false },
    nearDuplicates: [],
    limits: { unarchived: qs.length, maxUnarchived: 100, topics: topics.length, maxTopics: 30 },
    setup: { status: "complete", jobId: null, failure: null },
  };
}

export function repairsPanel() {
  return {
    items: [{
      artifact_key: "default",
      state: "approved",
      version: 3,
      payload: {
        persona: "a hospital administrator shortlisting analytics vendors",
        context: { country: "in", device: "desktop", session_policy: "fresh_anonymous" },
        prompts: questionTexts().map(([text]) => ({ text, origin: "manual", weight: 1, purpose: "recommendation" })),
      },
    }],
  };
}

export function context() {
  const at = (n) => daysAgo(n);
  return {
    brandKey: BRAND_KEY,
    sections: [
      { key: "business_overview", content: `${BRAND} makes clinical analytics software for Indian hospitals: readmission, length-of-stay and NABH quality dashboards that sit on top of the hospital's existing HIMS.`, updatedAt: at(12), updatedBy: "user", updatedByUser: "sample-owner" },
      { key: "positioning", content: "The analytics layer for mid-size private hospitals (100–400 beds) that have outgrown spreadsheet reporting but don't want to replace their HIMS.", updatedAt: at(12), updatedBy: "user", updatedByUser: "sample-owner" },
      { key: "current_goal", content: "Be named in AI answers for NABH reporting and readmission tracking questions, where NorthPeak is named today.", updatedAt: at(4), updatedBy: "assistant", updatedByUser: null },
      { key: "writing_preferences", content: "Plain, clinical, no hype. Cite NABH standards by chapter. Indian English spelling.", updatedAt: at(20), updatedBy: "user", updatedByUser: "sample-owner" },
    ],
    missingSections: [],
    customSections: [
      { slug: "priority-topics", title: "Priority topics", content: "- NABH 5th edition reporting\n- Readmission rate benchmarks\n- Length-of-stay dashboards", updatedAt: at(9), updatedBy: "system", updatedByUser: null },
    ],
    competitors: RIVALS.map((r, i) => ({
      id: `sc-${i + 1}`, domain: r.domain, name: r.name,
      notes: ["Large suite; named most often", "AI-first analytics, strong on ChatGPT", "Popular with multi-site chains", "Budget option for clinics"][i],
      source: i < 2 ? "manual" : "setup_research", sourceUrl: i < 2 ? null : `https://${r.domain}/about`,
      updatedAt: at(30 + i), updatedBy: i < 2 ? "user" : "system", updatedByUser: i < 2 ? "sample-owner" : null,
    })),
    keyPages: [
      { id: "kp-1", url: `${WEBSITE}/platform`, role: "money", topic: "hospital analytics platform", notes: "Main product page", updatedAt: at(15), updatedBy: "user", updatedByUser: "sample-owner" },
      { id: "kp-2", url: `${WEBSITE}/nabh-reporting`, role: "money", topic: "NABH reporting software", notes: "Accreditation use case", updatedAt: at(15), updatedBy: "user", updatedByUser: "sample-owner" },
      { id: "kp-3", url: `${WEBSITE}/blog/readmission-benchmarks-india`, role: "content", topic: "readmission benchmarks", notes: "Most-cited article", updatedAt: at(8), updatedBy: "assistant", updatedByUser: null },
    ],
    researchLog: [
      { id: "rl-1", entryDate: dayKey(9), kind: "keywords.research", researchKey: "nabh software", summary: "Keyword research for NABH reporting terms", spendUsd: 0.12, createdBy: "system" },
      { id: "rl-2", entryDate: dayKey(21), kind: "domain.overview", researchKey: "northpeak.com", summary: "Competitor domain overview: NorthPeak", spendUsd: 0.08, createdBy: "system" },
    ],
    researchLogLimited: false,
    brandIdentity: { displayName: BRAND, website: WEBSITE, matchNames: [BRAND, "Brightwave Health", DOMAIN] },
  };
}

export function team() {
  return {
    members: [
      { user_id: "sample-owner", email: "priya@brightwave.io", role: "owner", brand_key: BRAND_KEY },
      { user_id: "sample-member-1", email: "arjun@brightwave.io", role: "member", brand_key: BRAND_KEY },
      { user_id: "sample-member-2", email: "meera@brightwave.io", role: "member", brand_key: BRAND_KEY },
    ],
    invites: [{ email: "content@brightwave.io", role: "member", brand_key: BRAND_KEY, created_at: daysAgo(2), expires_at: daysAgo(-5) }],
  };
}

export function usage(url) {
  const range = url.searchParams.get("range") || "30d";
  const count = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  const days = Array.from({ length: count }, (_, i) => {
    const n = count - 1 - i;
    const scanDay = n % 7 === 1;
    const usd = scanDay ? 3.4 + stable(`u${n}`) * 0.6 : 0.1 + stable(`d${n}`) * 0.4;
    return { date: dayKey(n), usd: Math.round(usd * 100) / 100, knownUsd: Math.round(usd * 100) / 100, unknownUsd: 0 };
  });
  const total = Math.round(days.reduce((s, d) => s + d.usd, 0) * 100) / 100;
  const scans = Math.round(total * 0.72 * 100) / 100;
  const research = Math.round(total * 0.18 * 100) / 100;
  const content = Math.round((total - scans - research) * 100) / 100;
  return {
    range, timeZone: "Asia/Kolkata", from: daysAgo(count - 1, 0), to: daysAgo(0, 23),
    totals: { accountedUsd: total, knownUsd: total, unknownUsd: 0, calls: 640 * (count / 30) | 0, unknownCalls: 0 },
    days,
    features: [
      { feature: "ai_visibility.scan", label: "AI visibility scans", usd: scans, unknownUsd: 0, calls: 480 * (count / 30) | 0 },
      { feature: "keywords.research", label: "Keyword and domain research", usd: research, unknownUsd: 0, calls: 90 * (count / 30) | 0 },
      { feature: "content.generate", label: "Content drafts", usd: content, unknownUsd: 0, calls: 70 * (count / 30) | 0 },
    ],
    recent: [
      { occurredAt: daysAgo(1, 9, 4), feature: "ai_visibility.scan", label: "AI visibility scans", provider: "openrouter", endpoint: "probe:chatgpt", usd: 0.0612, costSource: "provider_reported", notBilled: false },
      { occurredAt: daysAgo(1, 9, 3), feature: "ai_visibility.scan", label: "AI visibility scans", provider: "dataforseo", endpoint: "serp:google", usd: 0.002, costSource: "price_table", notBilled: false },
      { occurredAt: daysAgo(2, 15, 20), feature: "content.generate", label: "Content drafts", provider: "openrouter", endpoint: "content:writer", usd: 0.18, costSource: "provider_reported", notBilled: false },
      { occurredAt: daysAgo(3, 11, 0), feature: "keywords.research", label: "Keyword and domain research", provider: "dataforseo", endpoint: "keywords:ideas", usd: 0.05, costSource: "price_table", notBilled: false },
    ],
    position: {
      todayUsd: days.at(-1).usd, monthUsd: total, dailyCapUsd: 10, monthlyCapUsd: 50, openHoldsUsd: 0, openHolds: 0,
      dayStartsAt: `${dayKey(0)}T00:00:00.000Z`, monthStartsAt: `${dayKey(0).slice(0, 8)}01T00:00:00.000Z`,
    },
    generatedAt: new Date().toISOString(),
  };
}

export const emailPreferences = () => ({ productUpdates: true, scanResults: true, scheduleAlerts: true, spendAlerts: true, productUpdatesChangedAt: daysAgo(40), loopsConfigured: true });
export const privacy = () => ({ analytics: false, decidedAt: daysAgo(30), source: "settings", policyVersion: "2026-11-08", telemetryAvailable: true });
export const measurement = () => ({ observations: [], windows: [] });
export const repairsList = () => ({ items: [] });
export { DOMAIN };
