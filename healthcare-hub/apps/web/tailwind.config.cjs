/** @type {import('tailwindcss').Config} */

/**
 * Healthcare Hub UK v36 skin (Ant Design–aligned).
 * Page #f4f6fa, cards white, accent #0b4f8a, sidebar #0d2137.
 * `hub.teal` / `hub.teal-dark` keep their class names for compatibility but map to the blue accent.
 * Dark mode: `html.dark` (or `.on-dark` for the sidebar).
 */
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        hub: {
          bg: 'rgb(var(--hub-bg) / <alpha-value>)',
          navy: '#0d2137',
          'navy-2': '#16365a',
          card: 'rgb(var(--hub-card) / <alpha-value>)',
          'card-2': 'rgb(var(--hub-card) / <alpha-value>)',
          field: 'rgb(var(--hub-card) / <alpha-value>)',
          ink: 'rgb(var(--hub-ink) / <alpha-value>)',
          teal: 'rgb(var(--hub-accent) / <alpha-value>)',
          'teal-dark': 'rgb(var(--hub-accent-strong) / <alpha-value>)',
          line: 'rgb(var(--hub-line) / <alpha-value>)',
          edge: 'rgb(var(--hub-line2) / <alpha-value>)',
          row: 'rgb(var(--hub-hover) / <alpha-value>)',
          muted: 'rgb(var(--hub-mut) / <alpha-value>)',
          glow: '#0b4f8a',
          mint: '#9cc0e4',
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
          '"Inter Variable"',
          '"Segoe UI"',
          'system-ui',
          'sans-serif',
        ],
        mono: ['"JetBrains Mono Variable"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: { xl: '8px', '2xl': '12px' },
      boxShadow: {
        glow: '0 1px 2px rgba(15,27,45,0.06), 0 4px 12px rgba(15,27,45,0.06)',
        'glow-sm': '0 1px 2px rgba(15,27,45,0.08)',
        panel: '0 1px 2px rgba(15,27,45,0.04), 0 4px 16px rgba(15,27,45,0.06)',
      },
      keyframes: {
        'rise-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'none' },
        },
        beacon: {
          '0%': { transform: 'scale(1)', opacity: '0.55' },
          '100%': { transform: 'scale(2.2)', opacity: '0' },
        },
      },
      animation: {
        'rise-in': 'rise-in 0.25s ease-out both',
        beacon: 'beacon 2s ease-out infinite',
      },
    },
  },
  plugins: [],
};
