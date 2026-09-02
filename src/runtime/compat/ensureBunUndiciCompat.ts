import path from 'node:path';
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
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
let cssJwkPatched = false;

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

export function ensureBunCommunitySolidServerJwkCompat(cssModule: {
  CachedJwkGenerator?: {
    prototype?: {
      getPrivateKey?: unknown;
      getPublicKey?: unknown;
    };
  };
}): void {
  if (cssJwkPatched) {
    return;
  }

  const isBunRuntime = typeof globalThis === 'object' && globalThis !== null && 'Bun' in globalThis;
  if (!isBunRuntime) {
    cssJwkPatched = true;
    return;
  }

  const prototype = cssModule.CachedJwkGenerator?.prototype;
  if (!prototype) {
    cssJwkPatched = true;
    return;
  }

  prototype.getPrivateKey = async function getPrivateKey(this: CachedJwkGeneratorLike): Promise<Record<string, unknown>> {
    if (this.privateJwk) {
      return this.privateJwk;
    }
    const jwks = await this.storage.get(this.key);
    if (jwks?.keys?.[0]) {
      this.privateJwk = jwks.keys[0];
      return this.privateJwk;
    }

    const generated = generateNodeExtractableKeyPair(this.alg);
    if (!generated) {
      throw new TypeError(`Unsupported Bun-compatible JWK algorithm: ${this.alg}`);
    }

    const privateJwk = { ...generated.privateKey.export({ format: 'jwk' }), alg: this.alg };
    await this.storage.set(this.key, { keys: [privateJwk] });
    this.privateJwk = privateJwk;
    return privateJwk;
  };

  prototype.getPublicKey = async function getPublicKey(this: CachedJwkGeneratorLike): Promise<Record<string, unknown>> {
    if (this.publicJwk) {
      return this.publicJwk;
    }
    const privateJwk = await this.getPrivateKey();
    const publicJwk = stripPrivateJwkFields(privateJwk);
    publicJwk.alg = privateJwk.alg;
    this.publicJwk = publicJwk;
    return publicJwk;
  };

  cssJwkPatched = true;
}

interface CachedJwkGeneratorLike {
  alg: string;
  key: string;
  storage: {
    get(key: string): Promise<{ keys?: Record<string, unknown>[] } | undefined>;
    set(key: string, value: { keys: Record<string, unknown>[] }): Promise<void>;
  };
  privateJwk?: Record<string, unknown>;
  publicJwk?: Record<string, unknown>;
  getPrivateKey(): Promise<Record<string, unknown>>;
}

function generateNodeExtractableKeyPair(alg: string): { privateKey: KeyObject; publicKey: KeyObject } | undefined {
  const ecCurve = ecCurveForJoseAlg(alg);
  if (ecCurve) {
    const pair = generateKeyPairSync('ec', {
      namedCurve: ecCurve,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const privateKey = createPrivateKey(pair.privateKey);
    return {
      privateKey,
      publicKey: createPublicKey(privateKey),
    };
  }

  if (isRsaJoseAlg(alg)) {
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicExponent: 0x10001,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const privateKey = createPrivateKey(pair.privateKey);
    return {
      privateKey,
      publicKey: createPublicKey(privateKey),
    };
  }

  return undefined;
}

function ecCurveForJoseAlg(alg: string): string | undefined {
  switch (alg) {
    case 'ES256':
      return 'P-256';
    case 'ES384':
      return 'P-384';
    case 'ES512':
      return 'P-521';
    default:
      return undefined;
  }
}

function isRsaJoseAlg(alg: string): boolean {
  return /^(?:RS|PS)(?:256|384|512)$/u.test(alg);
}

function stripPrivateJwkFields(jwk: Record<string, unknown>): Record<string, unknown> {
  const publicJwk = { ...jwk };
  for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth']) {
    delete publicJwk[field];
  }
  return publicJwk;
}
