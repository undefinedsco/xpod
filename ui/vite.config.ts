import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

type ProductBuildTarget = 'app' | 'dashboard' | 'settings';

function productDevServerPlugin(buildTarget: ProductBuildTarget): Plugin {
  if (buildTarget === 'app') {
    return { name: 'xpod-product-dev-server' };
  }

  const productBase = `/${buildTarget}/`;
  const entryPath = `${productBase}${buildTarget}.html`;

  return {
    name: 'xpod-product-dev-server',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.method !== 'GET' || !request.headers.accept?.includes('text/html')) {
          next();
          return;
        }

        const requestUrl = new URL(request.url ?? '/', 'http://vite.local');
        if (
          (requestUrl.pathname === productBase.slice(0, -1) || requestUrl.pathname.startsWith(productBase))
          && requestUrl.pathname !== entryPath
        ) {
          request.url = `${entryPath}${requestUrl.search}`;
        }
        next();
      });
    },
  };
}

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
  const buildTarget = (process.env.BUILD_TARGET || 'app') as ProductBuildTarget;

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
    settings: {
      base: '/settings/',
      outDir: '../static/settings',
      input: 'settings.html',
    },
  };

  const config = configs[buildTarget] || configs.app;
  const devGatewayUrl = process.env.XPOD_DEV_GATEWAY_URL?.trim();
  const proxy = devGatewayUrl
    ? Object.fromEntries([
        '/.account',
        '/.well-known',
        '/.oidc',
        '/api',
        '/v1',
      ].map((route) => [route, {
        target: devGatewayUrl,
        changeOrigin: true,
      }]))
    : undefined;

  return {
    base: config.base,
    plugins: [react(), productDevServerPlugin(buildTarget), stripTrailingWhitespacePlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      proxy,
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
        external: ['node:module'],
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
