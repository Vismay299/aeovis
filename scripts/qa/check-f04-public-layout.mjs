#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { getPublicUrlInventory } from "../../src/lib/publicSite.js";

async function loadChromium() {
  const pw = await import(path.resolve("worker/node_modules/playwright/index.mjs"));
  return pw.chromium;
}

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 1000 },
  { name: "390", width: 390, height: 844 },
];

function getRoutes() {
  const inv = getPublicUrlInventory();
  const paths = inv.map((i) => (typeof i === "string" ? i : i.path));
  if (!paths.includes("/scan")) paths.push("/scan");
  return paths;
}

async function capture(origin, outPath) {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true });
  const routes = getRoutes();
  const result = {};

  try {
    for (const vp of VIEWPORTS) {
      result[vp.name] = {};
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();

      for (const route of routes) {
        const url = new URL(route, origin).href;
        try {
          await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
        } catch {
          // If networkidle times out, wait for load
          await page.goto(url, { waitUntil: "load", timeout: 30000 });
        }
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 100))));

        const elements = await page.evaluate(() => {
          function getDomPath(el) {
            const stack = [];
            let current = el;
            while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
              const parent = current.parentElement;
              if (!parent) {
                stack.unshift(current.tagName.toLowerCase());
                break;
              }
              const tag = current.tagName.toLowerCase();
              let index = 1;
              for (const sibling of parent.children) {
                if (sibling === current) break;
                if (sibling.tagName.toLowerCase() === tag) index++;
              }
              stack.unshift(`${tag}:nth-of-type(${index})`);
              current = parent;
            }
            if (current === document.documentElement) {
              stack.unshift("html");
            }
            return stack.join(" > ");
          }

          const records = [];
          const all = document.querySelectorAll("*");
          let count = 0;

          for (const el of all) {
            if (count >= 5000) break;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;

            const cs = window.getComputedStyle(el);
            const domPath = getDomPath(el);

            const bwTop = parseFloat(cs.borderTopWidth) || 0;
            const bwRight = parseFloat(cs.borderRightWidth) || 0;
            const bwBottom = parseFloat(cs.borderBottomWidth) || 0;
            const bwLeft = parseFloat(cs.borderLeftWidth) || 0;

            const rec = {
              tag: el.tagName.toLowerCase(),
              path: domPath,
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              color: cs.color,
              backgroundColor: cs.backgroundColor,
              borderTopWidth: cs.borderTopWidth,
              borderRightWidth: cs.borderRightWidth,
              borderBottomWidth: cs.borderBottomWidth,
              borderLeftWidth: cs.borderLeftWidth,
              fontFamily: cs.fontFamily,
              fontSize: cs.fontSize,
              fontWeight: cs.fontWeight,
              lineHeight: cs.lineHeight,
              cursor: cs.cursor,
            };

            if (bwTop > 0) rec.borderTopColor = cs.borderTopColor;
            if (bwRight > 0) rec.borderRightColor = cs.borderRightColor;
            if (bwBottom > 0) rec.borderBottomColor = cs.borderBottomColor;
            if (bwLeft > 0) rec.borderLeftColor = cs.borderLeftColor;

            if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
              try {
                const placeholderCs = window.getComputedStyle(el, "::placeholder");
                if (placeholderCs) rec.placeholderColor = placeholderCs.color;
              } catch {}
            }

            records.push(rec);
            count++;
          }
          return records;
        });

        result[vp.name][route] = elements;
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), JSON.stringify(result, null, 2));
  console.log(`Captured layout snapshot to ${outPath}`);
}

function compare(basePath, headPath, allowPath) {
  const base = JSON.parse(fs.readFileSync(path.resolve(basePath), "utf8"));
  const head = JSON.parse(fs.readFileSync(path.resolve(headPath), "utf8"));
  let allowlist = [];
  if (allowPath && fs.existsSync(path.resolve(allowPath))) {
    allowlist = JSON.parse(fs.readFileSync(path.resolve(allowPath), "utf8"));
  }

  function matchesAllowlist(route, vp, domPath, field) {
    return allowlist.some((a) => {
      if (a.route && a.route !== route) return false;
      if (a.path && a.path !== domPath) return false;
      if (a.field && a.field !== field) return false;
      return true;
    });
  }

  const differences = [];

  for (const vp of VIEWPORTS) {
    const vpName = vp.name;
    const baseRoutes = base[vpName] || {};
    const headRoutes = head[vpName] || {};
    const allRoutes = Array.from(new Set([...Object.keys(baseRoutes), ...Object.keys(headRoutes)]));

    for (const route of allRoutes) {
      const baseEls = baseRoutes[route] || [];
      const headEls = headRoutes[route] || [];

      const baseMap = new Map(baseEls.map((e) => [e.path, e]));
      const headMap = new Map(headEls.map((e) => [e.path, e]));

      for (const [domPath, bEl] of baseMap) {
        const hEl = headMap.get(domPath);
        if (!hEl) {
          if (!matchesAllowlist(route, vpName, domPath, "presence")) {
            differences.push({
              msg: `${domPath}@${vpName} in ${route} missing in head`,
              route,
              vp: vpName,
              path: domPath,
              field: "presence",
            });
          }
          continue;
        }

        const fields = Object.keys(bEl);
        for (const f of fields) {
          if (bEl[f] !== hEl[f]) {
            if (!matchesAllowlist(route, vpName, domPath, f)) {
              differences.push({
                msg: `${domPath}@${vpName} ${f}: ${bEl[f]} → ${hEl[f]}`,
                route,
                vp: vpName,
                path: domPath,
                field: f,
              });
            }
          }
        }
      }

      for (const [domPath] of headMap) {
        if (!baseMap.has(domPath)) {
          if (!matchesAllowlist(route, vpName, domPath, "presence")) {
            differences.push({
              msg: `${domPath}@${vpName} in ${route} added in head`,
              route,
              vp: vpName,
              path: domPath,
              field: "presence",
            });
          }
        }
      }
    }
  }

  if (differences.length > 0) {
    for (const d of differences) {
      console.error(d.msg);
    }
    console.error(`\nFound ${differences.length} unexpected layout difference(s).`);
    process.exit(1);
  } else {
    console.log("0 differences");
    process.exit(0);
  }
}

const [cmd, arg1, arg2, arg3] = process.argv.slice(2);

if (cmd === "capture") {
  if (!arg1 || !arg2) {
    console.error("Usage: check-f04-public-layout.mjs capture <origin> <out.json>");
    process.exit(1);
  }
  await capture(arg1, arg2);
} else if (cmd === "compare") {
  if (!arg1 || !arg2) {
    console.error("Usage: check-f04-public-layout.mjs compare <base.json> <head.json> [allow.json]");
    process.exit(1);
  }
  compare(arg1, arg2, arg3);
} else {
  console.error("Unknown command. Usage: check-f04-public-layout.mjs <capture|compare> ...");
  process.exit(1);
}
