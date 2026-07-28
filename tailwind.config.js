/** @type {import('tailwindcss').Config} */
const plugin = require("tailwindcss/plugin");

module.exports = {
    darkMode: ["class"],
    content: [
    "./src/pages/**/*.{js,jsx,ts,tsx}",
    "./src/components/**/*.{js,jsx,ts,tsx}",
    "./src/app/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Archivo"', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['"Archivo"', 'Arial', 'sans-serif'],
        mono: ['"Spline Sans Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 1px)',
        sm: '1px'
      },
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))'
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent-shadcn))',
          foreground: 'hsl(var(--accent-shadcn-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))'
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        /* Signalling lamps — available to utilities where a token
           reference would be more awkward than a class. */
        panel: {
          0: 'var(--panel-0)',
          1: 'var(--panel-1)',
          2: 'var(--panel-2)',
          3: 'var(--panel-3)'
        },
        rule: {
          1: 'var(--rule-1)',
          2: 'var(--rule-2)',
          3: 'var(--rule-3)'
        },
        lamp: {
          green: 'var(--lamp-green)',
          white: 'var(--lamp-white)',
          amber: 'var(--lamp-amber)',
          red: 'var(--lamp-red)',
          blue: 'var(--lamp-blue)'
        },
        track: {
          DEFAULT: 'var(--track)',
          dim: 'var(--track-dim)'
        },
        nickel: 'var(--nickel)',
        chart: {
          '1': 'var(--chart-1)',
          '2': 'var(--chart-2)',
          '3': 'var(--chart-3)',
          '4': 'var(--chart-4)',
          '5': 'var(--chart-5)'
        }
      },
      transitionTimingFunction: {
        lamp: 'var(--ease-lamp)',
        decay: 'var(--ease-decay)',
        point: 'var(--ease-point)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' }
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' }
        },
        'shimmer': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' }
        },
        /* Filament inrush — a lamp coming up behind the diagram. */
        'lamp-in': {
          '0%': { opacity: '0', filter: 'brightness(0.35)' },
          '60%': { opacity: '1', filter: 'brightness(1.35)' },
          '100%': { opacity: '1', filter: 'brightness(1)' }
        },
        /* A section occupying left to right, the way a train does. */
        'occupy': {
          from: { transform: 'scaleX(0)' },
          to: { transform: 'scaleX(1)' }
        }
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s var(--ease-lamp)',
        'accordion-up': 'accordion-up 0.2s var(--ease-decay)',
        'shimmer': 'shimmer 1.8s infinite',
        'lamp-in': 'lamp-in var(--dur-lamp) var(--ease-lamp) both',
        'occupy': 'occupy 420ms var(--ease-lamp) both'
      }
    }
  },
  plugins: [
    require("tailwindcss-animate"),
    /* One variable face, three voices. Tailwind has no font-stretch
       scale, and the width axis is what makes the signage voice. */
    plugin(function ({ addUtilities }) {
      addUtilities({
        '.wdth-sig': { 'font-stretch': 'var(--wdth-sig)' },
        '.wdth-body': { 'font-stretch': 'var(--wdth-body)' },
        '.wdth-plate': { 'font-stretch': 'var(--wdth-plate)' },
        '.wdth-tally': { 'font-stretch': 'var(--wdth-tally)' },
      });
    }),
  ],
};
