import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig(() => {
  // 根据环境变量决定构建哪个 app
  const buildTarget = process.env.BUILD_TARGET || 'app';

  const configs = {
    app: {
      base: '/app/',
      outDir: '../static/app',
      input: 'index.html',
    },
    dashboard: {
      base: '/dashboard/',
      outDir: '../static/dashboard',
      input: 'dashboard.html',
    },
  };

  const config = configs[buildTarget as keyof typeof configs] || configs.app;

  return {
    base: config.base,
    plugins: [react()],
    resolve: {
      preserveSymlinks: true,
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@linx': path.resolve(__dirname, './src/external/linx/src'),
      },
    },
    server: {
      fs: {
        allow: [
          path.resolve(__dirname, '../../'),
        ],
      },
    },
    build: {
      outDir: config.outDir,
      emptyOutDir: true,
      rollupOptions: {
        input: path.resolve(__dirname, config.input),
        output: {
          // app 使用固定文件名（auth.html 模板需要），dashboard 使用 hash
          entryFileNames: buildTarget === 'app' ? 'assets/main.js' : 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: buildTarget === 'app' ? 'assets/[name].[ext]' : 'assets/[name]-[hash].[ext]'
        }
      }
    }
  };
})