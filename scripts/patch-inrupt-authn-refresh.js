#!/usr/bin/env node

/**
 * Keep an active browser Solid session alive when a proactive token refresh
 * temporarily fails (for example while macOS is asleep or the local IdP is
 * restarting), and renew before the first request after a suspended timer.
 * Inrupt currently stops scheduling refreshes after any thrown
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

// Extend the pinned transient-retry patch at the same token-owning boundary.
// Requests must renew before dispatch; provider HTTP responses never drive it.
function patchRequestRenewal(content, source) {
  const marker = 'XPOD_REFRESH_ON_REQUEST';
  const indent = source ? '  ' : '    ';
  const outer = indent.repeat(2);
  const inner = indent.repeat(3);
  const declaration = source ? ': (() => Promise<void>) | undefined' : '';
  const pendingType = source ? ': Promise<boolean> | undefined' : '';
  const errorType = source ? ': unknown' : '';
  if (content.includes(marker)) {
    for (const expected of [marker, 'let accessTokenExpiresAt = Date.now()', 'let refreshTerminated = false;', 'refreshBeforeRequest = async () => {', 'await refreshBeforeRequest();']) {
      if (content.split(expected).length !== 2) throw new Error(`Incomplete ${marker}: ${expected}`);
    }
    return content;
  }
  content = replaceOnce(content, `${indent}let currentAccessToken = accessToken;\n`,
    `${indent}let currentAccessToken = accessToken;\n` +
    `${indent}// ${marker}: use real expiry even when the proactive timer was suspended.\n` +
    `${indent}let accessTokenExpiresAt = Date.now() + (options?.expiresIn ?? DEFAULT_EXPIRATION_TIME_SECONDS) * 1000;\n` +
    `${indent}let refreshBeforeRequest${declaration};\n` +
    `${indent}let refreshInFlight${pendingType};\n` +
    `${indent}let refreshTerminated = false;\n` +
    `${indent}let lastRefreshError${errorType};\n`, 'request renewal state');

  const callback = `${outer}const proactivelyRefreshToken = async () => {`;
  const callbackEnd = `\n${outer}};\n${outer}latestTimeout = setTimeout(`;
  const start = content.indexOf(callback);
  const end = content.indexOf(callbackEnd, start);
  if (start < 0 || end < 0) throw new Error('Missing proactive refresh callback');
  let body = content.slice(start + callback.length, end);
  body = replaceOnce(body, 'currentAccessToken = refreshedAccessToken;',
    'currentAccessToken = refreshedAccessToken;\n' + `${indent.repeat(4)}accessTokenExpiresAt = Date.now() + (expiresIn ?? DEFAULT_EXPIRATION_TIME_SECONDS) * 1000;`, 'renewed expiry');
  const optionsExpression = source ? 'options!' : 'options';
  body = replaceOnce(body, `${optionsExpression}.eventEmitter?.emit(EVENTS.TIMEOUT_SET, latestTimeout);`,
    `${optionsExpression}.eventEmitter?.emit(EVENTS.TIMEOUT_SET, latestTimeout);\n${indent.repeat(4)}return true;`, 'successful renewal result');
  body = replaceOnce(body, 'catch (e) {', `catch (e) {\n${indent.repeat(4)}lastRefreshError = e;`, 'renewal failure retention');
  body = replaceOnce(body, 'if (!terminalProviderError && !invalidTokenResponse) {',
    'refreshTerminated = terminalProviderError || invalidTokenResponse;\n' +
      `${indent.repeat(4)}if (!terminalProviderError && !invalidTokenResponse) {`, 'terminal renewal retention');
  if (!body.endsWith(`\n${inner}}`)) throw new Error('Missing refresh catch boundary');
  body = body.slice(0, -(`\n${inner}}`.length)) + `\n${indent.repeat(4)}return false;\n${inner}}`;
  body = body.split('\n').map(line => line ? indent + line : line).join('\n');
  const replacement = `${outer}const proactivelyRefreshToken = async ()${source ? ': Promise<boolean>' : ''} => {\n` +
    `${inner}if (refreshTerminated) return false;\n` +
    `${inner}if (refreshInFlight) return refreshInFlight;\n` +
    `${inner}refreshInFlight = (async () => {${body}\n` +
    `${inner}})().finally(() => { refreshInFlight = undefined; });\n` +
    `${inner}return refreshInFlight;\n` +
    `${outer}};\n` +
    `${outer}refreshBeforeRequest = async () => {\n` +
    `${inner}if (!await proactivelyRefreshToken()) throw lastRefreshError;\n` +
    `${outer}};`;
  content = content.slice(0, start) + replacement + content.slice(end + `\n${outer}};`.length);
  const fetchStart = source
    ? `${indent}return async (url, requestInit?): Promise<Response> => {\n`
    : `${indent}return async (url, requestInit) => {\n`;
  content = replaceOnce(content, fetchStart,
    fetchStart + `${outer}if (refreshBeforeRequest && Date.now() >= accessTokenExpiresAt) {\n` +
      `${inner}await refreshBeforeRequest();\n${outer}}\n`, 'request renewal before dispatch');
  return content;
}

function patchSource(content) {
  if (content.includes(RETRY_MARKER)) return patchRequestRenewal(content, true);

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
  return patchRequestRenewal(content, true);
}

function patchBundle(content) {
  if (content.includes(RETRY_MARKER)) return patchRequestRenewal(content, false);

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
  return patchRequestRenewal(content, false);
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
  ].map(([relativePath, patcher]) => {
    const targetPath = path.join(packageRoot, relativePath);
    const original = fs.readFileSync(targetPath, 'utf8');
    return { targetPath, original, updated: patcher(original) };
  });
  let patched = 0;
  let alreadyPatched = 0;
  // Validate all three pinned shapes before mutating the installation.
  for (const { targetPath, original, updated } of targets) {
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
