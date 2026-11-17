"use client";

import { motion } from "motion/react";

/**
 * The highlight behind the active sidebar row. Every row renders it only
 * while active, under one shared layoutId, so it slides from the old row to
 * the new one instead of blinking between them. Wrap the rows in a
 * LayoutGroup when more than one sidebar can be on screen.
 */
export function SidebarActivePill() {
  return (
    <motion.span
      layoutId="sidebar-active-pill"
      data-slot="sidebar-active-pill"
      aria-hidden
      transition={{ type: "spring", bounce: 0.22, visualDuration: 0.34 }}
    />
  );
}

export default SidebarActivePill;
