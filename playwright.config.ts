import { defineConfig, devices } from '@playwright/test';

const useSystemChrome = process.env.XPOD_PLAYWRIGHT_SYSTEM_CHROME === '1';

export default defineConfig({
  testDir: './tests',
  use: {
    baseURL: 'http://localhost:3000',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(useSystemChrome ? { channel: 'chrome' as const } : {}),
      },
    },
  ],
});
