import path from 'node:path';
import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';
import testRunnerOwnership from './scripts/test-runner-ownership.json';
import testFileNames from './scripts/test-file-names.json';
const { collectBunOnlyTests } = createRequire(import.meta.url)('./scripts/bun-test-discovery.cjs') as { collectBunOnlyTests(root: string): string[] };
const coverageEnabled = process.env.COVERAGE === 'true';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'ui/src'),
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    // Transform this ESM connector so its HTTP transport can be replaced by
    // hermetic protocol fixtures; otherwise Node imports bypass vi.mock.
    server: { deps: { inline: ['@logto/connector-wechat-web'] } },
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
    include: [`**/*.{${testFileNames.kinds.join(',')}}.{${testFileNames.extensions.join(',')}}`],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.test-data/**',
      '**/.worktrees/**',
      '**/.claude/**',
      '**/_deprecated/**',
      '**/_deprecated_quadstore/**',
      'qlever/**',
      'desktop/test/**',
      // One ownership declaration also drives actual independent module gates.
      ...testRunnerOwnership.map(group => group.file ?? `${group.directory}/**`),
      'scripts/patch-inrupt-authn-refresh.test.js',
      'tests/e2e/**',
      'tests/package/**',
      // Bun-only tests: the vitest pool always runs on Node, so these run through
      // `bun run test:bun` (`scripts/run-bun-tests.ts`), which is wired into CI. Every entry
      // below must be covered by that entry — an exclusion without a runner is how N19 started.
      ...collectBunOnlyTests(__dirname).map(file => path.relative(__dirname, file).split(path.sep).join('/')),
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
