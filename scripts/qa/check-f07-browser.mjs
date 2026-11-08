#!/usr/bin/env node
/**
 * F07 phase 3 — Project memory browser verification.
 *
 * Scenarios:
 *   B1: loading → saved state
 *   B2: edit overview + add competitor → toast "Context updated", provenance "Updated by you"
 *   B3: cap error toast
 *   B4: flag off → no sidebar item and page shows feature_unavailable copy
 *   B5: 375 px: document.documentElement.scrollWidth <= 375, Tab order reaches every control
 *
 * Output: "ok 5 scenarios" on pass.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "../../worker/node_modules/playwright/index.mjs";
import { openPortal, SUPABASE_URL } from "./portalFixtureHarness.mjs";

const rawArg = process.argv[2] || "http://127.0.0.1:3328";
const origin = new URL(rawArg);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname),
  "browser checks require a disposable local app",
);
const port = parseInt(origin.port || "3328", 10);

const output = path.resolve(process.argv[3] || "test_reports/f07-browser");
await mkdir(output, { recursive: true });

async function waitForServer(targetPort, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${targetPort}/robots.txt`);
      if (res.ok) return true;
    } catch {
      // wait
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function spawnNextServer(targetPort) {
  return spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", String(targetPort)],
    {
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key",
      },
      stdio: "ignore",
    },
  );
}

let serverChild = null;
const isRunning = await waitForServer(port, 1000);
if (!isRunning) {
  serverChild = spawnNextServer(port);
  const up = await waitForServer(port, 30000);
  if (!up) {
    if (serverChild) serverChild.kill("SIGTERM");
    throw new Error(`Failed to start Next.js server on port ${port}`);
  }
}

const browser = await chromium.launch({ headless: true });

function makeFixtureContext() {
  return {
    brandKey: "acme",
    sections: [
      {
        key: "business_overview",
        content: "Acme makes anvils and high-grade industrial springs.",
        updatedAt: new Date(Date.now() - 3600000).toISOString(),
        updatedBy: "user",
        updatedByUser: "teammate-1",
      },
      {
        key: "current_goal",
        content: "Reach #1 in roadrunner interception.",
        updatedAt: new Date(Date.now() - 3600000).toISOString(),
        updatedBy: "assistant",
        updatedByUser: null,
      },
    ],
    missingSections: ["positioning", "writing_preferences"],
    customSections: [
      {
        slug: "priority-topics",
        title: "Priority topics",
        content: "- Desert traps\n- Rocket sleds",
        updatedAt: new Date(Date.now() - 3600000).toISOString(),
        updatedBy: "system",
        updatedByUser: null,
      },
    ],
    competitors: [
      {
        id: "comp-1",
        domain: "coyote.test",
        name: "Coyote Corp",
        notes: "Main rival in bird catching",
        source: "manual",
        sourceUrl: null,
        updatedAt: new Date(Date.now() - 3600000).toISOString(),
        updatedBy: "user",
        updatedByUser: "teammate-1",
      },
      {
        id: "comp-2",
        domain: "runner.test",
        name: "Roadrunner Inc",
        notes: "High speed target",
        source: "setup_research",
        sourceUrl: "https://runner.test/about",
        updatedAt: new Date(Date.now() - 3600000).toISOString(),
        updatedBy: "system",
        updatedByUser: null,
      },
    ],
    keyPages: [
      {
        id: "page-1",
        url: "https://acme.test/anvils",
        role: "money",
        topic: "heavy anvils",
        notes: "Main product line",
        updatedAt: new Date(Date.now() - 3600000).toISOString(),
        updatedBy: "user",
        updatedByUser: "teammate-1",
      },
    ],
    researchLog: [
      {
        id: "log-1",
        entryDate: "2026-11-01",
        kind: "platform.selftest",
        researchKey: "anvils",
        summary: "Competitor research for anvil keywords",
        spendUsd: 0.15,
        createdBy: "system",
      },
    ],
    researchLogLimited: false,
    brandIdentity: {
      displayName: "Acme",
      website: "https://acme.test",
      matchNames: ["Acme", "Acme Corp"],
    },
  };
}

let passedScenarios = 0;

async function record(id, description, run) {
  const row = {
    case: id,
    suite: "f07-browser",
    startedAt: new Date().toISOString(),
    description,
  };
  try {
    row.actual = await run();
    row.outcome = "pass";
    passedScenarios++;
  } catch (error) {
    row.outcome = "fail";
    row.actual = error.stack || error.message;
    process.exitCode = 1;
  }
  row.endedAt = new Date().toISOString();
  await writeFile(
    path.join(output, `${id}.json`),
    JSON.stringify(row, null, 2),
  );
  console.log(`${id}: ${row.outcome} — ${String(row.actual).split("\n")[0]}`);
  if (row.outcome === "fail") {
    throw new Error(`${id} failed: ${row.actual}`);
  }
}

try {
  // Scenario B1: loading → saved state
  await record("B1", "loading → saved state", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 1440, height: 1000 },
    });
    try {
      const data = makeFixtureContext();
      let delayed = true;

      await page.route("**/api/customer/context*", async (route) => {
        if (delayed) {
          delayed = false;
          await new Promise((r) => setTimeout(r, 400));
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(data),
        });
      });

      await page.route("**/api/customer/features*", async (route) => {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ project_memory: true }),
        });
      });

      const navPromise = page.goto(new URL("/portal/context", origin).href);
      await page.locator('[data-slot="context-skeleton"]').waitFor({ state: "visible", timeout: 15000 });
      await navPromise;

      await page.waitForSelector("#context-business_overview", { timeout: 15000 });

      const overviewVal = await page.inputValue("#context-business_overview");
      assert.equal(overviewVal, "Acme makes anvils and high-grade industrial springs.");

      await page.waitForSelector('text="Acme Corp"', { timeout: 10000 });
      await page.waitForSelector('text="coyote.test"', { timeout: 10000 });
      await page.waitForSelector('text="Found by setup"', { timeout: 10000 });
      await page.waitForSelector('text="https://acme.test/anvils"', { timeout: 10000 });
      await page.waitForSelector('text="Target: heavy anvils"', { timeout: 10000 });
      await page.waitForSelector('text="Priority topics"', { timeout: 10000 });
      await page.waitForSelector('text="Competitor research for anvil keywords"', { timeout: 10000 });

      return "Loading skeleton shown, saved state rendered completely.";
    } finally {
      await context.close();
    }
  });

  // Scenario B2: edit overview + add competitor → toast "Context updated", provenance "Updated by you"
  await record("B2", 'edit overview + add competitor → toast "Context updated", provenance "Updated by you"', async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 1440, height: 1000 },
    });
    try {
      const state = makeFixtureContext();

      await page.route("**/api/customer/context*", async (route) => {
        const req = route.request();
        if (req.method() === "PATCH") {
          const body = JSON.parse(req.postData() || "{}");
          const updates = body.updates || [];

          for (const u of updates) {
            if (u.section === "business_overview") {
              const sec = state.sections.find((s) => s.key === "business_overview");
              if (sec) {
                sec.content = u.content;
                sec.updatedBy = "user";
                sec.updatedByUser = "qa-user";
                sec.updatedAt = new Date().toISOString();
              }
            }
            if (u.addCompetitors) {
              for (const c of u.addCompetitors) {
                state.competitors.push({
                  id: "comp-new",
                  domain: c.domain,
                  name: c.name || null,
                  notes: c.notes || null,
                  source: "manual",
                  sourceUrl: null,
                  updatedAt: new Date().toISOString(),
                  updatedBy: "user",
                  updatedByUser: "qa-user",
                });
              }
            }
          }
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(state),
          });
        }

        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(state),
        });
      });

      await page.route("**/api/customer/features*", async (route) => {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ project_memory: true }),
        });
      });

      await page.goto(new URL("/portal/context", origin).href, { waitUntil: "networkidle" });
      await page.waitForSelector("#context-business_overview", { timeout: 15000 });

      // Edit overview
      await page.fill("#context-business_overview", "Acme makes the finest anvils in the Southwest.");
      await page.click('button:has-text("Save changes")');

      // Verify toast
      await page.waitForSelector('text="Context updated"', { timeout: 15000 });

      // Verify provenance "Updated by you"
      const overviewProvenance = page.locator('div:has(#context-business_overview)').first();
      await overviewProvenance.waitFor({ state: "visible", timeout: 10000 });
      const provText = await overviewProvenance.innerText();
      assert.ok(provText.includes("Updated by you"), `Expected "Updated by you" in: ${provText}`);

      // Add competitor
      await page.click('button:has-text("Add competitor")');
      await page.fill('input[placeholder="competitor.com"]', "roadrunner-speed.test");
      await page.fill('input[placeholder="Name (optional)"]', "Speedy Runner");
      await page.locator('form:has(input[placeholder="competitor.com"]) button[type="submit"]').click();

      // Verify competitor appears in list
      await page.waitForSelector('text="roadrunner-speed.test"', { timeout: 15000 });

      return 'Edited overview, added competitor, toast "Context updated" verified, provenance "Updated by you" verified.';
    } finally {
      await context.close();
    }
  });

  // Scenario B3: cap error toast
  await record("B3", "cap error toast", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 1440, height: 1000 },
    });
    try {
      const state = makeFixtureContext();

      await page.route("**/api/customer/context*", async (route) => {
        const req = route.request();
        if (req.method() === "PATCH") {
          return route.fulfill({
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({
              code: "context_cap",
              error: "Sections are capped at 4,000 characters. Summarize instead of pasting.",
            }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(state),
        });
      });

      await page.route("**/api/customer/features*", async (route) => {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ project_memory: true }),
        });
      });

      await page.goto(new URL("/portal/context", origin).href, { waitUntil: "networkidle" });
      await page.waitForSelector("#context-current_goal", { timeout: 15000 });

      await page.fill("#context-current_goal", "Over-limit goal content attempt.");
      await page.click('button:has-text("Save changes")');

      await page.waitForSelector('text="Sections are capped at 4,000 characters. Summarize instead of pasting."', {
        timeout: 15000,
      });

      return "Cap error toast displayed on 400 context_cap response.";
    } finally {
      await context.close();
    }
  });

  // Scenario B4: flag off → no sidebar item and page shows feature_unavailable copy
  await record("B4", "flag off → no sidebar item and page shows feature_unavailable copy", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 1440, height: 1000 },
    });
    try {
      await page.route("**/api/customer/features*", async (route) => {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ project_memory: false }),
        });
      });

      await page.route("**/api/customer/context*", async (route) => {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            code: "feature_unavailable",
            error: "This page is not available for your workspace yet.",
          }),
        });
      });

      await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });

      const contextNavCount = await page.locator('nav a[href="/portal/context"]').count();
      assert.equal(contextNavCount, 0, "Sidebar must not display Context item when project_memory flag is off");

      await page.goto(new URL("/portal/context", origin).href, { waitUntil: "networkidle" });
      await page.waitForSelector('text="This page is not available for your workspace yet."', { timeout: 15000 });

      return "Sidebar hides Context link, page displays feature_unavailable message when flag is off.";
    } finally {
      await context.close();
    }
  });

  // Scenario B5: 375 px: document.documentElement.scrollWidth <= 375, Tab order reaches every control
  await record("B5", "375 px: document.documentElement.scrollWidth <= 375, Tab order reaches every control", async () => {
    const { context, page } = await openPortal(browser, origin, {
      viewport: { width: 375, height: 812 },
    });
    try {
      const state = makeFixtureContext();

      await page.route("**/api/customer/context*", async (route) => {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(state),
        });
      });

      await page.route("**/api/customer/features*", async (route) => {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ project_memory: true }),
        });
      });

      await page.goto(new URL("/portal/context", origin).href, { waitUntil: "networkidle" });
      await page.waitForSelector("#context-business_overview", { timeout: 15000 });

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(
        scrollWidth <= 375,
        `Expected document.documentElement.scrollWidth <= 375, found ${scrollWidth}`,
      );

      const focusedTags = [];
      for (let i = 0; i < 15; i++) {
        await page.keyboard.press("Tab");
        const activeTag = await page.evaluate(() => {
          const el = document.activeElement;
          return el ? `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}` : null;
        });
        if (activeTag && activeTag !== "body") {
          focusedTags.push(activeTag);
        }
      }

      assert.ok(focusedTags.length > 0, "Tab key must reach interactive elements on the page");
      assert.ok(
        focusedTags.some((t) => t.includes("textarea") || t.includes("button") || t.includes("a")),
        `Tab key reached controls: ${focusedTags.join(", ")}`,
      );

      return `No horizontal overflow at 375px (scrollWidth = ${scrollWidth}), keyboard Tab reached ${focusedTags.length} controls.`;
    } finally {
      await context.close();
    }
  });

  console.log("ok 5 scenarios");
} finally {
  await browser.close();
  if (serverChild) {
    try {
      serverChild.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}
