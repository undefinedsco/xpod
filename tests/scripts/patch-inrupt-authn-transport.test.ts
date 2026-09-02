import { execFile as execFileCallback } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { decodeJwt } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/patch-inrupt-authn-transport.js');
const browserRoot = path.join(repoRoot, 'node_modules/@inrupt/solid-client-authn-browser');
const coreRoot = path.join(repoRoot, 'node_modules/@inrupt/solid-client-authn-core');
const oidcRoot = path.join(repoRoot, 'node_modules/@inrupt/oidc-client-ext');

const {
  TRANSPORT_MARKER,
  patchBundle,
  patchDependenciesDts,
  patchDependenciesSource,
  patchHandlerDts,
  patchHandlerSource,
  patchInstalledPackage,
  patchSessionDts,
  patchSessionSource,
} = require('../../scripts/patch-inrupt-authn-transport.js');

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-inrupt-transport-'));
  tempRoots.push(root);
  return root;
}

async function writePackageFixture(root: string, version = '3.1.1'): Promise<void> {
  const packageRoot = path.join(root, 'node_modules/@inrupt/solid-client-authn-browser');
  await mkdir(path.join(packageRoot, 'src/login/oidc/incomingRedirectHandler'), { recursive: true });
  await mkdir(path.join(packageRoot, 'dist/login/oidc/incomingRedirectHandler'), { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ version }));
  await writeFile(path.join(packageRoot, 'src/Session.ts'), [
    '  clientAuthentication: ClientAuthentication;\n',
    '      this.clientAuthentication = getClientAuthenticationWithDependencies({\n        secureStorage: sessionOptions.secureStorage,\n        insecureStorage: sessionOptions.insecureStorage,\n      });\n',
    '      this.clientAuthentication = getClientAuthenticationWithDependencies({});\n',
  ].join(''));
  await writeFile(path.join(packageRoot, 'src/dependencies.ts'), [
    '  insecureStorage?: IStorage;\n',
    '    new AuthCodeRedirectHandler(\n      storageUtility,\n      sessionInfoManager,\n      issuerConfigFetcher,\n      clientRegistrar,\n      tokenRefresher,\n    ),\n',
  ].join(''));
  await writeFile(path.join(packageRoot, 'src/login/oidc/incomingRedirectHandler/AuthCodeRedirectHandler.ts'), [
    '    private tokerRefresher: ITokenRefresher,\n',
    '    this.tokerRefresher = tokerRefresher;\n',
    '      expiresIn: tokens.expiresIn,\n    });\n',
  ].join(''));
  await writeFile(path.join(packageRoot, 'dist/index.js'), [
    '    tokerRefresher;\n    constructor(storageUtility, sessionInfoManager, issuerConfigFetcher, clientRegistrar, tokerRefresher) {\n',
    '        this.tokerRefresher = tokerRefresher;\n        this.storageUtility = storageUtility;\n',
    '            expiresIn: tokens.expiresIn,\n        });\n',
    '        new AuthCodeRedirectHandler(storageUtility, sessionInfoManager, issuerConfigFetcher, clientRegistrar, tokenRefresher),\n',
    '                insecureStorage: sessionOptions.insecureStorage,\n            });\n',
    '            this.clientAuthentication = getClientAuthenticationWithDependencies({});\n',
  ].join(''));
  await writeFile(path.join(packageRoot, 'dist/index.mjs'), await readFile(path.join(packageRoot, 'dist/index.js'), 'utf8'));
  await writeFile(path.join(packageRoot, 'dist/Session.d.ts'), '    clientAuthentication: ClientAuthentication;\n');
  await writeFile(path.join(packageRoot, 'dist/dependencies.d.ts'), '    insecureStorage?: IStorage;\n');
  await writeFile(
    path.join(packageRoot, 'dist/login/oidc/incomingRedirectHandler/AuthCodeRedirectHandler.d.ts'),
    '    private tokerRefresher;\n    constructor(storageUtility: IStorageUtility, sessionInfoManager: ISessionInfoManager, issuerConfigFetcher: IIssuerConfigFetcher, clientRegistrar: IClientRegistrar, tokerRefresher: ITokenRefresher);\n',
  );
}

async function linkRuntimeDependencies(root: string): Promise<void> {
  await mkdir(path.join(root, 'node_modules/@inrupt'), { recursive: true });
  await symlink(coreRoot, path.join(root, 'node_modules/@inrupt/solid-client-authn-core'));
  await symlink(oidcRoot, path.join(root, 'node_modules/@inrupt/oidc-client-ext'));
  for (const dependency of [ 'events', 'jose', 'uuid' ]) {
    await symlink(path.join(repoRoot, 'node_modules', dependency), path.join(root, 'node_modules', dependency));
  }
}

describe('Inrupt browser auth transport patch', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('documents the 3.1.1 browser gap and patches source files idempotently', async () => {
    const sessionSource = await readFile(path.join(browserRoot, 'src/Session.ts'), 'utf8');
    const dependenciesSource = await readFile(path.join(browserRoot, 'src/dependencies.ts'), 'utf8');
    const handlerSource = await readFile(
      path.join(browserRoot, 'src/login/oidc/incomingRedirectHandler/AuthCodeRedirectHandler.ts'),
      'utf8',
    );

    const unpatchedSession = sessionSource.includes(TRANSPORT_MARKER)
      ? sessionSource
      : patchSessionSource(sessionSource);
    const unpatchedDependencies = dependenciesSource.includes(TRANSPORT_MARKER)
      ? dependenciesSource
      : patchDependenciesSource(dependenciesSource);
    const unpatchedHandler = handlerSource.includes(TRANSPORT_MARKER)
      ? handlerSource
      : patchHandlerSource(handlerSource);

    if (!sessionSource.includes(TRANSPORT_MARKER)) {
      expect(sessionSource).not.toContain('fetch?: typeof fetch;');
    }
    expect(unpatchedSession).toContain('fetch?: typeof fetch;');
    expect(unpatchedSession).toContain('fetch: sessionOptions.fetch');
    expect(patchSessionSource(unpatchedSession)).toBe(unpatchedSession);

    expect(unpatchedDependencies).toContain('fetch?: typeof fetch;');
    expect(unpatchedDependencies).toContain('tokenRefresher,\n      dependencies.fetch');
    expect(patchDependenciesSource(unpatchedDependencies)).toBe(unpatchedDependencies);

    expect(unpatchedHandler).toContain('private fetch?: typeof fetch');
    expect(unpatchedHandler).toContain('fetch: this.fetch');
    expect(patchHandlerSource(unpatchedHandler)).toBe(unpatchedHandler);
  });

  it('patches distributed CJS and ESM bundle shapes consistently', async () => {
    for (const filename of [ 'index.js', 'index.mjs' ]) {
      const bundle = await readFile(path.join(browserRoot, 'dist', filename), 'utf8');
      const patched = patchBundle(bundle);

      expect(patched).toContain('constructor(storageUtility, sessionInfoManager, issuerConfigFetcher, clientRegistrar, tokerRefresher, fetch)');
      expect(patched).toContain('fetch: this.fetch');
      expect(patched).toContain('tokenRefresher, dependencies.fetch');
      expect(patched).toContain('fetch: sessionOptions.fetch');
      expect(patchBundle(patched)).toBe(patched);
    }
  });

  it('patches public and handler type declarations idempotently', async () => {
    const sessionDts = patchSessionDts(await readFile(path.join(browserRoot, 'dist/Session.d.ts'), 'utf8'));
    const dependenciesDts = patchDependenciesDts(await readFile(path.join(browserRoot, 'dist/dependencies.d.ts'), 'utf8'));
    const handlerDts = patchHandlerDts(await readFile(
      path.join(browserRoot, 'dist/login/oidc/incomingRedirectHandler/AuthCodeRedirectHandler.d.ts'),
      'utf8',
    ));

    expect(sessionDts).toContain('fetch?: typeof fetch;');
    expect(dependenciesDts).toContain('fetch?: typeof fetch;');
    expect(handlerDts).toContain('fetch?: typeof fetch');
    expect(patchSessionDts(sessionDts)).toBe(sessionDts);
    expect(patchDependenciesDts(dependenciesDts)).toBe(dependenciesDts);
    expect(patchHandlerDts(handlerDts)).toBe(handlerDts);
  });

  it('applies only to the pinned browser package version and is idempotent', async () => {
    const root = await makeTempRoot();
    await writePackageFixture(root);

    expect(patchInstalledPackage(root)).toEqual({ patched: 8, alreadyPatched: 0 });
    expect(patchInstalledPackage(root)).toEqual({ patched: 0, alreadyPatched: 8 });

    const packageRoot = path.join(root, 'node_modules/@inrupt/solid-client-authn-browser');
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ version: '3.1.2' }));
    expect(() => patchInstalledPackage(root)).toThrow('Unsupported @inrupt/solid-client-authn-browser 3.1.2; expected 3.1.1');
  });

  it('keeps custom clientAuthentication injection in charge of Session.fetch', async () => {
    const { Session } = require(path.join(browserRoot, 'dist/index.js'));
    const transportFetch = vi.fn();
    const clientAuthenticationFetch = vi.fn().mockResolvedValue(new Response('ok'));
    const session = new Session({
      fetch: transportFetch,
      clientAuthentication: {
        fetch: clientAuthenticationFetch,
        handleIncomingRedirect: vi.fn(),
        login: vi.fn(),
        logout: vi.fn().mockResolvedValue(undefined),
        validateCurrentSession: vi.fn(),
      },
    });

    await session.fetch('https://resource.example/private');

    expect(clientAuthenticationFetch).toHaveBeenCalledWith('https://resource.example/private', undefined);
    expect(transportFetch).not.toHaveBeenCalled();
  });

  it('uses the same patched package surface from CJS and ESM', async () => {
    const root = await makeTempRoot();
    await linkRuntimeDependencies(root);
    const packageRoot = path.join(root, 'node_modules/@inrupt/solid-client-authn-browser');
    await mkdir(path.dirname(packageRoot), { recursive: true });
    await symlink(browserRoot, packageRoot);

    const cjs = require(path.join(packageRoot, 'dist/index.js'));
    const esm = await import(path.join(packageRoot, 'dist/index.mjs'));

    expect(typeof cjs.Session).toBe('function');
    expect(typeof esm.Session).toBe('function');
    expect(await readFile(path.join(packageRoot, 'dist/index.js'), 'utf8')).toContain(TRANSPORT_MARKER);
    expect(await readFile(path.join(packageRoot, 'dist/index.mjs'), 'utf8')).toContain(TRANSPORT_MARKER);
  });

  it('sends DPoP-protected resource requests through the transport hook without changing htu', async () => {
    const { buildAuthenticatedFetch, createDpopHeader, generateDpopKeyPair } = require(path.join(coreRoot, 'dist/index.js'));
    const dpopKey = await generateDpopKeyPair();
    const transportFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const resourceUrl = new URL('https://pod.example/alice/private.ttl?view=raw');
    const authenticatedFetch = buildAuthenticatedFetch('access-token', {
      dpopKey,
      fetch: transportFetch,
    });

    await authenticatedFetch(resourceUrl, { method: 'PATCH' });

    expect(transportFetch).toHaveBeenCalledTimes(1);
    const [input, init] = transportFetch.mock.calls[0] as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(input).toBe(resourceUrl);
    expect(headers.get('Authorization')).toBe('DPoP access-token');
    const dpop = headers.get('DPoP');
    expect(dpop).toBeTruthy();
    const expectedDpop = await createDpopHeader(resourceUrl.toString(), 'PATCH', dpopKey);
    expect(decodeJwt(dpop!).htu).toBe(decodeJwt(expectedDpop).htu);
    expect(decodeJwt(dpop!).htm).toBe('PATCH');
  });

  it('runs the patch script successfully against the installed browser package', async () => {
    const { stdout } = await execFile(process.execPath, [ scriptPath ], { cwd: repoRoot });

    expect(stdout).toMatch(/\[patch-inrupt-authn-transport\] Patched \d+; \d+ already patched/);
  });
});
