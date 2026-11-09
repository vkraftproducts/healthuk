/** @type {import('tailwindcss').Config} */

/**
 * "Neon Forest" theme, light edition: a bright, futuristic, green-lit interface. The page and cards are
 * clean white and mint, the sidebar and sign-in hero are a deep forest green, and green is the accent.
 *
 * Two things to know when reading class names in this codebase:
 *  1. `hub.ink`, `hub.muted`, `hub.teal`, `hub.teal-dark`, `hub.line` and `hub.edge` are CSS variables.
 *     They are dark-on-light by default and are remapped to light-on-dark inside any `.on-dark`
 *     container (the sidebar and the sign-in hero), so the same class reads correctly in both.
 *  2. The `slate` scale is green-tinted. 50-300 are light surfaces/borders (and double as light text on
 *     the dark sidebar); 400-900 step from mid grey-green to near-black text.
 *
 * Contrast: all text pairings meet WCAG 2.2 AA on white and on the mint page (#eef7f2).
 * Status is still conveyed by icon + words as well as colour (CLAUDE.md non-negotiable 8).
 */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        hub: {
          bg: '#eef7f2', // page
          navy: '#0a2a1c', // sidebar / hero surface (name kept for compatibility)
          'navy-2': '#13402c', // sidebar hover, raised dark controls
          card: '#ffffff', // panels and cards
          'card-2': '#ffffff', // popovers
          field: '#ffffff', // inputs
          ink: 'rgb(var(--hub-ink) / <alpha-value>)', // headings and primary text
          teal: 'rgb(var(--hub-teal) / <alpha-value>)', // brand green (name kept)
          'teal-dark': 'rgb(var(--hub-teal-dark) / <alpha-value>)',
          line: 'rgb(var(--hub-line) / <alpha-value>)', // card borders
          edge: 'rgb(var(--hub-edge) / <alpha-value>)', // form control borders (>= 3:1)
          row: '#eef8f2', // alternate rows, hovers
          muted: 'rgb(var(--hub-muted) / <alpha-value>)', // secondary text
          lime: '#84cc16',
          glow: '#10b981',
          mint: '#34d399',
        },
        slate: {
          50: '#f4faf7',
          100: '#e6f3ec',
          200: '#cfe5d8',
          300: '#b0cfbf',
          400: '#86a898',
          500: '#58786a',
          600: '#476354',
          700: '#344d40',
          800: '#1f3a2c',
          900: '#0f2a1c',
        },
      },
      fontFamily: {
        sans: [
          '"Inter Variable"',
          '"Segoe UI"',
          'system-ui',
          '-apple-system',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        display: [
          '"Space Grotesk Variable"',
          '"Inter Variable"',
          '"Segoe UI"',
          'system-ui',
          'sans-serif',
        ],
        mono: ['"JetBrains Mono Variable"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: { xl: '14px', '2xl': '18px' },
      boxShadow: {
        glow: '0 0 0 1px rgb(16 185 129 / 0.35), 0 10px 28px -8px rgb(16 185 129 / 0.45)',
        'glow-sm': '0 6px 18px -6px rgb(16 185 129 / 0.45)',
        panel: 'inset 0 1px 0 rgb(255 255 255 / 0.9), 0 12px 32px -16px rgb(10 70 45 / 0.28)',
      },
      keyframes: {
        draw: {
          '0%': { strokeDashoffset: '100' },
          '45%, 100%': { strokeDashoffset: '0' },
        },
        'rise-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
        beacon: {
          '0%': { transform: 'scale(1)', opacity: '0.55' },
          '100%': { transform: 'scale(2.4)', opacity: '0' },
        },
        scan: {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(100%)' },
        },
      },
      animation: {
        draw: 'draw 3.6s ease-in-out infinite',
        'rise-in': 'rise-in 0.35s ease-out both',
        beacon: 'beacon 2s ease-out infinite',
        scan: 'scan 3.2s linear infinite',
      },
    },
  },
  plugins: [],
};
