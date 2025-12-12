import { defineConfig } from 'vitest/config';
const coverageEnabled = process.env.COVERAGE === 'true';

export default defineConfig({
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      [ 'tests/http/**', 'node' ],
      [ 'tests/storage/**', 'node' ],
      [ 'tests/identity/**', 'node' ],
    ],
    // Exclude PTY integration tests - they crash vitest due to node-pty + V8 threading issues
    // Run them separately with: npx ts-node scripts/test-terminal-pty.ts
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/terminal/*.integration.test.ts',
    ],
    globals: true,
    coverage: {
      enabled: coverageEnabled,
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: [
        'src/http/EdgeNodeRedirectHttpHandler.ts',
        'src/http/quota/**/*.ts',
        'src/storage/quota/PerAccountQuotaStrategy.ts',
        'src/storage/quota/UsageTrackingStore.ts',
        'src/service/EdgeNodeHeartbeatService.ts',
        'src/identity/drizzle/**/*.ts'
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
