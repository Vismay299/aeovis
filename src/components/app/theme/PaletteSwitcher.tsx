"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { SlidersHorizontal, X } from "lucide-react";
import {
  BASE_PALETTE,
  BASE_SHAPE,
  PALETTES,
  PALETTE_CHANGE_EVENT,
  PALETTE_STORAGE_KEY,
  SHAPES,
  SHAPE_STORAGE_KEY,
  parsePalette,
  parseShape,
  type PaletteId,
  type ShapeId,
} from "@/shared/theme/palette";

const DOCK_OPEN_KEY = "perceev:palette-review-open";
const SPRING = { type: "spring", bounce: 0.18, visualDuration: 0.32 } as const;

type Group = "shades" | "accent";
const GROUPS: readonly { id: Group; label: string }[] = [
  { id: "shades", label: "Shades" },
  { id: "accent", label: "Accent" },
];

function readPalette(): PaletteId {
  if (typeof document === "undefined") return BASE_PALETTE;
  return parsePalette(document.documentElement.getAttribute("data-palette"));
}

function readShape(): ShapeId {
  if (typeof document === "undefined") return BASE_SHAPE;
  return parseShape(document.documentElement.getAttribute("data-shape"));
}

function subscribe(onChange: () => void) {
  window.addEventListener(PALETTE_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PALETTE_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function store(key: string, value: string, base: string) {
  try {
    if (value === base) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage is unavailable: the pick still holds for this page.
  }
}

function writePalette(id: PaletteId) {
  document.documentElement.setAttribute("data-palette", id);
  store(PALETTE_STORAGE_KEY, id, BASE_PALETTE);
  window.dispatchEvent(new Event(PALETTE_CHANGE_EVENT));
}

function writeShape(id: ShapeId) {
  document.documentElement.setAttribute("data-shape", id);
  store(SHAPE_STORAGE_KEY, id, BASE_SHAPE);
  window.dispatchEvent(new Event(PALETTE_CHANGE_EVENT));
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => unknown;
};

/** Page and text split on the diagonal, with the accent as a dot when there is one. */
function Swatch({ colors }: { colors: readonly string[] }) {
  return (
    <span
      aria-hidden
      className="relative block size-6 overflow-hidden rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.34)]"
      style={{ background: `linear-gradient(135deg, ${colors[0]} 0 50%, ${colors[1]} 50% 100%)` }}
    >
      {colors[2] ? (
        <span
          className="absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_0_1.5px_rgba(0,0,0,0.55)]"
          style={{ background: colors[2] }}
        />
      ) : null}
    </span>
  );
}

function Segmented<T extends string>({
  label,
  layoutId,
  items,
  value,
  onChange,
  onHover,
}: {
  label: string;
  layoutId: string;
  items: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  onHover?: (value: T | null) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="relative flex items-center rounded-full bg-white/8 p-0.5">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          onClick={() => onChange(item.id)}
          onPointerEnter={() => onHover?.(item.id)}
          onPointerLeave={() => onHover?.(null)}
          className="relative h-8 rounded-full px-3 text-[12px] font-medium text-white/65 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 aria-selected:text-white"
        >
          {value === item.id ? (
            <motion.span layoutId={layoutId} transition={SPRING} className="absolute inset-0 rounded-full bg-white/18" />
          ) : null}
          <span className="relative">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A floating dock for reviewing variants of the colour scheme and of the
 * component shape. It keeps its own fixed colours so it reads the same on
 * every variant.
 */
export function PaletteSwitcher() {
  const reducedMotion = useReducedMotion();
  const active = React.useSyncExternalStore(subscribe, readPalette, () => BASE_PALETTE);
  const shape = React.useSyncExternalStore(subscribe, readShape, () => BASE_SHAPE);
  const [open, setOpen] = React.useState(true);
  const [hint, setHint] = React.useState<string | null>(null);
  const [group, setGroup] = React.useState<Group>("shades");
  const [mounted, setMounted] = React.useState(false);
  const groupRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setMounted(true);
    if (PALETTES.find((option) => option.id === readPalette())?.group === "accent") setGroup("accent");
    try {
      if (window.localStorage.getItem(DOCK_OPEN_KEY) === "0") setOpen(false);
    } catch {
      // Storage is unavailable: the dock stays open.
    }
  }, []);

  const toggleOpen = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(DOCK_OPEN_KEY, next ? "1" : "0");
    } catch {
      // Storage is unavailable: the choice holds until reload.
    }
  };

  const transition = (update: () => void) => {
    const doc = document as ViewTransitionDocument;
    if (doc.startViewTransition && !reducedMotion) doc.startViewTransition(() => flushSync(update));
    else update();
  };

  const choose = (id: PaletteId) => {
    if (id !== active) transition(() => writePalette(id));
  };

  const options = PALETTES.filter((option) => option.group === group);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = Math.max(0, options.findIndex((option) => option.id === active));
    const next = (index + step + options.length) % options.length;
    choose(options[next].id);
    groupRef.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };

  if (!mounted) return null;

  const current = PALETTES.find((option) => option.id === active) ?? PALETTES[0];
  const detail = hint ?? `${current.label} · ${current.note}`;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex justify-center px-4 print:hidden"
      style={{ viewTransitionName: "palette-dock" }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {open ? (
          <motion.div
            key="dock"
            initial={{ opacity: 0, y: 16, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.94 }}
            transition={SPRING}
            className="pointer-events-auto flex max-w-full flex-col items-center gap-2"
          >
            <div
              aria-live="polite"
              className="flex h-7 max-w-full items-center overflow-hidden rounded-full bg-[#1b1b1e]/95 px-3 text-[12px] font-medium text-white shadow-lg ring-1 ring-white/12 backdrop-blur"
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={detail}
                  initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  className="truncate whitespace-nowrap"
                >
                  {detail}
                </motion.span>
              </AnimatePresence>
            </div>

            <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-full bg-[#1b1b1e]/95 p-1.5 text-white shadow-xl ring-1 ring-white/12 backdrop-blur">
              <Segmented label="Scheme family" layoutId="palette-dock-group" items={GROUPS} value={group} onChange={setGroup} />

              <div
                ref={groupRef}
                role="radiogroup"
                aria-label="Colour scheme"
                className="flex items-center gap-0.5"
                onKeyDown={onKeyDown}
                onPointerLeave={() => setHint(null)}
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  {options.map((option, index) => {
                    const selected = option.id === active;
                    const text = `${option.label} · ${option.note}`;
                    return (
                      <motion.button
                        key={option.id}
                        layout
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={text}
                        tabIndex={selected || (index === 0 && !options.some((o) => o.id === active)) ? 0 : -1}
                        onClick={() => choose(option.id)}
                        onPointerEnter={() => setHint(text)}
                        onFocus={() => setHint(text)}
                        onBlur={() => setHint(null)}
                        initial={{ opacity: 0, scale: 0.5 }}
                        animate={{ opacity: 1, scale: 1, transition: { ...SPRING, delay: index * 0.03 } }}
                        exit={{ opacity: 0, scale: 0.5, transition: { duration: 0.1 } }}
                        whileHover={{ y: -3 }}
                        whileTap={{ scale: 0.88 }}
                        transition={SPRING}
                        className="relative grid size-9 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                      >
                        {selected ? (
                          <motion.span
                            layoutId="palette-dock-active"
                            transition={SPRING}
                            className="absolute inset-0 rounded-full bg-white/16 ring-1 ring-white/40"
                          />
                        ) : null}
                        <span className="relative">
                          <Swatch colors={option.swatches} />
                        </span>
                      </motion.button>
                    );
                  })}
                </AnimatePresence>
              </div>

              <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-white/15" />
              <Segmented
                label="Component shape"
                layoutId="palette-dock-shape"
                items={SHAPES}
                value={shape}
                onChange={(id) => transition(() => writeShape(id))}
                onHover={(id) => setHint(id ? `Shape: ${SHAPES.find((item) => item.id === id)?.note}` : null)}
              />

              <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-white/15" />
              <motion.button
                type="button"
                whileTap={{ scale: 0.9 }}
                transition={SPRING}
                aria-label="Hide review dock"
                onClick={() => toggleOpen(false)}
                className="grid size-9 shrink-0 place-items-center rounded-full text-white/70 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <X className="size-4" />
              </motion.button>
            </div>
          </motion.div>
        ) : (
          <motion.button
            key="pill"
            type="button"
            initial={{ opacity: 0, y: 16, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.8 }}
            whileTap={{ scale: 0.92 }}
            transition={SPRING}
            aria-label="Show review dock"
            onClick={() => toggleOpen(true)}
            className="pointer-events-auto grid size-11 place-items-center rounded-full bg-[#1b1b1e]/95 text-white shadow-xl ring-1 ring-white/12 outline-none backdrop-blur focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <SlidersHorizontal className="size-[18px]" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

export default PaletteSwitcher;
