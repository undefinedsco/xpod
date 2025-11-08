import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = path.resolve(__dirname, 'ui/admin');
const outDir = path.resolve(__dirname, 'dist/ui/admin');

export default defineConfig({
  root: rootDir,
  plugins: [ react() ],
  base: '/admin/',
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    host: true,
    open: false,
  },
});
