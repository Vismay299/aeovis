import test from 'node:test';
import assert from 'node:assert/strict';
import { isPromptRelatedToUrl } from './topics.js';
import { computeContentLiftReport, computeContentLiftReports } from './contentLift.js';

/**
 * R3.2.4 — this file's last case is about the MEMORY fallback, and it has to
 * make that fallback happen instead of hoping for it.
 *
 * `insertContentEvent` and `getContentEvents` take no deps: they use db.js's
 * module-level client, which is built at import time from
 * NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY. So this file used to exercise the
 * memory path only while those were unset. With them set — which is what
 * src/lib/liveDbGate.js tells live-test authors to do — the same case inserted
 * a row into the production `content_events` table, and it did so INVISIBLY:
 * insertContentEvent catches its own error and falls back to memory
 * (db.js:668), so the assertions below passed either way. A green test that
 * writes to production is the exact failure R3.2.4 exists for.
 *
 * Clearing the credentials before db.js is evaluated makes the no-client path
 * a property of this file. The import must be dynamic: a static one is hoisted
 * above these two lines and db.js would capture the credentials first.
 */
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const { getContentEvents, insertContentEvent, supabase } = await import('../db.js');

test('isPromptRelatedToUrl - semantic keyword matching', () => {
  // Positive matching cases
  assert.ok(isPromptRelatedToUrl(
    "What is the best analytics tool for SaaS?",
    "https://acme.com/blog/best-analytics-tool"
  ));
  assert.ok(isPromptRelatedToUrl(
    "How to set up HubSpot CRM integration?",
    "acme.com/hubspot-crm-setup"
  ));
  assert.ok(isPromptRelatedToUrl(
    "comparing monoedge and scaleflow platforms",
    "/monoedge-vs-scaleflow-comparison"
  ));

  // Negative matching cases (no keyword overlap or stopwords only)
  assert.ok(!isPromptRelatedToUrl(
    "Who is the CEO of Acme?",
    "https://acme.com/blog/how-to-setup-analytics"
  ));
  assert.ok(!isPromptRelatedToUrl(
    "What is the best platform?",
    "https://acme.com/blog/how-to-cook-pizza"
  ));
  assert.ok(!isPromptRelatedToUrl(
    "How to code in javascript",
    "https://acme.com" // Domain only
  ));
});

test('computeContentLiftReport - compares current and previous scan scores', () => {
  const event = { url: "https://acme.com/blog/best-analytics-tool" };
  const currentResults = [
    { prompt: "What is the best analytics tool for SaaS?", prompt_score: 8.5 },
    { prompt: "Top analytics platforms compared", prompt_score: 6.0 },
    { prompt: "Who is the CEO of Acme?", prompt_score: 2.0 },
  ];
  const previousResults = [
    { prompt: "What is the best analytics tool for SaaS?", prompt_score: 6.0 },
    { prompt: "Top analytics platforms compared", prompt_score: 5.0 },
  ];

  const report = computeContentLiftReport(event, currentResults, previousResults);

  assert.equal(report.related_prompts.length, 2);
  assert.equal(report.current_score, 7.3);
  assert.equal(report.previous_score, 5.5);
  assert.equal(report.lift, 1.8);
});

test('computeContentLiftReports - returns lift per registered event', () => {
  const events = [
    { id: "1", url: "https://acme.com/blog/best-analytics-tool" },
    { id: "2", url: "https://acme.com/about" },
  ];
  const currentResults = [
    { prompt: "What is the best analytics tool for SaaS?", prompt_score: 8.0 },
  ];

  const reports = computeContentLiftReports(events, currentResults, []);

  assert.equal(reports.length, 2);
  assert.equal(reports[0].lift, null);
  assert.equal(reports[0].related_prompts.length, 1);
  assert.equal(reports[1].related_prompts.length, 0);
});

test('Content Events CRUD - persistence and memory fallback', async () => {
  // The precondition, asserted rather than assumed: without this the case
  // would still pass while writing a row to production's content_events.
  assert.equal(
    supabase,
    null,
    "db.js still has a client, so this case would write content_events for real; " +
      "the credential clearing at the top of this file did not take effect"
  );
  const brand = "LiftTestBrand";
  const url = "https://lifttest.com/blog/aeo-guide";
  const publishDate = new Date().toISOString();

  // 1. Insert content event
  const inserted = await insertContentEvent({ brand, url, publishDate });
  assert.ok(inserted.id);
  assert.equal(inserted.brand, brand);
  assert.equal(inserted.url, url);
  assert.equal(inserted.publish_date, publishDate);

  // 2. Fetch content events for brand
  const events = await getContentEvents(brand);
  assert.ok(events.length > 0);
  assert.equal(events[0].url, url);
  assert.equal(events[0].brand, brand);
});
