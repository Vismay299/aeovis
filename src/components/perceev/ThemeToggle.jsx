'use client';

import { useEffect, useState } from 'react';
import { Sun, Moon, MonitorCog } from 'lucide-react';

const KEY = 'perceev-theme';

/* Three states, in the order a viewer cycles them. "system" stamps nothing
   on the root, which is what lets prefers-color-scheme decide; the other two
   stamp data-theme so an explicit choice beats the OS in either direction. */
const ORDER = ['system', 'light', 'dark'];

const LABEL = {
  system: 'Theme: follow system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

function apply(mode) {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

export function ThemeToggle({ className = '' }) {
  const [mode, setMode] = useState('system');

  /* The inline boot script in layout.js has already stamped the root, so this
     only syncs React's copy of the value — it must not re-apply on mount or
     it would fight the pre-paint stamp. */
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === 'light' || saved === 'dark') setMode(saved);
    } catch {
      /* storage unavailable — stay on system */
    }
  }, []);

  /* Functional update: two clicks inside one React batch would otherwise both
     read the same stale `mode` and land on the same theme. */
  const cycle = () => {
    setMode((prev) => {
      const next = ORDER[(ORDER.indexOf(prev) + 1) % ORDER.length];
      apply(next);
      try {
        if (next === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, next);
      } catch {
        /* storage unavailable — the choice still holds for this page */
      }
      return next;
    });
  };

  const Icon = mode === 'light' ? Sun : mode === 'dark' ? Moon : MonitorCog;

  return (
    <button
      type="button"
      className={`themebtn ${className}`.trim()}
      onClick={cycle}
      title={LABEL[mode]}
      aria-label={LABEL[mode]}
      data-testid="theme-toggle"
    >
      <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}

export default ThemeToggle;
