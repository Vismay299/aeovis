#!/usr/bin/env node
/**
 * F04 phase 4 — the portal's browser contracts.
 *
 * Drives the real customer app against the fixture harness: the shell, the
 * registry sidebar, the workspace switcher, the theme picker and the
 * `notranslate` marker. No database, no credential, no third party.
 *
 * Every case ends with `blockedWrites` at zero: the harness ABORTS any
 * non-GET to a customer route, so a case that tried to change something would
 * fail rather than quietly succeed.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "../../worker/node_modules/playwright/index.mjs";
import { openAuth, openPortal, readFixture } from "./portalFixtureHarness.mjs";

const origin = new URL(process.argv[2] || "http://127.0.0.1:3328");
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname),
  "browser checks require a disposable local app"
);
const output = path.resolve(process.argv[3] || "test_reports/f04-browser");
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });

/** One recorded case, written to its own file whether it passes or fails. */
async function record(id, expected, run) {
  const row = {
    case: id,
    suite: "f04-browser",
    startedAt: new Date().toISOString(),
    expected,
    artifacts: [],
  };
  try {
    row.actual = await run(row.artifacts);
    row.outcome = "pass";
  } catch (error) {
    row.outcome = "fail";
    row.actual = error.stack || error.message;
    process.exitCode = 1;
  }
  row.endedAt = new Date().toISOString();
  const log = `${id}.json`;
  await writeFile(path.join(output, log), JSON.stringify({ ...row, artifacts: undefined }, null, 2));
  row.artifacts.push(log);
  console.log(`${id}: ${row.outcome} — ${String(row.actual).split("\n")[0]}`);
}

/** The visible sidebar, at whichever width the case is running. */
function visibleSidebars(page) {
  return page.locator('[data-slot="sidebar"]:visible');
}

/** The navigation links the sidebar shows. */
async function navHrefs(page) {
  return page
    .locator('nav[aria-label="Main navigation"] a')
    .evaluateAll((links) => links.map((a) => a.getAttribute("href")));
}

try {
  await record(
    "F04-B01",
    "The desktop shell shows a 15 rem sidebar with the registry's groups and items, and the active row carries aria-current.",
    async () => {
      const { context, page, blockedWrites } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });

        const sidebar = visibleSidebars(page).first();
        assert.ok(await sidebar.isVisible(), "the sidebar is visible at 1440");
        const box = await sidebar.boundingBox();
        assert.ok(Math.abs(box.width - 240) <= 1, `the sidebar is ${box.width}px wide, not 240`);

        const groups = await page
          .locator('[data-sidebar="group-label"]')
          .evaluateAll((labels) => labels.map((label) => label.textContent?.trim()));
        for (const group of ["AI Visibility", "My Site", "Content", "Settings"]) {
          assert.ok(groups.includes(group), `the ${group} group is missing: ${JSON.stringify(groups)}`);
        }

        const hrefs = await navHrefs(page);
        for (const href of [
          "/portal",
          "/portal/measurement",
          "/portal/scans",
          "/portal/search-console",
          "/portal/content",
          "/portal/team",
          "/portal/settings",
        ]) {
          assert.ok(hrefs.includes(href), `the ${href} item is missing: ${JSON.stringify(hrefs)}`);
        }

        const current = await page
          .locator('nav[aria-label="Main navigation"] a[aria-current="page"]')
          .getAttribute("href");
        assert.equal(current, "/portal", "Overview is the active row on /portal");

        // A live badge belongs INSIDE its row. shadcn positions it with
        // `peer-data-[size=…]/menu-button`, which only reaches a later
        // SIBLING of the button that carries the `peer` class — so a badge
        // rendered beside the link falls to its static position and floats
        // in the gap below the row.
        const badge = page.locator('[data-slot="sidebar-menu-badge"]').first();
        assert.ok((await badge.count()) > 0, "the Search Console row shows its connection dot");
        const badgeBox = await badge.boundingBox();
        const rowBox = await page
          .locator('nav[aria-label="Main navigation"] a[href="/portal/search-console"]')
          .boundingBox();
        assert.ok(badgeBox && rowBox, "the badge and its row are both laid out");
        assert.ok(
          badgeBox.y >= rowBox.y && badgeBox.y + badgeBox.height <= rowBox.y + rowBox.height,
          `the badge sits outside its row: badge ${JSON.stringify(badgeBox)} row ${JSON.stringify(rowBox)}`
        );

        await page.goto(new URL("/portal/scans", origin).href, { waitUntil: "networkidle" });
        const scansCurrent = await page
          .locator('nav[aria-label="Main navigation"] a[aria-current="page"]')
          .getAttribute("href");
        assert.equal(scansCurrent, "/portal/scans", "Scans is the active row on /portal/scans");

        assert.deepEqual(blockedWrites, [], "the shell wrote to a customer route");
        return `Sidebar 240px wide, groups ${groups.join(", ")} and ${hrefs.length} items; the active row follows the path.`;
      } finally {
        await context.close();
      }
    }
  );

  await record(
    "F04-B02",
    "Below 768 px the sidebar is a drawer: the top bar opens it, Escape closes it, and Cmd/Ctrl+B toggles it.",
    async () => {
      const { context, page, blockedWrites } = await openPortal(browser, origin, {
        viewport: { width: 390, height: 844 },
      });
      try {
        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });

        assert.equal(
          await page.locator('[data-slot="sidebar-container"]:visible').count(),
          0,
          "the desktop sidebar is hidden at 390"
        );
        const trigger = page.locator('button[aria-label="Toggle sidebar"]');
        assert.ok(await trigger.isVisible(), "the top bar trigger is visible at 390");

        await trigger.click();
        await page.waitForTimeout(300);
        assert.equal(await visibleSidebars(page).count(), 1, "the drawer opened");

        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        assert.equal(await visibleSidebars(page).count(), 0, "Escape closed the drawer");

        // The handler accepts either modifier; Control is the one every
        // platform's browser sends for this shortcut.
        await page.keyboard.press("Control+b");
        await page.waitForTimeout(300);
        assert.equal(await visibleSidebars(page).count(), 1, "Control+B opened the drawer");

        await page.keyboard.press("Control+b");
        await page.waitForTimeout(300);
        assert.equal(await visibleSidebars(page).count(), 0, "Control+B closed the drawer");

        assert.deepEqual(blockedWrites, [], "the shell wrote to a customer route");
        return "The drawer opens from the top bar, closes on Escape, and toggles on Control+B.";
      } finally {
        await context.close();
      }
    }
  );

  await record(
    "F04-B03",
    "One scheme: no theme picker in the account menu, the Onyx scheme is painted from the first frame, and the public site is not an app surface.",
    async () => {
      const { context, page, blockedWrites } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        // Read the attributes at DOMContentLoaded, before the app's own
        // scripts could touch them: that is what a reader sees first.
        await page.addInitScript(() => {
          document.addEventListener("DOMContentLoaded", () => {
            window.__paletteAtFirstPaint = document.documentElement.getAttribute("data-palette");
          });
        });
        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });

        // The app has one scheme (Onyx / White, src/styles/palettes.css); the
        // System / Light / Dark picker was removed because it changed nothing.
        await page.locator('button[aria-label="Open account menu"]').click();
        await page.locator('[role="menu"]').waitFor();
        assert.equal(
          await page.locator('[role="menuitemradio"]').count(),
          0,
          "the account menu offers no theme picker"
        );
        await page.keyboard.press("Escape");

        assert.equal(
          await page.evaluate(() => window.__paletteAtFirstPaint),
          "onyx",
          "the Onyx scheme was set before the first paint"
        );
        assert.equal(
          await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
          "dark",
          "the app renders as a dark scheme"
        );

        await page.goto(new URL("/", origin).href, { waitUntil: "networkidle" });
        assert.equal(
          await page.evaluate(() => document.documentElement.getAttribute("data-surface")),
          null,
          "the public site is not an app surface"
        );

        assert.deepEqual(blockedWrites, [], "the shell wrote to a customer route");
        return "No theme picker, Onyx painted from the first frame, and the public site is not an app surface.";
      } finally {
        await context.close();
      }
    }
  );

  await record(
    "F04-B04",
    "Switching workspace from a scan report lands on the scans list of the new workspace, and the choice is remembered.",
    async () => {
      const { context, page, blockedWrites } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        await page.goto(new URL("/portal/scans/scan-1", origin).href, { waitUntil: "networkidle" });

        await page.locator('[aria-label="Switch workspace"]').click();
        await page.locator('[data-slot="combobox-item"]:has-text("Beta")').click();
        await page.waitForURL(new URL("/portal/scans", origin).href, { timeout: 15000 });
        await page.waitForTimeout(400);

        assert.equal(
          new URL(page.url()).pathname,
          "/portal/scans",
          "the switch landed on the scans list, not on the other workspace's scan"
        );
        const switcher = await page.locator('[aria-label="Switch workspace"]').innerText();
        assert.ok(switcher.includes("Beta"), `the switcher shows the new workspace: ${switcher}`);
        assert.equal(
          await page.evaluate(() => window.localStorage.getItem("perceev-portal-brand")),
          "beta",
          "the new workspace is remembered"
        );

        assert.deepEqual(blockedWrites, [], "the shell wrote to a customer route");
        return "The switch landed on /portal/scans, the header shows Beta, and the choice is remembered.";
      } finally {
        await context.close();
      }
    }
  );

  await record(
    "F04-B05",
    "The feature flags are read once per workspace.",
    async () => {
      const { context, page, blockedWrites, featureRequests } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
        assert.deepEqual(
          featureRequests,
          ["acme"],
          `the flags were read ${featureRequests.length} times for the first workspace`
        );
        const acmeHrefs = await navHrefs(page);

        // A client-side navigation must NOT read the flags again: the effect
        // that loads the workspace's data is keyed by the workspace, not by
        // the path.
        await page.locator('nav[aria-label="Main navigation"] a[href="/portal/scans"]').click();
        await page.waitForURL(new URL("/portal/scans", origin).href, { timeout: 15000 });
        await page.waitForTimeout(400);
        assert.deepEqual(
          featureRequests,
          ["acme"],
          `a navigation read the flags again: ${JSON.stringify(featureRequests)}`
        );

        await page.locator('[aria-label="Switch workspace"]').click();
        await page.locator('[data-slot="combobox-item"]:has-text("Beta")').click();
        // Switching from the Overview keeps the Overview, so the switch is
        // observed through the switcher rather than through the URL.
        await page.waitForFunction(
          () =>
            document
              .querySelector('[aria-label="Switch workspace"]')
              ?.textContent?.includes("Beta") === true,
          undefined,
          { timeout: 15000 }
        );
        await page.waitForTimeout(600);

        assert.deepEqual(
          featureRequests,
          ["acme", "beta"],
          `the flags were read ${featureRequests.length} times across two workspaces`
        );

        // F04 registers no FLAGGED item, so no item may appear or disappear
        // because of a flag. The reader is an owner of Acme and a member of
        // Beta, so the owner-only Team item is the one difference the sidebar
        // may show — and B06 covers that rule on its own.
        const betaHrefs = await navHrefs(page);
        const difference = acmeHrefs.filter((href) => !betaHrefs.includes(href));
        assert.deepEqual(
          difference,
          ["/portal/team"],
          `only the owner-only item may differ: ${JSON.stringify(difference)}`
        );
        assert.ok(
          betaHrefs.includes("/portal/settings"),
          "the member still sees the workspace settings"
        );

        assert.deepEqual(blockedWrites, [], "the shell wrote to a customer route");
        return "Exactly one flag read per workspace, and no item changed because of a flag.";
      } finally {
        await context.close();
      }
    }
  );

  await record(
    "F04-B06",
    "A member does not see the owner-only Team item.",
    async () => {
      const memberships = await readFixture("memberships.json");
      const memberMemberships = (memberships ?? []).filter((row) => row.role === "member");
      assert.ok(memberMemberships.length > 0, "the fixture has a member workspace");

      const { context, page, blockedWrites } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
        fixtures: { memberships: memberMemberships },
      });
      try {
        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
        const hrefs = await navHrefs(page);
        assert.ok(!hrefs.includes("/portal/team"), `a member sees the Team item: ${JSON.stringify(hrefs)}`);
        assert.ok(hrefs.includes("/portal/settings"), "a member still sees the workspace settings");
        assert.deepEqual(blockedWrites, [], "the shell wrote to a customer route");
        return `A member sees ${hrefs.length} items and none of them is Team.`;
      } finally {
        await context.close();
      }
    }
  );

  await record(
    "F04-B07",
    "Every app route F04 migrates (/portal, /portal/scans, /portal/scans/scan-1, /portal/measurement, /portal/content, /portal/search-console, /portal/team, /portal/settings, /onboarding and the signed-out auth pages) carries exactly one h1, no horizontal scroll at 390px, and no legacy pv-app, pv-sidebar, pv-page-header or pv-auth classes.",
    async (artifacts) => {
      const workspaceRoutes = [
        "/portal",
        "/portal/scans",
        "/portal/scans/scan-1",
        "/portal/measurement",
        "/portal/content",
        "/portal/search-console",
        "/portal/team",
        "/portal/settings",
      ];
      const authRoutes = [
        "/login",
        "/signup",
        "/auth/forgot",
        "/auth/verify",
        "/auth/error",
        "/auth/reset",
        "/auth/accept",
      ];
      const viewports = [
        { width: 1440, height: 1000, name: "1440" },
        { width: 390, height: 844, name: "390" },
      ];
      const legacySelector = ".pv-app, .pv-sidebar, .pv-page-header, .pv-auth";

      async function checkRoute(page, route, vp) {
        await page.goto(new URL(route, origin).href, { waitUntil: "networkidle" });

        const h1Count = await page.locator("h1").count();
        assert.equal(
          h1Count,
          1,
          `${route} at ${vp.name} must have exactly one h1, found ${h1Count}`
        );

        if (vp.width === 390) {
          const overflow = await page.evaluate(() => {
            const doc = document.documentElement;
            return {
              scrollWidth: doc.scrollWidth,
              innerWidth: window.innerWidth,
            };
          });
          assert.ok(
            overflow.scrollWidth <= overflow.innerWidth + 1,
            `${route} at 390 horizontally overflows: scrollWidth ${overflow.scrollWidth} > innerWidth ${overflow.innerWidth} + 1`
          );
        }

        const legacyCount = await page.locator(legacySelector).count();
        assert.equal(
          legacyCount,
          0,
          `${route} at ${vp.name} still contains legacy classes (${legacySelector}): found ${legacyCount}`
        );

        const safeName = route.replace(/\//g, "-").replace(/^-/, "");
        const shotName = `f04-p6-${safeName}-${vp.name}.png`;
        await page.screenshot({ path: path.join(output, shotName), fullPage: true });
        artifacts.push(shotName);
      }

      for (const vp of viewports) {
        // The workspace pages and onboarding need a session.
        const portal = await openPortal(browser, origin, {
          viewport: { width: vp.width, height: vp.height },
        });
        try {
          for (const route of workspaceRoutes) {
            await checkRoute(portal.page, route, vp);
          }

          // The onboarding fixture answers `has_workspace: false`, so the
          // legacy form (the F27 wizard is off in a production build) renders.
          await checkRoute(portal.page, "/onboarding", vp);
          assert.equal(
            await portal.page.locator("#brand-name").count(),
            1,
            `/onboarding at ${vp.name} must render the legacy workspace form`
          );
          assert.deepEqual(portal.blockedWrites, [], "the workspace pass wrote to a customer route");
        } finally {
          await portal.context.close();
        }

        // The signed-out auth pages: a session read of 401 keeps them on screen.
        const auth = await openAuth(browser, origin, {
          viewport: { width: vp.width, height: vp.height },
        });
        try {
          for (const route of authRoutes) {
            await checkRoute(auth.page, route, vp);
          }
          assert.deepEqual(auth.blockedWrites, [], "the auth pass wrote to a customer route");
        } finally {
          await auth.context.close();
        }
      }
      return `All ${workspaceRoutes.length} workspace routes, /onboarding and ${authRoutes.length} signed-out auth routes verified at 1440 and 390 (one h1, no overflow, no legacy layout classes).`;
    }
  );

  await record(
    "F04-B09",
    "At 390 px an input on /login computes to 16 px; a reveal-on-hover action on /portal/scans is opacity 0 until its row is hovered and 1 after; body text is the system stack on /portal and Archivo on the public site.",
    async () => {
      const compact = await openAuth(browser, origin, {
        viewport: { width: 390, height: 844 },
      });
      try {
        await compact.page.goto(new URL("/login", origin).href, { waitUntil: "networkidle" });
        const email = compact.page.locator("input#email");
        await email.waitFor({ state: "visible", timeout: 15000 });
        const inputFontSize = await email.evaluate((element) => getComputedStyle(element).fontSize);
        assert.equal(inputFontSize, "16px", `/login's input computes ${inputFontSize}, not 16px`);

        await compact.page.goto(new URL("/", origin).href, { waitUntil: "networkidle" });
        const publicFont = await compact.page.evaluate(
          () => getComputedStyle(document.body).fontFamily
        );
        assert.ok(
          publicFont.startsWith("Archivo"),
          `the public body font starts with ${JSON.stringify(publicFont)}, not Archivo`
        );
        assert.deepEqual(compact.blockedWrites, [], "the auth pass wrote to a customer route");
      } finally {
        await compact.context.close();
      }

      const portal = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        await portal.page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
        const appFont = await portal.page.evaluate(
          () => getComputedStyle(document.body).fontFamily
        );
        assert.ok(
          appFont.startsWith("ui-sans-serif"),
          `the app body font starts with ${JSON.stringify(appFont)}, not ui-sans-serif`
        );

        await portal.page.goto(new URL("/portal/scans", origin).href, { waitUntil: "networkidle" });
        const action = portal.page.locator('button[aria-label="Open report"]').first();
        await action.waitFor({ state: "attached", timeout: 20000 });
        const hidden = await action.evaluate((element) => getComputedStyle(element).opacity);
        assert.equal(hidden, "0", `the reveal action starts at opacity ${hidden}, not 0`);

        const row = portal.page.locator('tr:has(button[aria-label="Open report"])').first();
        await row.hover();
        await portal.page.waitForTimeout(400);
        const revealed = await action.evaluate((element) => getComputedStyle(element).opacity);
        assert.equal(revealed, "1", `the reveal action is opacity ${revealed} after hovering its row, not 1`);

        assert.deepEqual(portal.blockedWrites, [], "the shell wrote to a customer route");
        return "The login input is 16px at 390; the app font is the system stack and the public font is Archivo; the row action reveals on hover.";
      } finally {
        await portal.context.close();
      }
    }
  );

  await record(
    "F04-B08",
    "App routes carry the notranslate marker and the app root is notranslatable; the public site is not.",
    async () => {
      const { context, page, blockedWrites } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        await page.goto(new URL("/portal", origin).href, { waitUntil: "networkidle" });
        assert.equal(
          await page.locator('meta[name="google"][content="notranslate"]').count(),
          1,
          "/portal carries the notranslate marker"
        );
        const translate = await page
          .locator("#app-content")
          .evaluate((element) => element.closest("[translate]")?.getAttribute("translate"));
        assert.equal(translate, "no", "the app root is notranslatable");

        await page.goto(new URL("/login", origin).href, { waitUntil: "networkidle" });
        assert.equal(
          await page.locator('meta[name="google"][content="notranslate"]').count(),
          1,
          "/login carries the notranslate marker"
        );

        await page.goto(new URL("/", origin).href, { waitUntil: "networkidle" });
        assert.equal(
          await page.locator('meta[name="google"][content="notranslate"]').count(),
          0,
          "the public site does not carry the notranslate marker"
        );

        assert.deepEqual(blockedWrites, [], "the shell wrote to a customer route");
        return "/portal and /login carry the marker, / does not, and the app root is translate=no.";
      } finally {
        await context.close();
      }
    }
  );
  await record(
    "F04-B10",
    "The shell renders before the session is confirmed: the sidebar keeps its shape with placeholder rows, so the page never jumps into place.",
    async () => {
      const { context, page, blockedWrites } = await openPortal(browser, origin, {
        viewport: { width: 1440, height: 1000 },
        // The membership read is held, so the shell stays in its booting
        // state while the case looks at it.
        membershipDelayMs: 8000,
      });
      try {
        await page.waitForSelector('[data-slot="sidebar"]', { timeout: 15000 });

        assert.ok(
          await page.locator('[data-slot="sidebar-container"]').isVisible(),
          "the sidebar is on screen before the workspace is known"
        );
        assert.ok(
          (await page.locator('[data-sidebar="group-label"]').count()) > 0,
          "the group labels are in place"
        );
        assert.equal(
          await page.locator('nav[aria-label="Main navigation"] a').count(),
          0,
          "the booting nav has no links yet"
        );
        assert.equal(
          await page
            .locator('nav[aria-label="Main navigation"]')
            .getAttribute("aria-busy"),
          "true",
          "the nav says it is busy"
        );
        assert.ok(
          (await page.locator('[data-slot="sidebar-menu-skeleton"]').count()) > 0,
          "the account row is a skeleton"
        );
        assert.ok(
          (await page.locator('[data-slot="skeleton"]').count()) > 0,
          "the switcher and the page are skeletons"
        );

        // And once the workspace arrives, the nav gains its links.
        await page.waitForSelector('nav[aria-label="Main navigation"] a', { timeout: 20000 });
        assert.ok(
          (await page.locator('nav[aria-label="Main navigation"] a').count()) > 0,
          "the nav gains its links once the workspace is known"
        );

        assert.deepEqual(blockedWrites, [], "the shell wrote to a customer route");
        return "The sidebar, the group labels, the placeholder rows and the skeletons are on screen before the workspace is known, and the nav fills in after.";
      } finally {
        await context.close();
      }
    }
  );
} finally {
  await browser.close();
}
