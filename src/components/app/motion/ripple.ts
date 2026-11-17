// Ink ripple: a translucent disc that grows from the point a control was
// pressed and fades. Styles live in motion.css under [data-slot="ripple"].

type PressEvent = { currentTarget: EventTarget | null; clientX: number; clientY: number };

/** Call from onPointerDown. Safe to call on any element. */
export function ripple(event: PressEvent) {
  const el = event.currentTarget as HTMLElement | null;
  if (!el || typeof window === "undefined" || typeof el.getBoundingClientRect !== "function") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  let host = el.querySelector<HTMLElement>(':scope > [data-slot="ripple-host"]');
  if (!host) {
    if (window.getComputedStyle(el).position === "static") el.style.position = "relative";
    host = document.createElement("span");
    host.dataset.slot = "ripple-host";
    host.setAttribute("aria-hidden", "true");
    el.appendChild(host);
  }

  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  // far enough to reach the furthest corner from the press point
  const radius = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));
  const dot = document.createElement("span");
  dot.dataset.slot = "ripple";
  dot.style.width = dot.style.height = `${radius * 2}px`;
  dot.style.left = `${x - radius}px`;
  dot.style.top = `${y - radius}px`;
  host.appendChild(dot);
  dot.addEventListener("animationend", () => dot.remove(), { once: true });
}
