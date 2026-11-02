/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Wireframe palette ("Healthcare platform mock 1"). All text pairings meet WCAG 2.2 AA.
      colors: {
        hub: {
          navy: '#1f3a52', // sidebar, table headers, headings (11.8:1 on white)
          'navy-2': '#2b4a66', // sidebar hover
          teal: '#0f7c86', // primary action, active nav (4.9:1 with white)
          'teal-dark': '#0b636b',
          bg: '#f2f6fa', // page background
          line: '#d6e1ea', // card borders
          row: '#f6f9fc', // alternate table row
          muted: '#52677a', // secondary text (5.9:1 on white)
        },
      },
      fontFamily: {
        sans: [
          '"Segoe UI"',
          'system-ui',
          '-apple-system',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};
