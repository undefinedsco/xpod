#!/usr/bin/env node

/**
 * Expose the core authenticated resource fetch transport hook through
 * @inrupt/solid-client-authn-browser Session options. Inrupt core 3.1.1 already
 * supports buildAuthenticatedFetch({ fetch }), but the browser package does not
 * pass a caller-provided transport into the redirect-created authenticated fetch.
 *
 * Resource DPoP proofs also bind core's current access token using RFC 9449 ath.
 * This patch is deliberately pinned to the installed browser/core version and fails
 * loudly if upstream changes the target shape.
 */

const fs = require('fs');
const path = require('path');

const SUPPORTED_VERSION = '3.1.1';
const TRANSPORT_MARKER = 'XPOD_INRUPT_AUTHN_BROWSER_FETCH_TRANSPORT';
const RESOURCE_DPOP_MARKER = 'XPOD_INRUPT_RESOURCE_DPOP_ATH';

function replaceOnce(content, search, replacement, label) {
  const first = content.indexOf(search);
  if (first < 0) {
    throw new Error(`Unable to find ${label}`);
  }
  if (content.indexOf(search, first + search.length) >= 0) {
    throw new Error(`Found multiple matches for ${label}`);
  }
  return content.slice(0, first) + replacement + content.slice(first + search.length);
}

function patchSessionSource(content) {
  if (content.includes(TRANSPORT_MARKER)) return content;

  content = replaceOnce(
    content,
    '  clientAuthentication: ClientAuthentication;\n',
    '  clientAuthentication: ClientAuthentication;\n' +
      '  /**\n' +
      '   * Optional transport used only for authenticated Solid resource requests.\n' +
      '   * OAuth discovery, token exchange, and token refresh requests keep using\n' +
      '   * the browser package defaults.\n' +
      '   */\n' +
      '  fetch?: typeof fetch;\n',
    'TypeScript Session option fetch hook',
  );
  content = replaceOnce(
    content,
    '      this.clientAuthentication = getClientAuthenticationWithDependencies({\n        secureStorage: sessionOptions.secureStorage,\n        insecureStorage: sessionOptions.insecureStorage,\n      });\n',
    '      this.clientAuthentication = getClientAuthenticationWithDependencies({\n' +
      '        secureStorage: sessionOptions.secureStorage,\n' +
      '        insecureStorage: sessionOptions.insecureStorage,\n' +
      '        fetch: sessionOptions.fetch,\n' +
      '      });\n',
    'TypeScript Session storage dependency fetch hook',
  );
  content = replaceOnce(
    content,
    '      this.clientAuthentication = getClientAuthenticationWithDependencies({});\n',
    '      this.clientAuthentication = getClientAuthenticationWithDependencies({\n' +
      '        fetch: sessionOptions.fetch,\n' +
      '      });\n',
    'TypeScript Session default dependency fetch hook',
  );
  return `${content}\n// ${TRANSPORT_MARKER}\n`;
}

function patchDependenciesSource(content) {
  if (content.includes(TRANSPORT_MARKER)) return content;

  content = replaceOnce(
    content,
    '  insecureStorage?: IStorage;\n',
    '  insecureStorage?: IStorage;\n' +
      '  fetch?: typeof fetch;\n',
    'TypeScript dependencies fetch option',
  );
  content = replaceOnce(
    content,
    '    new AuthCodeRedirectHandler(\n      storageUtility,\n      sessionInfoManager,\n      issuerConfigFetcher,\n      clientRegistrar,\n      tokenRefresher,\n    ),\n',
    '    new AuthCodeRedirectHandler(\n' +
      '      storageUtility,\n' +
      '      sessionInfoManager,\n' +
      '      issuerConfigFetcher,\n' +
      '      clientRegistrar,\n' +
      '      tokenRefresher,\n' +
      '      dependencies.fetch,\n' +
      '    ),\n',
    'TypeScript redirect handler fetch dependency',
  );
  return `${content}\n// ${TRANSPORT_MARKER}\n`;
}

function patchHandlerSource(content) {
  if (content.includes(TRANSPORT_MARKER)) return content;

  content = replaceOnce(
    content,
    '    private tokerRefresher: ITokenRefresher,\n',
    '    private tokerRefresher: ITokenRefresher,\n' +
      '    private fetch?: typeof fetch,\n',
    'TypeScript handler constructor fetch parameter',
  );
  content = replaceOnce(
    content,
    '    this.tokerRefresher = tokerRefresher;\n',
    '    this.tokerRefresher = tokerRefresher;\n' +
      '    this.fetch = fetch;\n',
    'TypeScript handler fetch assignment',
  );
  content = replaceOnce(
    content,
    '      expiresIn: tokens.expiresIn,\n    });\n',
    '      expiresIn: tokens.expiresIn,\n' +
      '      fetch: this.fetch,\n' +
      '    });\n',
    'TypeScript authenticated fetch transport option',
  );
  return `${content}\n// ${TRANSPORT_MARKER}\n`;
}

function patchBundle(content) {
  if (content.includes(TRANSPORT_MARKER)) return content;

  content = replaceOnce(
    content,
    '    tokerRefresher;\n    constructor(storageUtility, sessionInfoManager, issuerConfigFetcher, clientRegistrar, tokerRefresher) {\n',
    '    tokerRefresher;\n' +
      '    fetch;\n' +
      '    constructor(storageUtility, sessionInfoManager, issuerConfigFetcher, clientRegistrar, tokerRefresher, fetch) {\n',
    'bundle handler constructor fetch parameter',
  );
  content = replaceOnce(
    content,
    '        this.tokerRefresher = tokerRefresher;\n        this.storageUtility = storageUtility;\n',
    '        this.tokerRefresher = tokerRefresher;\n' +
      '        this.fetch = fetch;\n' +
      '        this.storageUtility = storageUtility;\n',
    'bundle handler fetch assignment',
  );
  content = replaceOnce(
    content,
    '            expiresIn: tokens.expiresIn,\n        });\n',
    '            expiresIn: tokens.expiresIn,\n' +
      '            fetch: this.fetch,\n' +
      '        });\n',
    'bundle authenticated fetch transport option',
  );
  content = replaceOnce(
    content,
    '        new AuthCodeRedirectHandler(storageUtility, sessionInfoManager, issuerConfigFetcher, clientRegistrar, tokenRefresher),\n',
    '        new AuthCodeRedirectHandler(storageUtility, sessionInfoManager, issuerConfigFetcher, clientRegistrar, tokenRefresher, dependencies.fetch),\n',
    'bundle redirect handler fetch dependency',
  );
  content = replaceOnce(
    content,
    '                insecureStorage: sessionOptions.insecureStorage,\n            });\n',
    '                insecureStorage: sessionOptions.insecureStorage,\n' +
      '                fetch: sessionOptions.fetch,\n' +
      '            });\n',
    'bundle Session storage dependency fetch hook',
  );
  content = replaceOnce(
    content,
    '            this.clientAuthentication = getClientAuthenticationWithDependencies({});\n',
    '            this.clientAuthentication = getClientAuthenticationWithDependencies({\n' +
      '                fetch: sessionOptions.fetch,\n' +
      '            });\n',
    'bundle Session default dependency fetch hook',
  );
  return `${content}\n// ${TRANSPORT_MARKER}\n`;
}

function patchSessionDts(content) {
  if (content.includes(TRANSPORT_MARKER)) return content;

  content = replaceOnce(
    content,
    '    clientAuthentication: ClientAuthentication;\n',
    '    clientAuthentication: ClientAuthentication;\n' +
      '    /**\n' +
      '     * Optional transport used only for authenticated Solid resource requests.\n' +
      '     */\n' +
      '    fetch?: typeof fetch;\n',
    'Session.d.ts fetch option',
  );
  return `${content}\n// ${TRANSPORT_MARKER}\n`;
}

function patchDependenciesDts(content) {
  if (content.includes(TRANSPORT_MARKER)) return content;

  content = replaceOnce(
    content,
    '    insecureStorage?: IStorage;\n',
    '    insecureStorage?: IStorage;\n' +
      '    fetch?: typeof fetch;\n',
    'dependencies.d.ts fetch option',
  );
  return `${content}\n// ${TRANSPORT_MARKER}\n`;
}

function patchHandlerDts(content) {
  if (content.includes(TRANSPORT_MARKER)) return content;

  content = replaceOnce(
    content,
    '    private tokerRefresher;\n    constructor(storageUtility: IStorageUtility, sessionInfoManager: ISessionInfoManager, issuerConfigFetcher: IIssuerConfigFetcher, clientRegistrar: IClientRegistrar, tokerRefresher: ITokenRefresher);\n',
    '    private tokerRefresher;\n' +
      '    private fetch?;\n' +
      '    constructor(storageUtility: IStorageUtility, sessionInfoManager: ISessionInfoManager, issuerConfigFetcher: IIssuerConfigFetcher, clientRegistrar: IClientRegistrar, tokerRefresher: ITokenRefresher, fetch?: typeof fetch);\n',
    'handler.d.ts fetch parameter',
  );
  return `${content}\n// ${TRANSPORT_MARKER}\n`;
}

// Resource requests have an access token; OAuth token-endpoint proofs do not.
// Keep the hash inside core's signer so refresh and redirect use the same token
// that buildAuthenticatedFetch places in Authorization on that dispatch.
function patchResourceDpop(content, kind) {
  const source = kind === 'source';
  const factory = kind === 'factory';
  const dts = kind === 'dts';
  const bundle = kind === 'cjs' || kind === 'esm';
  const digest = 'await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken))';
  const browserDigest = `new Uint8Array(${digest})`;
  const expected = dts ? 'accessToken?: string' : factory
    ? 'dpopKey, authToken)' : bundle
      ? 'dpopKey, authToken)' : 'accessToken?: string';
  if (content.includes(RESOURCE_DPOP_MARKER)) {
    if (content.split(RESOURCE_DPOP_MARKER).length !== 2 || !content.includes(expected) ||
        (!factory && !dts && !content.includes(digest))) {
      throw new Error(`Incomplete ${RESOURCE_DPOP_MARKER}: ${kind}`);
    }
    // Upgrade the same pinned hunk: browser JOSE accepts Uint8Array, whereas
    // Node's Buffer-based encoder also accepts the digest's raw ArrayBuffer.
    if ((source || bundle) && !content.includes(browserDigest)) {
      return replaceOnce(content, digest, browserDigest, 'browser digest bytes');
    }
    return content;
  }
  if (source) {
    content = replaceOnce(content, 'SignJWT, generateKeyPair, exportJWK',
      'SignJWT, generateKeyPair, exportJWK, base64url', 'source hash encoding import');
    content = replaceOnce(content, '  dpopKey: KeyPair,\n): Promise<string>',
      '  dpopKey: KeyPair,\n  accessToken?: string,\n): Promise<string>', 'optional source resource token');
  } else if (dts) {
    content = replaceOnce(content, 'dpopKey: KeyPair): Promise<string>',
      'dpopKey: KeyPair, accessToken?: string): Promise<string>', 'optional declaration resource token');
  } else if (bundle) {
    content = replaceOnce(content, 'async function createDpopHeader(audience, method, dpopKey)',
      'async function createDpopHeader(audience, method, dpopKey, accessToken)', 'optional bundle resource token');
    if (kind === 'esm') content = replaceOnce(content,
      'SignJWT, generateKeyPair } from \'jose\';',
      'SignJWT, generateKeyPair, base64url } from \'jose\';', 'bundle hash encoding import');
  }
  if (source || bundle) {
    const indent = source ? '    ' : '        ';
    const encoder = kind === 'cjs' ? 'jose.base64url' : 'base64url';
    const jti = source ? 'v4()' : kind === 'cjs' ? 'uuid.v4()' : 'v4()';
    content = replaceOnce(content, `${indent}jti: ${jti},\n`,
      `${indent}jti: ${jti},\n` +
      `${indent}...(accessToken === undefined ? {} : { ath: ${encoder}.encode(\n` +
      `${indent}    ${browserDigest}\n` +
      `${indent}) }),\n`, 'resource access token hash');
  }
  if (factory || bundle) content = replaceOnce(content,
    'createDpopHeader(targetUrl, defaultOptions?.method ?? "get", dpopKey)',
    'createDpopHeader(targetUrl, defaultOptions?.method ?? "get", dpopKey, authToken)', 'resource token passed to signer');
  return `${content}\n// ${RESOURCE_DPOP_MARKER}\n`;
}

function patchInstalledCore(repositoryRoot) {
  const packageRoot = path.join(repositoryRoot, 'node_modules', '@inrupt', 'solid-client-authn-core');
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.version !== SUPPORTED_VERSION) throw new Error(`Unsupported @inrupt/solid-client-authn-core ${manifest.version}; expected ${SUPPORTED_VERSION}`);
  const targets = [
    ['src/authenticatedFetch/dpopUtils.ts', 'source'],
    ['src/authenticatedFetch/fetchFactory.ts', 'factory'],
    ['dist/authenticatedFetch/dpopUtils.d.ts', 'dts'],
    ['dist/index.js', 'cjs'],
    ['dist/index.mjs', 'esm'],
  ];
  // Validate every pinned shape before writing any installed core file.
  const updates = targets.map(([file, kind]) => {
    const target = path.join(packageRoot, file);
    const original = fs.readFileSync(target, 'utf8');
    return { target, original, updated: patchResourceDpop(original, kind) };
  });
  let patched = 0;
  for (const { target, original, updated } of updates) {
    if (original !== updated) { fs.writeFileSync(target, updated); patched += 1; }
  }
  return { patched, alreadyPatched: updates.length - patched };
}

function patchInstalledPackage(repositoryRoot = path.join(__dirname, '..')) {
  const packageRoot = path.join(
    repositoryRoot,
    'node_modules',
    '@inrupt',
    'solid-client-authn-browser',
  );
  const packageJsonPath = path.join(packageRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    console.log('[patch-inrupt-authn-transport] package not installed, skipping');
    return { patched: 0, alreadyPatched: 0 };
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (packageJson.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported @inrupt/solid-client-authn-browser ${packageJson.version}; expected ${SUPPORTED_VERSION}`,
    );
  }

  const targets = [
    ['src/Session.ts', patchSessionSource],
    ['src/dependencies.ts', patchDependenciesSource],
    ['src/login/oidc/incomingRedirectHandler/AuthCodeRedirectHandler.ts', patchHandlerSource],
    ['dist/index.js', patchBundle],
    ['dist/index.mjs', patchBundle],
    ['dist/Session.d.ts', patchSessionDts],
    ['dist/dependencies.d.ts', patchDependenciesDts],
    ['dist/login/oidc/incomingRedirectHandler/AuthCodeRedirectHandler.d.ts', patchHandlerDts],
  ];
  let patched = 0;
  let alreadyPatched = 0;
  for (const [relativePath, patcher] of targets) {
    const targetPath = path.join(packageRoot, relativePath);
    const original = fs.readFileSync(targetPath, 'utf8');
    const updated = patcher(original);
    if (updated === original) {
      alreadyPatched += 1;
    } else {
      fs.writeFileSync(targetPath, updated);
      patched += 1;
    }
  }
  const core = patchInstalledCore(repositoryRoot);
  patched += core.patched;
  alreadyPatched += core.alreadyPatched;
  console.log(
    `[patch-inrupt-authn-transport] Patched ${patched}; ${alreadyPatched} already patched`,
  );
  return { patched, alreadyPatched };
}

module.exports = {
  TRANSPORT_MARKER,
  RESOURCE_DPOP_MARKER,
  patchResourceDpop,
  patchBundle,
  patchDependenciesDts,
  patchDependenciesSource,
  patchHandlerDts,
  patchHandlerSource,
  patchInstalledPackage,
  patchSessionDts,
  patchSessionSource,
};

if (require.main === module) {
  try {
    patchInstalledPackage();
  } catch (error) {
    console.error('[patch-inrupt-authn-transport] Failed:', error.message);
    process.exit(1);
  }
}
