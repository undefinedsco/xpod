#!/usr/bin/env node

/**
 * Expose the core authenticated resource fetch transport hook through
 * @inrupt/solid-client-authn-browser Session options. Inrupt core 3.1.1 already
 * supports buildAuthenticatedFetch({ fetch }), but the browser package does not
 * pass a caller-provided transport into the redirect-created authenticated fetch.
 *
 * This patch is deliberately pinned to the installed browser version and fails
 * loudly if upstream changes the target shape.
 */

const fs = require('fs');
const path = require('path');

const SUPPORTED_VERSION = '3.1.1';
const TRANSPORT_MARKER = 'XPOD_INRUPT_AUTHN_BROWSER_FETCH_TRANSPORT';

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
  console.log(
    `[patch-inrupt-authn-transport] Patched ${patched}; ${alreadyPatched} already patched`,
  );
  return { patched, alreadyPatched };
}

module.exports = {
  TRANSPORT_MARKER,
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
