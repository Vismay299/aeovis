import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UI_DIR = path.join(REPO, "src/components/ui");

// SPEC GAP 1: 32 primitives were ported from every-app/open-seo (spec text
// mentions 31, but lists 32 files). chart.tsx, the shadcn Recharts wrapper, was
// removed in T3 when the charts moved to the Bklit library in
// src/components/charts, leaving 31.
const PRIMITIVES = [
  "accordion.tsx",
  "alert-dialog.tsx",
  "alert.tsx",
  "badge.tsx",
  "button.tsx",
  "card.tsx",
  "checkbox.tsx",
  "collapsible.tsx",
  "combobox.tsx",
  "dialog.tsx",
  "dropdown-menu.tsx",
  "empty.tsx",
  "field.tsx",
  "input-group.tsx",
  "input.tsx",
  "label.tsx",
  "progress.tsx",
  "radio-group.tsx",
  "select.tsx",
  "separator.tsx",
  "sheet.tsx",
  "sidebar.tsx",
  "skeleton.tsx",
  "spinner.tsx",
  "switch.tsx",
  "table.tsx",
  "tabs.tsx",
  "textarea.tsx",
  "toggle-group.tsx",
  "toggle.tsx",
  "tooltip.tsx",
];

test("all 31 UI primitives exist and conform to conventions", () => {
  assert.ok(fs.existsSync(UI_DIR), "src/components/ui directory must exist");

  for (const filename of PRIMITIVES) {
    const filePath = path.join(UI_DIR, filename);
    assert.ok(fs.existsSync(filePath), `Primitive missing: ${filename}`);

    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    // First line must be "use client";
    const firstLine = lines[0].trim();
    assert.equal(
      firstLine,
      '"use client";',
      `${filename} must start with "use client"; on line 1`
    );

    // Licence header naming src/client/components/ui/<filename>
    const headerSlice = lines.slice(1, 10).join("\n");
    assert.ok(
      headerSlice.includes("Portions ported from every-app/open-seo@c5f8db1") &&
        headerSlice.includes(`src/client/components/ui/${filename}`) &&
        headerSlice.includes("Modified for Perceev. See THIRD_PARTY_NOTICES.md."),
      `${filename} must contain proper licence header citing src/client/components/ui/${filename}`
    );

    // No from "cn"
    assert.ok(
      !content.includes('from "cn"') && !content.includes("from 'cn'"),
      `${filename} must not import from "cn"; must use "@/shared/utils"`
    );

    // No openseo / OpenSEO outside the licence header
    const bannedBrand = "open" + "seo";
    const bodyWithoutHeader = lines.slice(5).join("\n");
    assert.ok(
      !bodyWithoutHeader.toLowerCase().includes(bannedBrand),
      `${filename} must not contain ${bannedBrand} outside licence header`
    );

    // Special checks
    if (filename === "dialog.tsx") {
      assert.ok(
        content.includes("fullScreenOnMobile"),
        "dialog.tsx DialogContent must include fullScreenOnMobile prop"
      );
    }
  }
});
