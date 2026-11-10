/** @type {import('tailwindcss').Config} */

/**
 * "Neon Forest" theme, navy and teal edition: a bright, futuristic interface in the wireframe palette. The page and cards
 * are clean white on pale blue-grey, the sidebar and sign-in hero are navy (#1f3a52), and teal (#0f7c86) is the accent.
 *
 * Two things to know when reading class names in this codebase:
 *  1. `hub.ink`, `hub.muted`, `hub.teal`, `hub.teal-dark`, `hub.line` and `hub.edge` are CSS variables.
 *     They are dark-on-light by default and are remapped to light-on-dark inside any `.on-dark`
 *     container (the sidebar and the sign-in hero), so the same class reads correctly in both.
 *
 * Contrast: all text pairings meet WCAG 2.2 AA on white and on the page (#f2f6fa).
 * Status is still conveyed by icon + words as well as colour (CLAUDE.md non-negotiable 8).
 */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        hub: {
          bg: '#f2f6fa', // page
          navy: '#1f3a52', // sidebar / hero / table-header surface
          'navy-2': '#2b4a66', // sidebar hover, raised dark controls
          card: '#ffffff', // panels and cards
          'card-2': '#ffffff', // popovers
          field: '#ffffff', // inputs
          ink: 'rgb(var(--hub-ink) / <alpha-value>)', // headings and primary text
          teal: 'rgb(var(--hub-teal) / <alpha-value>)', // accent (name kept)
          'teal-dark': 'rgb(var(--hub-teal-dark) / <alpha-value>)',
          line: 'rgb(var(--hub-line) / <alpha-value>)', // card borders
          edge: 'rgb(var(--hub-edge) / <alpha-value>)', // form control borders (>= 3:1)
          row: '#f6f9fc', // alternate rows, hovers
          muted: 'rgb(var(--hub-muted) / <alpha-value>)', // secondary text
          glow: '#0f7c86',
          mint: '#5ec8d4',
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
        glow: '0 0 0 1px rgb(15 124 134 / 0.35), 0 10px 28px -8px rgb(15 124 134 / 0.4)',
        'glow-sm': '0 6px 18px -6px rgb(15 124 134 / 0.4)',
        panel: 'inset 0 1px 0 rgb(255 255 255 / 0.9), 0 12px 32px -16px rgb(31 58 82 / 0.22)',
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
