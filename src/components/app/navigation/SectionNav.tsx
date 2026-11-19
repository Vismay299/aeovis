"use client";

import * as React from "react";
import { LayoutGroup, MotionConfig, motion } from "motion/react";
import { cn } from "@/shared/utils";

export type SectionNavItem = { id: string; label: string };

/**
 * The locked header section pill (first built as `SectionNav` in the UI lab):
 * a sticky strip of links to a long page's sections, with one pill that
 * follows the section in view and springs to a section when it is clicked.
 *
 * The app scrolls inside the content pane (`#app-content`), not the window,
 * so both the in-view tracking and the jump use that pane. Each target needs
 * the matching `id`, plus a scroll margin so the strip does not cover its
 * heading (`scroll-mt-16`). The links are real `#id` anchors: without
 * JavaScript, or for assistive tech, they still go to the section.
 */
export function SectionNav({
  sections,
  label = "Sections",
  scrollerId = "app-content",
  className,
}: {
  sections: readonly SectionNavItem[];
  /** The nav landmark's name. */
  label?: string;
  /** The scrolling element's id; `null` for a page that scrolls the window. */
  scrollerId?: string | null;
  className?: string;
}) {
  const [active, setActive] = React.useState<string>(sections[0]?.id ?? "");
  const groupId = React.useId();
  const ids = sections.map((section) => section.id).join("|");

  React.useEffect(() => {
    const scroller = scrollerId ? document.getElementById(scrollerId) : null;
    const nodes = ids
      .split("|")
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => Boolean(node));
    if (!nodes.length) return;

    // A section is "in view" while it crosses a line a quarter of the way
    // down the pane, the same band the lab used.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { root: scroller, rootMargin: "-25% 0px -65% 0px" },
    );
    nodes.forEach((node) => observer.observe(node));

    // The last section can be too short to reach that line; at the very
    // bottom of the pane it is the one being read.
    const target: HTMLElement | Window = scroller ?? window;
    const onScroll = () => {
      const el = scroller ?? document.documentElement;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
        setActive(nodes[nodes.length - 1].id);
      }
    };
    target.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      observer.disconnect();
      target.removeEventListener("scroll", onScroll);
    };
  }, [ids, scrollerId]);

  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup id={groupId}>
        <nav
          aria-label={label}
          data-slot="section-nav"
          className={cn(
            "sticky top-0 z-20 -mx-1 flex items-center gap-1 overflow-x-auto bg-background/85 px-1 py-2 backdrop-blur",
            className,
          )}
        >
          {sections.map((section) => {
            const isActive = active === section.id;
            return (
              <a
                key={section.id}
                href={`#${section.id}`}
                aria-current={isActive ? "location" : undefined}
                onClick={(event) => {
                  const node = document.getElementById(section.id);
                  if (!node) return;
                  event.preventDefault();
                  setActive(section.id);
                  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                  node.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
                }}
                className="relative shrink-0 rounded-full px-3 py-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-[current]:text-primary-foreground aria-[current]:hover:text-primary-foreground"
              >
                {isActive ? (
                  <motion.span
                    layoutId="section-nav-pill"
                    aria-hidden
                    transition={{ type: "spring", bounce: 0.2, visualDuration: 0.35 }}
                    className="absolute inset-0 rounded-full bg-primary"
                  />
                ) : null}
                <span className="relative">{section.label}</span>
              </a>
            );
          })}
        </nav>
      </LayoutGroup>
    </MotionConfig>
  );
}

export default SectionNav;
