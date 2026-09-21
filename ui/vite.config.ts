import { defineConfig, type Plugin, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import desktopClient from '../src/identity/oidc/xpod-desktop-client.json'
import { productSurfaceRoots } from './src/routes/canonical-routes'

export function xpodDesktopClientDocumentPlugin(): Plugin {
  const fileName = 'xpod-desktop-client.json';
  const source = `${JSON.stringify(desktopClient, null, 2)}\n`;
  return {
    name: 'xpod-desktop-client-document',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName, source });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split('?')[0];
        if (!['GET', 'HEAD'].includes(request.method ?? '') ||
          (pathname !== `/${fileName}` && pathname !== `/app/${fileName}`)) {
          next();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(request.method === 'HEAD' ? undefined : source);
      });
    },
  };
}

export function resolveLocalXpodGateway(env: NodeJS.ProcessEnv = process.env): string {
  // CSS_BASE_URL is the managed canonical identity, not the local transport.
  const url = new URL(env.XPOD_DEV_GATEWAY_URL || 'http://127.0.0.1:3000');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('XPOD_DEV_GATEWAY_URL must be an HTTP(S) origin');
  }
  return url.origin;
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
  const notificationRoute: ProxyOptions = {
    target,
    changeOrigin: true,
    xfwd: true,
    // Live updates open a raw `WebSocket`, which cannot carry the canonical
    // route headers the catch-all bypass checks, so the upgrade must be
    // proxied unconditionally. The channel's own POST/DELETE share the route.
    ws: true,
  };
  return {
    '/.account': route,
    '/.well-known': route,
    '/provision': route,
    '/api': route,
    '/v1': route,
    // The desktop shell attaches to the running runtime by probing `/service/status`
    // and `/status/overview` on its own origin. When that origin is this dev server,
    // both probes must reach the gateway; document navigations are rewritten to the
    // Vite entry earlier in the chain and never hit these routes.
    '/service': route,
    '/status': route,
    '/.notifications': notificationRoute,
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

export function developmentDocumentPath(url: string, method: string | undefined, accept: string): string | undefined {
  if (method !== 'GET' || !accept.includes('text/html')) return undefined;
  const { pathname, search } = new URL(url, 'http://vite.local');
  const under = (root: string) => pathname === root || pathname.startsWith(`${root}/`);
  let document: string | undefined;
  if (under('/.account') || under('/app')) document = '/index.html';
  else if (under('/auth/callback')) document = '/auth-callback.html';
  else {
    const surface = productSurfaceRoots.find(({ basename }) => under(basename));
    if (surface) document = `/${surface.app}.html`;
  }
  return document ? `${document}${search}` : undefined;
}

function xpodDevelopmentRoutesPlugin(): Plugin {
  return {
    name: 'xpod-development-routes',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        // Rewrite only HTML navigations before Vite's API proxy middleware.
        request.url = developmentDocumentPath(request.url || '/', request.method, String(request.headers.accept || '')) ?? request.url;
        next();
      });
    },
  };
}

// Serve linked browser packages from source: package builds remove dist before
// writing it again, which must not invalidate an in-progress desktop login.
// Exact matches preserve each package's public subpaths and normal build exports.
function developmentWorkspaceAliases() {
  const entries: Record<string, Record<string, string>> = {
    'extension-sdk': {
      '': 'index.ts', '/manifest': 'manifest.ts', '/react': 'react.ts',
      '/web': 'web.ts', '/testing': 'testing.ts',
    },
    'solid-sdk': {
      '': 'index.ts', '/session': 'session.ts', '/pod-runtime': 'pod-runtime.ts',
      '/react': 'react.ts', '/webid-auth': 'webid-auth.ts',
      '/storage-selection': 'storage-selection.ts', '/login-store': 'login-store.ts',
      '/local-route-fetch': 'local-route-fetch.ts',
    },
    'shared-ui': { '': 'index.ts', '/theme.css': 'theme.css' },
    'pod-collections': { '': 'index.ts', '/react': 'react.ts' },
    // One package serves the applet and the interoperability contract it owns;
    // `src/contract` is where the server-facing subpaths live.
    'ai-connections': {
      '': 'index.ts', '/manifest': 'manifest.ts',
      '/client': 'contract/ai-connections-client.ts',
      '/provider-catalog': 'contract/provider-catalog.ts',
      '/client-config': 'contract/client-config/index.ts',
      '/endpoint-urls': 'contract/endpoint-urls.ts',
    },
  };
  return Object.entries(entries).flatMap(([pkg, exports]) =>
    Object.entries(exports).map(([subpath, source]) => ({
      find: new RegExp(`^@undefineds\\.co/${pkg}${subpath.replaceAll('.', '\\.')}$`),
      replacement: path.resolve(__dirname, '../packages', pkg, 'src', source),
    })),
  );
}

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
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
  const localXpodGateway = resolveLocalXpodGateway();

  return {
    base: command === 'serve' ? '/' : config.base,
    plugins: [xpodDesktopClientDocumentPlugin(), react(), xpodDevelopmentRoutesPlugin(), stripTrailingWhitespacePlugin()],
    resolve: {
      alias: [
        { find: '@', replacement: path.resolve(__dirname, './src') },
        ...(command === 'serve' ? developmentWorkspaceAliases() : []),
      ],
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
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
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
