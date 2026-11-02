import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
  },
});
