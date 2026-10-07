import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PACKAGE_ROOT } from '../../src/runtime/package-root';
import { AppRunner, type App } from '@solid/community-server';
import { createPackageRootPreferredModuleState, createPackageRootPreferredAppRunner } from '../../src/runtime/runner/node/CommunitySolidServerCssRunner';

const originalBun = (globalThis as { Bun?: unknown }).Bun;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (originalBun === undefined) {
    delete (globalThis as { Bun?: unknown }).Bun;
  } else {
    (globalThis as { Bun?: unknown }).Bun = originalBun;
  }
});

describe('CommunitySolidServerCssRunner module loading', () => {
  it('injects the extracted module state through the real CSS CLI parser and preserves parsed inputs', async () => {
    vi.stubEnv('XPOD_BUN_SINGLE_RUNTIME', '1');
    const app = { start: vi.fn() } as unknown as App;
    const create = vi.spyOn(AppRunner.prototype, 'create').mockResolvedValue(app);
    vi.spyOn(AppRunner.prototype, 'getPackageSettings').mockResolvedValue({ port: 43210 });
    const argv = ['bun', 'xpod', '--config', 'fixture-config.json', '--mainModulePath', '/foreign/root', '--loggingLevel', 'warn'];
    await createPackageRootPreferredAppRunner(AppRunner, PACKAGE_ROOT).runCli(argv);
    expect(create).toHaveBeenCalledOnce();
    const input = create.mock.calls[0][0]!;
    expect(input).toMatchObject({ config: ['fixture-config.json'], argv, shorthand: { port: 43210 } });
    expect(input.loaderProperties).toMatchObject({ mainModulePath: PACKAGE_ROOT, logLevel: 'warn' });
    expect(input.loaderProperties?.moduleState?.nodeModuleImportPaths).toEqual([PACKAGE_ROOT]);
    expect(app.start).toHaveBeenCalledOnce();
  });

  it('leaves the official development CLI loader behavior intact', async () => {
    vi.stubEnv('XPOD_BUN_SINGLE_RUNTIME', '0');
    const create = vi.spyOn(AppRunner.prototype, 'create').mockResolvedValue({ start: vi.fn() } as unknown as App);
    vi.spyOn(AppRunner.prototype, 'getPackageSettings').mockResolvedValue(undefined);
    await createPackageRootPreferredAppRunner(AppRunner, PACKAGE_ROOT)
      .createCli(['node', 'xpod', '--mainModulePath', '/development/root']);
    expect(create.mock.calls[0][0]?.loaderProperties).toMatchObject({ mainModulePath: '/development/root' });
    expect(create.mock.calls[0][0]?.loaderProperties?.moduleState).toBeUndefined();
  });
  it('discovers every single-file component only inside its extracted package, even beneath a workspace', async () => {
    const fixtures = path.join(PACKAGE_ROOT, '.test-data', 'extracted-component-discovery');
    await mkdir(fixtures, { recursive: true });
    const parent = await mkdtemp(path.join(fixtures, 'ancestor-'));
    const extracted = path.join(parent, 'private-cache', 'package');
    const dependencyName = 'fixture-component-dependency';
    const moduleIri = 'https://example.invalid/components/dependency';
    const writePackage = async (directory: string, version: string, main: string): Promise<void> => {
      await mkdir(path.join(directory, 'components'), { recursive: true });
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({
        name: dependencyName, version, main, 'lsd:module': moduleIri,
        'lsd:components': 'components/components.jsonld',
        'lsd:contexts': { 'https://example.invalid/dependency/context': 'components/context.jsonld' },
        'lsd:importPaths': { 'https://example.invalid/dependency/': 'components/' },
      }));
      await writeFile(path.join(directory, 'components', 'components.jsonld'), '{}');
      await writeFile(path.join(directory, 'components', 'context.jsonld'), '{"@context":{}}');
    };
    try {
      await mkdir(extracted, { recursive: true });
      await writeFile(path.join(extracted, 'package.json'), '{"name":"extracted-test-runtime","version":"1.0.0"}');
      const bundledDependency = path.join(extracted, 'node_modules', dependencyName);
      await writePackage(bundledDependency, '1.0.0', 'dist/__bundle__.cjs');
      await writePackage(path.join(parent, 'node_modules', dependencyName), '1.1.0', 'dist/foreign.js');
      vi.stubEnv('XPOD_BUN_SINGLE_RUNTIME', '1');
      const state = await createPackageRootPreferredModuleState(extracted);
      expect(state.nodeModuleImportPaths).toEqual([extracted]);
      expect(Object.keys(state.packageJsons).sort()).toEqual([extracted, bundledDependency].sort());
      expect(state.componentModules[moduleIri]?.[1]).toBe(path.join(bundledDependency, 'components', 'components.jsonld'));
      expect(state.packageJsons[bundledDependency].main).toBe('dist/__bundle__.cjs');
      expect(state.importPaths['https://example.invalid/dependency/']).toBe(path.join(bundledDependency, 'components/'));
      if (process.platform !== 'win32') {
        await symlink(path.join(parent, 'node_modules', dependencyName),
          path.join(extracted, 'node_modules', 'escaped-dependency'));
        await expect(createPackageRootPreferredModuleState(extracted))
          .rejects.toThrow('Extracted Components dependency is outside its packaged runtime');
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
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
