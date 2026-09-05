import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

/** UI fixtures only; real RC Account/Pod/Chat acceptance uses its own live suite. */
export default defineConfig({
  ...baseConfig,
  testMatch: 'e2e/account-web-layout.spec.ts',
  outputDir: '.test-data/account-web-layout',
  webServer: {
    command: 'bun run --cwd ui dev --host 127.0.0.1 --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
