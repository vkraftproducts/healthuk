/** @type {import('tailwindcss').Config} */

/**
 * Light console theme, from the product owner's interactive demo (Manrope, navy #0b3b60 on slate,
 * white cards with hairline borders). Class names keep their old "teal" spelling: hub.teal is now
 * the navy primary.
 *
 *  - hub.ink, hub.muted, hub.teal, hub.teal-dark, hub.line and hub.edge are CSS variables,
 *    remapped to light-on-dark inside any .on-dark container (the sign-in hero).
 *
 * Contrast: all text pairings meet WCAG 2.2 AA on white and on the page (#f6f8fb).
 * Status is still conveyed by icon + words as well as colour (CLAUDE.md non-negotiable 8).
 */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        hub: {
          bg: '#f6f8fb', // page
          navy: '#0b3b60', // primary surface (sign-in hero)
          'navy-2': '#123f66', // raised dark controls
          card: '#ffffff', // panels and cards
          'card-2': '#ffffff', // popovers
          field: '#ffffff', // inputs
          ink: 'rgb(var(--hub-ink) / <alpha-value>)', // headings and primary text
          teal: 'rgb(var(--hub-teal) / <alpha-value>)', // accent (name kept)
          'teal-dark': 'rgb(var(--hub-teal-dark) / <alpha-value>)',
          line: 'rgb(var(--hub-line) / <alpha-value>)', // card borders
          edge: 'rgb(var(--hub-edge) / <alpha-value>)', // form control borders (>= 3:1)
          row: '#f8fafc', // alternate rows, hovers
          muted: 'rgb(var(--hub-muted) / <alpha-value>)', // secondary text
          glow: '#0b3b60',
          mint: '#a3caf6',
          sky: '#eef5fc', // selected navigation, info tints
        },
      },
      fontFamily: {
        sans: [
          '"Manrope Variable"',
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
          '"Manrope Variable"',
          '"Inter Variable"',
          '"Segoe UI"',
          'system-ui',
          'sans-serif',
        ],
        mono: ['"JetBrains Mono Variable"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: { xl: '12px', '2xl': '16px' },
      boxShadow: {
        glow: '0 1px 2px rgb(15 23 42 / 0.08)',
        'glow-sm': '0 1px 2px rgb(15 23 42 / 0.08)',
        panel: '0 1px 2px rgb(15 23 42 / 0.04)',
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
