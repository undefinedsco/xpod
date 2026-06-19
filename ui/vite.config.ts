import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

function stripTrailingWhitespacePlugin(): Plugin {
  return {
    name: 'strip-trailing-whitespace',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') {
          output.code = output.code.replace(/[ \t]+$/gm, '');
        } else if (typeof output.source === 'string') {
          output.source = output.source.replace(/[ \t]+$/gm, '');
        }
      }
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(() => {
  // 根据环境变量决定构建哪个 app
  const buildTarget = process.env.BUILD_TARGET || 'app';

  const configs = {
    app: {
      base: '/app/',
      outDir: '../static/app',
      input: {
        main: 'index.html',
        'inrupt-smoke': 'inrupt-smoke.html',
      },
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
    plugins: [react(), stripTrailingWhitespacePlugin()],
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
        // drizzle-solid can optionally load Comunica for SPARQL queries, but the
        // browser smoke page only uses exact LDP read/write/delete. Keep the
        // optional SPARQL engine external so the phone verifier does not ship a
        // multi-megabyte unused query-engine chunk.
        external: ['@comunica/query-sparql-solid', 'node:module'],
        input: typeof config.input === 'string'
          ? path.resolve(__dirname, config.input)
          : Object.fromEntries(Object.entries(config.input).map(([name, input]) => [name, path.resolve(__dirname, input)])),
        output: {
          // app 使用固定文件名（auth.html 模板需要），dashboard 使用 hash
          entryFileNames: buildTarget === 'app' ? 'assets/[name].js' : 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: buildTarget === 'app' ? 'assets/[name].[ext]' : 'assets/[name]-[hash].[ext]'
        }
      }
    }
  };
})
