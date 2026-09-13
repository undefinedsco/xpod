import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: __dirname,
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      react: path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
    },
  },
  esbuild: { jsx: 'automatic' },
  test: {
    name: 'ui',
    environment: 'jsdom',
    pool: 'forks',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['src/external/**'],
    server: {
      deps: {
        // Linked packages share the host React. Keep the UI's own router
        // version separate from the server workspace's router dependency.
        inline: [
          /@undefineds\.co\/(extension-sdk|shared-ui|ai-connections)/,
          /@radix-ui\//,
          /lucide-react/,
        ],
      },
    },
  },
});
