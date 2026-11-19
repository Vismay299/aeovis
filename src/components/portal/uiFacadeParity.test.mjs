import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import React from "react";
import { compileJsx } from "../../server/renderHarness.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const uiPath = path.join(root, "src/components/portal/ui.jsx");

function tokenize(str) {
  return (str || "").trim().split(/\s+/).filter(Boolean);
}

function assertTokensIncluded(actualClass, expectedString, context) {
  const actualSet = new Set(tokenize(actualClass));
  const expectedTokens = tokenize(expectedString);
  for (const token of expectedTokens) {
    assert.ok(
      actualSet.has(token),
      `${context}: class list "${actualClass}" is missing expected token "${token}"`,
    );
  }
}

function extractCvaBase(text) {
  const match = text.match(/cva\(\s*"([^"]+)"/);
  assert.ok(match, "cva base string must be found");
  return match[1];
}

function extractSection(text, sectionName) {
  const regex = new RegExp(`\\b${sectionName}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`);
  const match = text.match(regex);
  assert.ok(match, `section "${sectionName}" must be found`);
  return match[1];
}

function extractVariant(sectionText, key) {
  const regex = new RegExp(`\\b${key}:\\s*"([^"]+)"`);
  const match = sectionText.match(regex);
  assert.ok(match, `variant string for "${key}" must be found`);
  return match[1];
}

test("ui.jsx facade parity with shadcn base-nova primitives (F04-AC-16)", async () => {
  const [buttonSrc, badgeSrc, alertSrc, cardSrc] = await Promise.all([
    readFile(path.join(root, "src/components/ui/button.tsx"), "utf8"),
    readFile(path.join(root, "src/components/ui/badge.tsx"), "utf8"),
    readFile(path.join(root, "src/components/ui/alert.tsx"), "utf8"),
    readFile(path.join(root, "src/components/ui/card.tsx"), "utf8"),
  ]);

  // Extract primitive class tokens
  const buttonBase = extractCvaBase(buttonSrc);
  const buttonVariantSec = extractSection(buttonSrc, "variant");
  const buttonSizeSec = extractSection(buttonSrc, "size");
  const buttonVariants = {
    default: extractVariant(buttonVariantSec, "default"),
    outline: extractVariant(buttonVariantSec, "outline"),
    ghost: extractVariant(buttonVariantSec, "ghost"),
    destructive: extractVariant(buttonVariantSec, "destructive"),
  };
  const buttonSizes = {
    default: extractVariant(buttonSizeSec, "default"),
    sm: extractVariant(buttonSizeSec, "sm"),
  };

  const badgeBase = extractCvaBase(badgeSrc);
  const badgeVariantSec = extractSection(badgeSrc, "variant");
  const badgeVariants = {
    secondary: extractVariant(badgeVariantSec, "secondary"),
    soft: extractVariant(badgeVariantSec, "soft"),
    success: extractVariant(badgeVariantSec, "success"),
    warning: extractVariant(badgeVariantSec, "warning"),
    destructive: extractVariant(badgeVariantSec, "destructive"),
  };

  const alertBase = extractCvaBase(alertSrc);
  const alertVariantSec = extractSection(alertSrc, "variant");
  const alertVariants = {
    info: extractVariant(alertVariantSec, "info"),
    success: extractVariant(alertVariantSec, "success"),
    warning: extractVariant(alertVariantSec, "warning"),
    destructive: extractVariant(alertVariantSec, "destructive"),
  };

  const cardMatch = cardSrc.match(/className=\{cn\(\s*"([^"]+)"/);
  assert.ok(cardMatch, "card primitive base classes must be found");
  const cardBase = cardMatch[1];

  // Compile ui.jsx
  const ui = await compileJsx(uiPath, {
    modules: new Map([
      ["react", React],
      ["next/link", { default: ({ children, ...props }) => React.createElement("a", props, children) }],
      // Stat renders StatTile now. This proof only reads Button, Badge, Banner
      // and Card class lists, so the tile is deliberately nulled rather than
      // pulled in with its chart/motion graph.
      ["@/components/app/StatTile", { StatTile: () => null, default: () => null }],
    ]),
    autoNull: ["lucide-react"],
  });

  // 1. Button parity
  const buttonVariantMap = {
    primary: "default",
    secondary: "outline",
    ghost: "ghost",
    danger: "destructive",
  };
  const buttonSizeMap = {
    md: "default",
    sm: "sm",
  };

  for (const [variant, primVar] of Object.entries(buttonVariantMap)) {
    for (const [size, primSize] of Object.entries(buttonSizeMap)) {
      const el = ui.Button({ variant, size, children: "Button text" });
      const cls = el.props.className;

      assertTokensIncluded(cls, buttonBase, `Button(${variant}, ${size}) base`);
      assertTokensIncluded(cls, buttonVariants[primVar], `Button(${variant}, ${size}) variant`);
      assertTokensIncluded(cls, buttonSizes[primSize], `Button(${variant}, ${size}) size`);

      // Check hook classes
      assert.ok(cls.includes("pv-btn"), `Button(${variant}, ${size}) must have pv-btn hook`);
      assert.ok(cls.includes(`pv-btn--${variant}`), `Button(${variant}, ${size}) must have pv-btn--${variant} hook`);
      if (size === "sm") {
        assert.ok(cls.includes("pv-btn--sm"), "Button sm must have pv-btn--sm hook");
      }
    }
  }

  // 2. Badge parity
  const badgeToneMap = {
    neutral: "secondary",
    brand: "soft",
    good: "success",
    warn: "warning",
    crit: "destructive",
  };

  for (const [tone, primVar] of Object.entries(badgeToneMap)) {
    const el = ui.Badge({ tone, children: "Badge text" });
    const cls = el.props.className;

    assertTokensIncluded(cls, badgeBase, `Badge(${tone}) base`);
    assertTokensIncluded(cls, badgeVariants[primVar], `Badge(${tone}) variant`);

    assert.ok(cls.includes("pv-badge"), `Badge(${tone}) must have pv-badge hook`);
    if (tone !== "neutral") {
      assert.ok(cls.includes(`pv-badge--${tone}`), `Badge(${tone}) must have pv-badge--${tone} hook`);
    }
  }

  // 3. Banner parity
  const bannerToneMap = {
    info: "info",
    success: "success",
    warn: "warning",
    error: "destructive",
  };

  for (const [tone, primVar] of Object.entries(bannerToneMap)) {
    const el = ui.Banner({ tone, children: "Notice message" });
    const cls = el.props.className;

    assertTokensIncluded(cls, alertBase, `Banner(${tone}) base`);
    assertTokensIncluded(cls, alertVariants[primVar], `Banner(${tone}) variant`);

    assert.ok(cls.includes("pv-banner"), `Banner(${tone}) must have pv-banner hook`);
    assert.ok(cls.includes(`pv-banner--${tone}`), `Banner(${tone}) must have pv-banner--${tone} hook`);
  }

  // 4. Card parity
  const cardEl = ui.Card({ children: "Card content" });
  const cardCls = cardEl.props.className;
  assertTokensIncluded(cardCls, cardBase, "Card base");
  assert.ok(cardCls.includes("pv-card"), "Card must have pv-card hook");

  const cardFlushEl = ui.Card({ flush: true, children: "Card flush content" });
  assert.ok(cardFlushEl.props.className.includes("pv-card--flush"), "Card flush must have pv-card--flush hook");
});
