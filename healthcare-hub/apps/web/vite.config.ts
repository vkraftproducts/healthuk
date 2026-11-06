import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // The repo-root .env is shared with the API; only VITE_* values reach the browser. Unit tests
  // keep their own defaults.
  envDir: mode === 'test' ? '.' : '../..',
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000', '/readyz': 'http://localhost:4000' },
  },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], css: false },
}));
