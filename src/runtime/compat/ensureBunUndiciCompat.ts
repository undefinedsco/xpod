import path from 'node:path';
import { createRequire } from 'node:module';
import { PACKAGE_ROOT } from '../package-root';

type UndiciWithCacheStores = {
  cacheStores?: {
    MemoryCacheStore?: unknown;
  };
  interceptors?: {
    cache?: unknown;
  };
  Agent?: {
    prototype?: {
      compose?: unknown;
    };
  };
};

let patched = false;

function loadUserlandUndici(packageRoot: string): UndiciWithCacheStores | undefined {
  try {
    const packageRequire = createRequire(path.join(packageRoot, 'package.json'));
    const undiciPath = packageRequire.resolve('undici/index.js');
    return packageRequire(undiciPath) as UndiciWithCacheStores;
  } catch {
    return undefined;
  }
}

export function ensureBunUndiciCompat(packageRoot: string = PACKAGE_ROOT): void {
  if (patched) {
    return;
  }

  const isBunRuntime = typeof globalThis === 'object' && globalThis !== null && 'Bun' in globalThis;
  if (!isBunRuntime) {
    patched = true;
    return;
  }

  const builtinUndici = require('undici') as UndiciWithCacheStores;
  const hasCacheStore = Boolean(builtinUndici.cacheStores?.MemoryCacheStore);
  const hasCacheInterceptor = typeof builtinUndici.interceptors?.cache === 'function';
  const hasComposableAgent = typeof builtinUndici.Agent?.prototype?.compose === 'function';
  if (hasCacheStore && hasCacheInterceptor && hasComposableAgent) {
    patched = true;
    return;
  }

  const userlandUndici = loadUserlandUndici(packageRoot);
  if (userlandUndici?.cacheStores?.MemoryCacheStore && !hasCacheStore) {
    builtinUndici.cacheStores = userlandUndici.cacheStores;
  }

  if (typeof userlandUndici?.interceptors?.cache === 'function') {
    builtinUndici.interceptors ??= {};
    builtinUndici.interceptors.cache ??= userlandUndici.interceptors.cache;
  }

  if (
    typeof builtinUndici.Agent?.prototype?.compose !== 'function' &&
    typeof userlandUndici?.Agent?.prototype?.compose === 'function'
  ) {
    builtinUndici.Agent = userlandUndici.Agent;
  }

  patched = Boolean(
    builtinUndici.cacheStores?.MemoryCacheStore &&
    typeof builtinUndici.interceptors?.cache === 'function' &&
    typeof builtinUndici.Agent?.prototype?.compose === 'function',
  );
}
