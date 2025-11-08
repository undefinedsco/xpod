import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const coverageEnabled = process.env.COVERAGE === 'true';

export default defineConfig({
  plugins: [ react() ],
  test: {
    environment: 'jsdom',
    environmentMatchGlobs: [
      [ 'tests/http/**', 'node' ],
      [ 'tests/storage/**', 'node' ],
      [ 'tests/identity/**', 'node' ],
    ],
    globals: true,
    setupFiles: [ 'tests/setup/vitest.setup.ts' ],
    coverage: {
      enabled: coverageEnabled,
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: [
        'src/http/admin/**/*.ts',
        'src/http/EdgeNodeRedirectHttpHandler.ts',
        'src/http/quota/**/*.ts',
        'src/storage/quota/PerAccountQuotaStrategy.ts',
        'src/storage/quota/UsageTrackingStore.ts',
        'src/service/EdgeNodeHeartbeatService.ts',
        'src/identity/drizzle/**/*.ts',
        'ui/admin/src/App.tsx',
        'ui/admin/src/components/AppShell.tsx',
        'ui/admin/src/components/ThemeToggle.tsx',
        'ui/admin/src/modules/format.ts',
        'ui/admin/src/pages/QuotaPage.tsx',
        'ui/admin/src/pages/NodesPage.tsx',
      ],
      reporter: [ 'text', 'text-summary', 'lcov' ],
      thresholds: coverageEnabled ? {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
        perFile: true,
      } : undefined,
    },
  },
});
