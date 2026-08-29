import { afterEach, describe, expect, it, vi } from 'vitest';
import { PACKAGE_ROOT } from '../../src/runtime/package-root';
import { createPackageRootPreferredModuleState } from '../../src/runtime/runner/node/CommunitySolidServerCssRunner';

const originalBun = (globalThis as { Bun?: unknown }).Bun;

afterEach(() => {
  if (originalBun === undefined) {
    delete (globalThis as { Bun?: unknown }).Bun;
  } else {
    (globalThis as { Bun?: unknown }).Bun = originalBun;
  }
});

describe('CommunitySolidServerCssRunner module loading', () => {
  it('prefers the current package root components over same-version parent workspace packages', async () => {
    const moduleState = await createPackageRootPreferredModuleState(PACKAGE_ROOT);
    const moduleIri = 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod';
    const contextIri = 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/components/context.jsonld';
    const componentsImportIri = 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/components/';

    expect(moduleState.componentModules[moduleIri]?.[0]).toBe(`${PACKAGE_ROOT}/dist/components/components.jsonld`);
    expect(moduleState.contexts[contextIri]).toEqual(expect.objectContaining({
      '@context': expect.any(Array),
    }));
    expect(moduleState.importPaths[componentsImportIri]).toBe(`${PACKAGE_ROOT}/dist/components/`);
  });

  it('patches CSS JWK generation under Bun to use extractable Node keys', async () => {
    vi.resetModules();
    (globalThis as { Bun?: unknown }).Bun = {};
    const { ensureBunCommunitySolidServerJwkCompat } = await import('../../src/runtime/compat/ensureBunUndiciCompat');
    const writes: Array<{ key: string; value: { keys: Record<string, unknown>[] } }> = [];

    class CachedJwkGenerator {
      public readonly alg = 'ES256';
      public readonly key = 'solid:jwks';
      public privateJwk?: Record<string, unknown>;
      public publicJwk?: Record<string, unknown>;
      public readonly storage = {
        get: async (): Promise<{ keys?: Record<string, unknown>[] } | undefined> => undefined,
        set: async (key: string, value: { keys: Record<string, unknown>[] }): Promise<void> => {
          writes.push({ key, value });
        },
      };

      public async getPrivateKey(): Promise<Record<string, unknown>> {
        throw new Error('unpatched private key generator should not run');
      }

      public async getPublicKey(): Promise<Record<string, unknown>> {
        throw new Error('unpatched public key generator should not run');
      }
    }

    ensureBunCommunitySolidServerJwkCompat({ CachedJwkGenerator });

    const generator = new CachedJwkGenerator();
    const privateJwk = await generator.getPrivateKey();
    const publicJwk = await generator.getPublicKey();

    expect(privateJwk).toEqual(expect.objectContaining({
      alg: 'ES256',
      crv: 'P-256',
      d: expect.any(String),
      kty: 'EC',
      x: expect.any(String),
      y: expect.any(String),
    }));
    expect(publicJwk).toEqual(expect.objectContaining({
      alg: 'ES256',
      crv: 'P-256',
      kty: 'EC',
      x: expect.any(String),
      y: expect.any(String),
    }));
    expect(publicJwk).not.toHaveProperty('d');
    expect(writes).toEqual([{
      key: 'solid:jwks',
      value: { keys: [privateJwk] },
    }]);
  });
});
