import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PACKAGE_ROOT } from '../../src/runtime/package-root';
import type { ComponentsManager } from 'componentsjs';
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

  const rejectAfterManager = (registry: Record<string, Promise<unknown>>, failure: Error): void => {
    vi.spyOn(AppRunner.prototype, 'createComponentsManager').mockResolvedValue({
      configConstructorPool: { getInstanceRegistry: () => registry },
    } as unknown as ComponentsManager<unknown>);
    vi.spyOn(AppRunner.prototype, 'create').mockImplementation(async function(this: AppRunner, input) {
      await this.createComponentsManager(input?.loaderProperties as never, []);
      throw failure;
    });
  };

  it('stops the same constructed App when upstream rejects its thread safety', async () => {
    const failure = new Error('singlethreaded-only component');
    const app = { stop: vi.fn().mockResolvedValue(undefined) };
    const unrelated = { stop: vi.fn() };
    rejectAfterManager({ 'urn:solid-server:default:App': Promise.resolve(app), other: Promise.resolve(unrelated) }, failure);
    await expect(createPackageRootPreferredAppRunner(AppRunner, PACKAGE_ROOT).create()).rejects.toBe(failure);
    expect(app.stop).toHaveBeenCalledOnce();
    expect(unrelated.stop).not.toHaveBeenCalled();
  });

  it('preserves creation and cleanup failures without claiming successful shutdown', async () => {
    const failure = new Error('validation failed');
    const cleanup = new Error('native shutdown failed');
    const app = { stop: vi.fn().mockRejectedValue(cleanup) };
    rejectAfterManager({ 'urn:solid-server:default:App': Promise.resolve(app) }, failure);
    await expect(createPackageRootPreferredAppRunner(AppRunner, PACKAGE_ROOT).create())
      .rejects.toMatchObject({ errors: [failure, cleanup] });
    expect(app.stop).toHaveBeenCalledOnce();
  });

  it('does not instantiate or blindly finalize partial dependencies when App construction rejects', async () => {
    const failure = new Error('construction failed');
    const rejected = Promise.reject(failure);
    void rejected.catch(() => undefined);
    const dependency = { finalize: vi.fn(), close: vi.fn() };
    rejectAfterManager({ 'urn:solid-server:default:App': rejected, dependency: Promise.resolve(dependency) }, failure);
    await expect(createPackageRootPreferredAppRunner(AppRunner, PACKAGE_ROOT).create()).rejects.toBe(failure);
    expect(dependency.finalize).not.toHaveBeenCalled();
    expect(dependency.close).not.toHaveBeenCalled();
  });

  it('preserves failures before any App was constructed', async () => {
    const failure = new Error('CLI resolver failed');
    rejectAfterManager({}, failure);
    await expect(createPackageRootPreferredAppRunner(AppRunner, PACKAGE_ROOT).create()).rejects.toBe(failure);
  });

  it('does not own an App from a separate public manager creation', async () => {
    const failure = new Error('failed before this creation built its manager');
    const unrelated = { stop: vi.fn() };
    vi.spyOn(AppRunner.prototype, 'createComponentsManager').mockResolvedValue({
      configConstructorPool: { getInstanceRegistry: () => ({ 'urn:solid-server:default:App': Promise.resolve(unrelated) }) },
    } as unknown as ComponentsManager<unknown>);
    vi.spyOn(AppRunner.prototype, 'create').mockRejectedValue(failure);
    const runner = createPackageRootPreferredAppRunner(AppRunner, PACKAGE_ROOT);
    await runner.createComponentsManager({} as never, []);
    await expect(runner.create()).rejects.toBe(failure);
    expect(unrelated.stop).not.toHaveBeenCalled();
  });

  it('isolates an interleaved public manager from the failing creation', async () => {
    const failure = new Error('thread safety rejected');
    const owned = { stop: vi.fn().mockResolvedValue(undefined) };
    const external = { stop: vi.fn() };
    let ready!: () => void;
    let release!: () => void;
    const ownedReady = new Promise<void>(resolve => { ready = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(AppRunner.prototype, 'createComponentsManager').mockImplementation(async (_properties, configs) => ({
      configConstructorPool: { getInstanceRegistry: () => ({ 'urn:solid-server:default:App': Promise.resolve(configs[0] === 'owned' ? owned : external) }) },
    } as unknown as ComponentsManager<unknown>));
    vi.spyOn(AppRunner.prototype, 'create').mockImplementation(async function(this: AppRunner, input) {
      await this.createComponentsManager(input?.loaderProperties as never, ['owned']);
      ready();
      await resume;
      throw failure;
    });
    const runner = createPackageRootPreferredAppRunner(AppRunner, PACKAGE_ROOT);
    const pending = runner.create();
    await ownedReady;
    await runner.createComponentsManager({} as never, ['external']);
    release();
    await expect(pending).rejects.toBe(failure);
    expect(owned.stop).toHaveBeenCalledOnce();
    expect(external.stop).not.toHaveBeenCalled();
  });

  it('rejects concurrent creation before it can replace the first App ownership', async () => {
    let release!: () => void;
    const started = new Promise<void>(resolve => { release = resolve; });
    const app = { stop: vi.fn() } as unknown as App;
    const create = vi.spyOn(AppRunner.prototype, 'create').mockImplementation(async () => { await started; return app; });
    const runner = createPackageRootPreferredAppRunner(AppRunner, PACKAGE_ROOT);
    const first = runner.create();
    await expect(runner.create()).rejects.toThrow('already in progress');
    expect(create).toHaveBeenCalledOnce();
    release();
    await expect(first).resolves.toBe(app);
    expect(app.stop).not.toHaveBeenCalled();
  });

  it('isolates a physical CSS module independently of Bun single-file mode', async () => {
    vi.stubEnv('XPOD_BUN_SINGLE_RUNTIME', '0');
    const create = vi.spyOn(AppRunner.prototype, 'create').mockResolvedValue({ start: vi.fn() } as unknown as App);
    vi.spyOn(AppRunner.prototype, 'getPackageSettings').mockResolvedValue(undefined);
    await createPackageRootPreferredAppRunner(AppRunner, PACKAGE_ROOT, { isolatedDependencies: true })
      .createCli(['node', 'css-module', '--mainModulePath', '/foreign/root']);
    const state = create.mock.calls[0][0]?.loaderProperties?.moduleState;
    expect(state?.nodeModuleImportPaths).toEqual([PACKAGE_ROOT]);
    expect(state?.mainModulePath).toBe(PACKAGE_ROOT);
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
      vi.stubEnv('XPOD_BUN_SINGLE_RUNTIME', '0');
      const state = await createPackageRootPreferredModuleState(extracted, { isolatedDependencies: true });
      expect(state.nodeModuleImportPaths).toEqual([extracted]);
      expect(Object.keys(state.packageJsons).sort()).toEqual([extracted, bundledDependency].sort());
      expect(state.componentModules[moduleIri]?.[1]).toBe(path.join(bundledDependency, 'components', 'components.jsonld'));
      expect(state.packageJsons[bundledDependency].main).toBe('dist/__bundle__.cjs');
      expect(state.importPaths['https://example.invalid/dependency/']).toBe(path.join(bundledDependency, 'components/'));
      if (process.platform !== 'win32') {
        await symlink(path.join(parent, 'node_modules', dependencyName),
          path.join(extracted, 'node_modules', 'escaped-dependency'));
        await expect(createPackageRootPreferredModuleState(extracted, { isolatedDependencies: true }))
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
