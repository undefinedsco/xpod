import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

function resolveLocalXpodGateway(mode: string): string {
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '');
  const configured = env.CSS_BASE_URL?.trim();
  if (!configured) return 'http://127.0.0.1:3000';
  try {
    const url = new URL(configured);
    return url.origin;
  } catch {
    return 'http://127.0.0.1:3000';
  }
}

export function shouldProxyXpodCanonicalRouteRequest(headers: Headers | Record<string, string | string[] | undefined>): boolean {
  const canonicalUrl = headerValue(headers, 'x-xpod-canonical-url');
  const localRouteUrl = headerValue(headers, 'x-xpod-local-route-url');
  if (!canonicalUrl || !localRouteUrl) return false;
  try {
    new URL(canonicalUrl);
    new URL(localRouteUrl);
    return true;
  } catch {
    return false;
  }
}

function headerValue(headers: Headers | Record<string, string | string[] | undefined>, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function xpodGatewayProxy(target: string): Record<string, ProxyOptions> {
  // Preserve the browser's request origin for DPoP verification at the API.
  const route: ProxyOptions = { target, changeOrigin: true, xfwd: true };
  const sdkCanonicalRoute: ProxyOptions = {
    target,
    changeOrigin: true,
    xfwd: true,
    bypass(request) {
      // Only SDK local-route requests carry the canonical Pod mapping headers.
      // Let Vite handle ordinary SPA routes and static assets.
      return shouldProxyXpodCanonicalRouteRequest(request.headers)
        ? undefined
        : request.url;
    },
  };
  return {
    '/.account': route,
    '/.well-known': route,
    '/provision': route,
    '/api': route,
    '/v1': route,
    '^/.*': sdkCanonicalRoute,
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

const settingsProductDocumentRoutePrefixes = [
  '/ai-connections',
  '/ai-config',
  '/network',
  '/status',
];

function isSettingsProductDocumentRoute(pathname: string): boolean {
  return settingsProductDocumentRoutePrefixes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

function xpodDevelopmentRoutesPlugin(buildTarget: string): Plugin {
  return {
    name: 'xpod-development-routes',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const pathname = request.url ? new URL(request.url, 'http://vite.local').pathname : '';
        const acceptsHtml = request.method === 'GET'
          && String(request.headers.accept || '').includes('text/html');

        if (buildTarget === 'app' && pathname.startsWith('/.account/') && acceptsHtml) {
          // Account UI routes and CSS Account APIs intentionally share the
          // `/.account/` namespace. Keep document navigations in the SPA while
          // allowing fetch/XHR calls to continue through the gateway proxy.
          request.url = `/app/${request.url?.slice(pathname.length) ?? ''}`;
        } else if (buildTarget === 'dashboard' && pathname.startsWith('/dashboard/') && acceptsHtml) {
          request.url = `/dashboard/dashboard.html${request.url?.slice(pathname.length) ?? ''}`;
        } else if (
          buildTarget === 'settings'
          && (pathname.startsWith('/settings/') || isSettingsProductDocumentRoute(pathname))
          && acceptsHtml
        ) {
          request.url = `/settings/settings.html${request.url?.slice(pathname.length) ?? ''}`;
        } else if (
          (buildTarget === 'dashboard' || buildTarget === 'settings')
          && (pathname === '/auth/callback' || pathname === '/auth/callback/')
        ) {
          request.url = `${configBase(buildTarget)}auth-callback.html${request.url?.slice(pathname.length) ?? ''}`;
        }

        next();
      });
    },
  };
}

function configBase(buildTarget: string): string {
  return buildTarget === 'settings' ? '/settings/' : '/dashboard/';
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
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
    settings: {
      base: '/settings/',
      outDir: '../static/settings',
      input: 'settings.html',
    },
    authCallback: {
      base: '/auth/callback/',
      outDir: '../static/auth-callback',
      input: 'auth-callback.html',
    },
  };

  const config = configs[buildTarget as keyof typeof configs] || configs.app;
  const localXpodGateway = resolveLocalXpodGateway(mode);

  return {
    base: config.base,
    plugins: [react(), xpodDevelopmentRoutesPlugin(buildTarget), stripTrailingWhitespacePlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    optimizeDeps: {
      // These browser entries are CommonJS, including the engine itself.
      // Linked Pod consumers import them by name, so prebundle them as ESM.
      include: [
        '@comunica/query-sparql-solid',
        '@comunica/actor-query-result-serialize-stats',
        '@comunica/actor-query-result-serialize-sparql-json',
      ],
    },
    server: {
      proxy: xpodGatewayProxy(localXpodGateway),
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
        // The lightweight auth/smoke app only uses exact LDP operations. Settings,
        // however, hydrates Provider collections and therefore must bundle the
        // browser SPARQL engine instead of leaving an unresolvable bare import.
        external: buildTarget === 'settings' || buildTarget === 'authCallback'
          ? ['node:module']
          : ['@comunica/query-sparql-solid', 'node:module'],
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
