import test from 'node:test';
import assert from 'node:assert/strict';
import { isPromptRelatedToUrl } from './topics.js';
import { computeContentLiftReport, computeContentLiftReports } from './contentLift.js';
import { getContentEvents, insertContentEvent } from '../db.js';

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
