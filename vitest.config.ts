import { defineConfig } from 'vitest/config';
const coverageEnabled = process.env.COVERAGE === 'true';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    // Always load `.env.local` when present. For integration runs we also allow it to
    // override ambient env vars to keep tests deterministic across machines.
    setupFiles: [ 'tests/vitest.setup.ts' ],
    environment: 'node',
    pool: 'forks',  // Use forks instead of threads to avoid SIGSEGV with native modules
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environmentMatchGlobs: [
      [ 'ui/src/**/*.test.{ts,tsx}', 'jsdom' ],
      [ 'tests/http/**', 'node' ],
      [ 'tests/storage/**', 'node' ],
      [ 'tests/identity/**', 'node' ],
    ],
    // Exclude PTY integration tests - they crash vitest due to node-pty + V8 threading issues
    // Run them separately with: npx ts-node scripts/test-terminal-pty.ts
    // Exclude external symlinked modules - they have their own test setup
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.test-data/**',
      '**/.worktrees/**',
      '**/_deprecated/**',
      '**/_deprecated_quadstore/**',
      'desktop/test/**',
      'tests/e2e/**',
      'tests/package/**',
      'tests/terminal/*.integration.test.ts',
      'ui/src/api/ai-config.test.ts',
      'ui/src/api/network-settings.test.ts',
      'ui/src/layout/network-navigation.test.ts',
      'ui/src/layout/status-navigation.test.ts',
      'ui/src/layout/system-settings-navigation.test.ts',
      'ui/src/pages/settings/ai-config/AiConfigContext.test.ts',
      'ui/src/pages/settings/ai-config/SearchIndexingPanel.test.ts',
      'ui/src/pages/settings/ai-config/form-state.test.ts',
      'ui/src/pages/settings/settings-projection.test.ts',
      'ui/src/pages/status/usage-projection.test.ts',
      'ui/src/external/**',
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
        'src/service/EdgeNodeSignalClient.ts',
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
