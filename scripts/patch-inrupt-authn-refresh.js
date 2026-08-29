#!/usr/bin/env node

/**
 * Keep an active browser Solid session alive when a proactive token refresh
 * temporarily fails (for example while macOS is asleep or the local IdP is
 * restarting). Inrupt currently stops scheduling refreshes after any thrown
 * error, including network errors. See:
 * https://github.com/inrupt/solid-client-authn-js/issues/3443
 *
 * This patch is deliberately pinned to the installed core version and fails
 * loudly if upstream changes the target shape.
 */

const fs = require('fs');
const path = require('path');

const SUPPORTED_VERSION = '3.1.1';
const RETRY_MARKER = 'XPOD_REFRESH_RETRY_MAX_DELAY_MS';

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

function patchSource(content) {
  if (content.includes(RETRY_MARKER)) return content;

  content = replaceOnce(
    content,
    '  let latestTimeout: Parameters<typeof clearTimeout>[0];\n',
    '  let latestTimeout: Parameters<typeof clearTimeout>[0];\n' +
      '  let refreshRetryAttempt = 0;\n' +
      '  const XPOD_REFRESH_RETRY_MAX_DELAY_MS = 60_000;\n',
    'TypeScript refresh state',
  );
  content = replaceOnce(
    content,
    '        currentAccessToken = refreshedAccessToken;\n',
    '        currentAccessToken = refreshedAccessToken;\n' +
      '        refreshRetryAttempt = 0;\n',
    'TypeScript refresh success',
  );
  content = replaceOnce(
    content,
    '        if (e instanceof OidcProviderError) {\n',
    '        const terminalProviderError =\n' +
      '          e instanceof OidcProviderError &&\n' +
      '          e.error !== "server_error" &&\n' +
      '          e.error !== "temporarily_unavailable";\n' +
      '        if (terminalProviderError) {\n',
    'TypeScript provider error classification',
  );
  content = replaceOnce(
    content,
    '        if (\n          e instanceof InvalidResponseError &&\n          e.missingFields.includes("access_token")\n        ) {\n',
    '        const invalidTokenResponse =\n' +
      '          e instanceof InvalidResponseError &&\n' +
      '          e.missingFields.includes("access_token");\n' +
      '        if (invalidTokenResponse) {\n',
    'TypeScript invalid response classification',
  );
  content = replaceOnce(
    content,
    '          options?.eventEmitter?.emit(EVENTS.SESSION_EXPIRED);\n        }\n      }\n',
    '          options?.eventEmitter?.emit(EVENTS.SESSION_EXPIRED);\n' +
      '        }\n' +
      '        if (!terminalProviderError && !invalidTokenResponse) {\n' +
      '          const retryDelay = Math.min(\n' +
      '            1000 * 2 ** refreshRetryAttempt,\n' +
      '            XPOD_REFRESH_RETRY_MAX_DELAY_MS,\n' +
      '          );\n' +
      '          refreshRetryAttempt += 1;\n' +
      '          clearTimeout(latestTimeout);\n' +
      '          latestTimeout = setTimeout(proactivelyRefreshToken, retryDelay);\n' +
      '          options?.eventEmitter?.emit(EVENTS.TIMEOUT_SET, latestTimeout);\n' +
      '        }\n' +
      '      }\n',
    'TypeScript transient retry',
  );
  return content;
}

function patchBundle(content) {
  if (content.includes(RETRY_MARKER)) return content;

  content = replaceOnce(
    content,
    '    let latestTimeout;\n',
    '    let latestTimeout;\n' +
      '    let refreshRetryAttempt = 0;\n' +
      '    const XPOD_REFRESH_RETRY_MAX_DELAY_MS = 60000;\n',
    'bundle refresh state',
  );
  content = replaceOnce(
    content,
    '                currentAccessToken = refreshedAccessToken;\n',
    '                currentAccessToken = refreshedAccessToken;\n' +
      '                refreshRetryAttempt = 0;\n',
    'bundle refresh success',
  );
  content = replaceOnce(
    content,
    '                if (e instanceof OidcProviderError) {\n',
    '                const terminalProviderError = e instanceof OidcProviderError &&\n' +
      '                    e.error !== "server_error" &&\n' +
      '                    e.error !== "temporarily_unavailable";\n' +
      '                if (terminalProviderError) {\n',
    'bundle provider error classification',
  );
  content = replaceOnce(
    content,
    '                if (e instanceof InvalidResponseError &&\n                    e.missingFields.includes("access_token")) {\n',
    '                const invalidTokenResponse = e instanceof InvalidResponseError &&\n' +
      '                    e.missingFields.includes("access_token");\n' +
      '                if (invalidTokenResponse) {\n',
    'bundle invalid response classification',
  );
  content = replaceOnce(
    content,
    '                    options?.eventEmitter?.emit(EVENTS.SESSION_EXPIRED);\n                }\n            }\n',
    '                    options?.eventEmitter?.emit(EVENTS.SESSION_EXPIRED);\n' +
      '                }\n' +
      '                if (!terminalProviderError && !invalidTokenResponse) {\n' +
      '                    const retryDelay = Math.min(1000 * 2 ** refreshRetryAttempt, XPOD_REFRESH_RETRY_MAX_DELAY_MS);\n' +
      '                    refreshRetryAttempt += 1;\n' +
      '                    clearTimeout(latestTimeout);\n' +
      '                    latestTimeout = setTimeout(proactivelyRefreshToken, retryDelay);\n' +
      '                    options?.eventEmitter?.emit(EVENTS.TIMEOUT_SET, latestTimeout);\n' +
      '                }\n' +
      '            }\n',
    'bundle transient retry',
  );
  return content;
}

function patchInstalledPackage(repositoryRoot = path.join(__dirname, '..')) {
  const packageRoot = path.join(
    repositoryRoot,
    'node_modules',
    '@inrupt',
    'solid-client-authn-core',
  );
  const packageJsonPath = path.join(packageRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    console.log('[patch-inrupt-authn-refresh] package not installed, skipping');
    return { patched: 0, alreadyPatched: 0 };
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (packageJson.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported @inrupt/solid-client-authn-core ${packageJson.version}; expected ${SUPPORTED_VERSION}`,
    );
  }

  const targets = [
    ['src/authenticatedFetch/fetchFactory.ts', patchSource],
    ['dist/index.js', patchBundle],
    ['dist/index.mjs', patchBundle],
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
    `[patch-inrupt-authn-refresh] Patched ${patched}; ${alreadyPatched} already patched`,
  );
  return { patched, alreadyPatched };
}

module.exports = { patchBundle, patchInstalledPackage, patchSource };

if (require.main === module) {
  try {
    patchInstalledPackage();
  } catch (error) {
    console.error('[patch-inrupt-authn-refresh] Failed:', error.message);
    process.exit(1);
  }
}
