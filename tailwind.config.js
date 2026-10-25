/** @type {import('tailwindcss').Config} */

/* Tailwind is the utility layer over the Perceev token system defined in
   src/app/globals.css. The tokens are the API; everything here just makes
   them reachable from a class name. See docs/design/DESIGN-SYSTEM.md. */

module.exports = {
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Archivo"', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        display: ['"Archivo"', 'system-ui', 'sans-serif'],
        mono: ['"SplineMono"', '"Spline Sans Mono"', 'ui-monospace', '"SF Mono"', 'monospace'],
      },
      borderRadius: {
        pill: 'var(--r-pill)',
      },
      maxWidth: {
        shell: 'var(--shell)',
      },
      boxShadow: {
        1: 'var(--shadow-1)',
        2: 'var(--shadow-2)',
        3: 'var(--shadow-3)',
      },
      colors: {
        /* Perceev tokens, for the places a utility reads better than a
           style attribute. Names match the design system exactly. */
        paper: 'var(--paper)',
        surface: 'var(--surface)',
        sunken: 'var(--sunken)',
        raised: 'var(--raised)',
        ink: {
          1: 'var(--ink-1)',
          2: 'var(--ink-2)',
          3: 'var(--ink-3)',
          4: 'var(--ink-4)'
        },
        line: {
          DEFAULT: 'var(--line)',
          soft: 'var(--line-soft)',
          strong: 'var(--line-strong)'
        },
        brand: {
          DEFAULT: 'var(--brand)',
          lift: 'var(--brand-lift)',
          tint: 'var(--brand-tint)',
          line: 'var(--brand-line)',
          on: 'var(--on-brand)'
        },
        navy: {
          DEFAULT: 'var(--navy)',
          ink: 'var(--navy-ink)',
          dim: 'var(--navy-dim)',
          line: 'var(--navy-line)'
        },
        good: { DEFAULT: 'var(--good)', tint: 'var(--good-tint)', on: 'var(--on-good)' },
        warn: { DEFAULT: 'var(--warn)', tint: 'var(--warn-tint)' },
        crit: { DEFAULT: 'var(--crit)', tint: 'var(--crit-tint)' },

        /* --you is indigo in every chart, without exception; rivals ramp
           down the neutral scale and never take a semantic hue */
        you: 'var(--you)',
        rival: {
          1: 'var(--rival-1)',
          2: 'var(--rival-2)',
          3: 'var(--rival-3)'
        },
        none: 'var(--none)',
      },
      /* one easing curve for the whole system; nothing bounces */
      transitionTimingFunction: {
        DEFAULT: 'cubic-bezier(.22,.68,0,1)',
        ease: 'cubic-bezier(.22,.68,0,1)',
        lamp: 'cubic-bezier(.22,.68,0,1)',
        decay: 'cubic-bezier(.22,.68,0,1)',
        point: 'cubic-bezier(.22,.68,0,1)',
      },
      transitionDuration: {
        fast: '150ms',
        base: '260ms',
        slow: '620ms',
      },
      keyframes: {
        /* a calm opacity pulse, never a sweeping shimmer */
        'skel': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '.45' }
        },
        'screen-in': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'none' }
        }
      },
      animation: {
        'skel': 'skel 1.5s ease-in-out infinite',
        'screen-in': 'screen-in 380ms cubic-bezier(.22,.68,0,1) both'
      }
    }
  },
  plugins: [],
};
