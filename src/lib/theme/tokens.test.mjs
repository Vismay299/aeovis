import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const APP_THEME_CSS = path.join(REPO, "src/styles/app-theme.css");
const GLOBALS_CSS = path.join(REPO, "src/app/globals.css");

// Ottosson matrix conversion: oklch -> OKLab -> linear sRGB -> sRGB-encoded
function oklchToLinearSrgb(L, C, H) {
  const rad = (H * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [r, g, bl];
}

function linToSrgb(c) {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

function srgbToLin(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function srgbLuminance([r, g, b]) {
  const rLin = srgbToLin(r);
  const gLin = srgbToLin(g);
  const bLin = srgbToLin(b);
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

function wcagContrast(y1, y2) {
  const l1 = Math.max(y1, y2);
  const l2 = Math.min(y1, y2);
  return (l1 + 0.05) / (l2 + 0.05);
}

function parseColor(val) {
  const hexMatch = val.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  if (hexMatch) {
    return {
      r: parseInt(hexMatch[1], 16) / 255,
      g: parseInt(hexMatch[2], 16) / 255,
      b: parseInt(hexMatch[3], 16) / 255,
      alpha: 1,
    };
  }

  const oklchMatch = val.match(/oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)%?)?\s*\)/);
  if (oklchMatch) {
    const L = parseFloat(oklchMatch[1]) / 100;
    const C = parseFloat(oklchMatch[2]);
    const H = parseFloat(oklchMatch[3]);
    let alpha = 1;
    if (oklchMatch[4] !== undefined) {
      alpha = parseFloat(oklchMatch[4]);
      if (alpha > 1) alpha /= 100;
    }
    const [linR, linG, linB] = oklchToLinearSrgb(L, C, H);
    return {
      r: linToSrgb(linR),
      g: linToSrgb(linG),
      b: linToSrgb(linB),
      alpha,
    };
  }

  throw new Error(`Unsupported color format: ${val}`);
}

function parseTokensBlock(block) {
  const tokens = {};
  const re = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
  let match;
  while ((match = re.exec(block)) !== null) {
    tokens[match[1]] = match[2].trim();
  }

  // Resolve var(--name)
  for (const [k, v] of Object.entries(tokens)) {
    const varMatch = v.match(/^var\(--([a-z0-9-]+)\)$/);
    if (varMatch && tokens[varMatch[1]]) {
      tokens[k] = tokens[varMatch[1]];
    }
  }

  return tokens;
}

function compositeOver(fg, bg, explicitAlpha = null) {
  const a = explicitAlpha !== null ? explicitAlpha : fg.alpha;
  return [
    a * fg.r + (1 - a) * bg.r,
    a * fg.g + (1 - a) * bg.g,
    a * fg.b + (1 - a) * bg.b,
  ];
}

test("app-theme tokens contrast and structural rules", () => {
  const appCss = fs.readFileSync(APP_THEME_CSS, "utf8");
  const globalsCss = fs.readFileSync(GLOBALS_CSS, "utf8");

  // Structural checks
  assert.match(appCss, /@utility reveal-on-hover/);
  assert.ok(
    appCss.includes('[data-surface="app"] input:not([data-slot])') &&
      appCss.includes('[data-surface="app"] textarea:not([data-slot])') &&
      appCss.includes('[data-surface="app"] select:not([data-slot])'),
    "app-theme.css must contain 16px input rule for [data-surface='app']"
  );

  // no openseo string (exclude licence header which cites every-app/open-seo)
  const linesWithoutLicense = appCss
    .split("\n")
    .filter((l) => !l.includes("every-app/open-seo"))
    .join("\n");
  assert.ok(!linesWithoutLicense.toLowerCase().includes("openseo"), "app-theme.css must not contain openseo string");

  // globals.css must not have dark theme selectors
  assert.ok(!globalsCss.includes('data-theme="dark"'), "globals.css must not contain data-theme='dark'");
  assert.ok(!globalsCss.includes("prefers-color-scheme"), "globals.css must not contain prefers-color-scheme");

  // Extract :root block
  const rootMatch = appCss.match(/:root\s*\{([^}]+)\}/);
  assert.ok(rootMatch, "Must find :root block");
  const lightTokens = parseTokensBlock(rootMatch[1]);

  // Extract :root[data-theme="dark"] block
  const darkMatch = appCss.match(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/);
  assert.ok(darkMatch, "Must find :root[data-theme='dark'] block");
  const darkTokens = parseTokensBlock(darkMatch[1]);

  // Check light primary
  assert.equal(lightTokens["primary"], "#3730ce", "Light --primary must be #3730ce");

  // Contrast pairs to assert for both light and dark
  const pairs = [
    { fg: "foreground", bg: "background" },
    { fg: "foreground", bg: "card" },
    { fg: "muted-foreground", bg: "card" },
    { fg: "muted-foreground", bg: "background" },
    { fg: "primary-foreground", bg: "primary" },
    { fg: "primary", bg: "card" },
    { fg: "sidebar-foreground", bg: "sidebar" },
    { fg: "sidebar-foreground", bg: "sidebar", alpha: 0.65, name: "color-mix(sidebar-foreground 65%)/sidebar" },
    { fg: "destructive", bg: "card" },
  ];

  for (const theme of ["light", "dark"]) {
    const tokens = theme === "light" ? lightTokens : darkTokens;
    for (const pair of pairs) {
      const fgRaw = tokens[pair.fg];
      const bgRaw = tokens[pair.bg];
      assert.ok(fgRaw, `Missing token --${pair.fg} in ${theme}`);
      assert.ok(bgRaw, `Missing token --${pair.bg} in ${theme}`);

      const fgParsed = parseColor(fgRaw);
      const bgParsed = parseColor(bgRaw);

      const fgComp = compositeOver(fgParsed, bgParsed, pair.alpha ?? null);
      const bgComp = [bgParsed.r, bgParsed.g, bgParsed.b];

      const fgLum = srgbLuminance(fgComp);
      const bgLum = srgbLuminance(bgComp);
      const contrast = wcagContrast(fgLum, bgLum);

      const label = pair.name ?? `${pair.fg}/${pair.bg}`;
      assert.ok(
        contrast >= 4.5,
        `Expected ${theme} ${label} contrast >= 4.5, got ${contrast.toFixed(2)}:1`
      );
    }
  }
});
