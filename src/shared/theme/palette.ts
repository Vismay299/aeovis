// The colour scheme and the component shape, plus the variants of each that
// are under review. Values live in src/styles/palettes.css and
// src/styles/shapes.css; this file is the list the review dock and the
// before-paint script share.

export type PaletteId =
  | "onyx"
  | "carbon"
  | "pitch"
  | "ember"
  | "frost"
  | "slate"
  | "volt"
  | "arcade"
  | "electric"
  | "ultra"
  | "aqua"
  | "pulse";

export interface PaletteOption {
  id: PaletteId;
  label: string;
  /** "shades" keep to two colours; "accent" adds a third that pops. */
  group: "shades" | "accent";
  /** The scheme's colours: page, text, then the accent when it has one. */
  swatches: readonly string[];
  note: string;
}

/** The scheme every page uses unless a variant is picked in the dock. */
export const BASE_PALETTE: PaletteId = "onyx";

export const PALETTES: readonly PaletteOption[] = [
  { id: "onyx", label: "Onyx", group: "shades", swatches: ["#0A0A0B", "#F5F5F5"], note: "Base · Onyx / White" },
  { id: "carbon", label: "Carbon", group: "shades", swatches: ["#131316", "#ECECEE"], note: "Softer · lifted charcoal" },
  { id: "pitch", label: "Pitch", group: "shades", swatches: ["#000000", "#FFFFFF"], note: "Harder · true black, pure white" },
  { id: "ember", label: "Ember", group: "shades", swatches: ["#0D0B0A", "#F6F1E9"], note: "Warm · brown-black, ivory" },
  { id: "frost", label: "Frost", group: "shades", swatches: ["#080A0E", "#EEF2F7"], note: "Cool · blue-black, ice white" },
  { id: "slate", label: "Slate", group: "shades", swatches: ["#0A0A0B", "#C9C9CF"], note: "Stepped greys · grey actions" },
  { id: "volt", label: "Volt", group: "accent", swatches: ["#0A0A0B", "#F5F5F5", "#C8F53A"], note: "Onyx / White / Volt Lime" },
  { id: "arcade", label: "Arcade", group: "accent", swatches: ["#0A0A0B", "#F5F5F5", "#FF6A13"], note: "Onyx / White / Arcade Orange" },
  { id: "electric", label: "Electric", group: "accent", swatches: ["#0A0A0B", "#F5F5F5", "#4D7CFF"], note: "Onyx / White / Electric Blue" },
  { id: "ultra", label: "Ultra", group: "accent", swatches: ["#0A0A0B", "#F5F5F5", "#A78BFA"], note: "Onyx / White / Ultraviolet" },
  { id: "aqua", label: "Aqua", group: "accent", swatches: ["#0A0A0B", "#F5F5F5", "#34E0C2"], note: "Onyx / White / Aqua Mint" },
  { id: "pulse", label: "Pulse", group: "accent", swatches: ["#0A0A0B", "#F5F5F5", "#FF4D8D"], note: "Onyx / White / Hot Pink" },
];

export const PALETTE_STORAGE_KEY = "perceev:palette-review";
export const PALETTE_CHANGE_EVENT = "perceev:palette-review-change";

const PALETTE_IDS: readonly string[] = PALETTES.map((option) => option.id);

export function parsePalette(raw: string | null | undefined): PaletteId {
  return raw && PALETTE_IDS.includes(raw) ? (raw as PaletteId) : BASE_PALETTE;
}

/* ── Component shape ──────────────────────────────────────────────── */

export type ShapeId = "soft" | "edge" | "pill";

export const BASE_SHAPE: ShapeId = "soft";

export const SHAPES: readonly { id: ShapeId; label: string; note: string }[] = [
  { id: "soft", label: "Soft", note: "Rounded corners, hairline borders, deep shadow" },
  { id: "edge", label: "Edge", note: "Square corners, ruled lines, instrument labels" },
  { id: "pill", label: "Pill", note: "Full rounds, frosted glass, soft glow" },
];

export const SHAPE_STORAGE_KEY = "perceev:shape-review";

const SHAPE_IDS: readonly string[] = SHAPES.map((option) => option.id);

export function parseShape(raw: string | null | undefined): ShapeId {
  return raw && SHAPE_IDS.includes(raw) ? (raw as ShapeId) : BASE_SHAPE;
}

/**
 * Runs before first paint so a picked variant never flashes the base. The
 * base scheme itself is set on <html> in the layout and needs no script.
 */
export function buildPaletteInitScript(): string {
  return `(() => {
  try {
    var root = document.documentElement;
    var p = window.localStorage.getItem(${JSON.stringify(PALETTE_STORAGE_KEY)});
    if (${JSON.stringify(PALETTE_IDS)}.indexOf(p) !== -1) root.setAttribute("data-palette", p);
    var s = window.localStorage.getItem(${JSON.stringify(SHAPE_STORAGE_KEY)});
    if (${JSON.stringify(SHAPE_IDS)}.indexOf(s) !== -1) root.setAttribute("data-shape", s);
  } catch {}
})();`;
}
