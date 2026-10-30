import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: { NODE_ENV: 'test', RATE_LIMIT_LOGIN_MAX: '100000', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://pdv:pdv_dev_pw@127.0.0.1:5432/pdv_test' },
  },
});
