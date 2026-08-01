import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: [
      '**/dist/**',
      '**/.test-data/**',
      '**/node_modules/**',
    ],
  },
});
