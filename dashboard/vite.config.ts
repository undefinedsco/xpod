import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: '.',
  base: '/dashboard/',
  build: {
    outDir: '../static/dashboard',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, 'index.html'),
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
