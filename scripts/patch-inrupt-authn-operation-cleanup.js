#!/usr/bin/env bun

// Inrupt 3.1.1 emits ERROR and starts logout without awaiting it. A callback
// must not release Xpod's cross-document login lease while that cleanup can
// still erase the next document's OIDC client/PKCE records.
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '3.1.1';
const MARKER = 'XPOD_INRUPT_OPERATION_CLEANUP';

function replacements(source) {
  const indent = source ? '  ' : '    ';
  const listenerIndent = indent.repeat(2);
  const events = source ? 'EVENTS' : '(?:solidClientAuthnCore\\.)?EVENTS';
  return [
    [
      `${indent}${source ? 'private ' : ''}tokenRequestInProgress = false;`,
      `${indent}${source ? 'private ' : ''}tokenRequestInProgress = false;\n` +
        `${indent}${source ? 'private ' : ''}xpodErrorLogout${source ? ': Promise<void>' : ''} = Promise.resolve();`,
    ],
    [
      new RegExp(`${listenerIndent}this\\.events\\.on\\(${events}\\.ERROR, \\(\\) => this\\.internalLogout\\(false\\)\\);`, 'g'),
      (match) => {
        const eventName = match.includes('solidClientAuthnCore.') ? 'solidClientAuthnCore.EVENTS' : 'EVENTS';
        return `${listenerIndent}this.events.on(${eventName}.ERROR, () => {\n` +
          `${listenerIndent}${indent}this.xpodErrorLogout = this.xpodErrorLogout.then(\n` +
          `${listenerIndent}${indent}${indent}() => this.internalLogout(false),\n` +
          `${listenerIndent}${indent}${indent}() => this.internalLogout(false),\n` +
          `${listenerIndent}${indent});\n` +
          `${listenerIndent}${indent}void this.xpodErrorLogout.catch(() => {});\n` +
          `${listenerIndent}});`;
      },
    ],
    [
      source
        ? '    const sessionInfo = await this.clientAuthentication.handleIncomingRedirect(\n      url,\n      this.events,\n    );'
        : '        const sessionInfo = await this.clientAuthentication.handleIncomingRedirect(url, this.events);',
      (match) => `${match}\n` +
        `${listenerIndent}try {\n` +
        `${listenerIndent}${indent}await this.xpodErrorLogout;\n` +
        `${listenerIndent}} catch (error) {\n` +
        `${listenerIndent}${indent}this.tokenRequestInProgress = false;\n` +
        `${listenerIndent}${indent}throw error;\n` +
        `${listenerIndent}}`,
    ],
  ];
}

function patch(content, source) {
  if (content.includes(MARKER)) {
    for (const expected of [
      'xpodErrorLogout' + (source ? ': Promise<void>' : '') + ' = Promise.resolve();',
      'this.xpodErrorLogout = this.xpodErrorLogout.then(',
      'await this.xpodErrorLogout;',
      'void this.xpodErrorLogout.catch(() => {});',
    ]) {
      if (content.split(expected).length !== 2) throw new Error(`Incomplete ${MARKER}: ${expected}`);
    }
    return content;
  }
  for (const [search, replacement] of replacements(source)) {
    const matches = typeof search === 'string' ? content.split(search).length - 1 : [...content.matchAll(search)].length;
    if (matches !== 1) throw new Error(`Expected one operation cleanup target, found ${matches}: ${search}`);
    content = content.replace(search, replacement);
  }
  return `${content}\n// ${MARKER}\n`;
}

const patchSource = (content) => patch(content, true);
const patchBundle = (content) => patch(content, false);

function patchInstalledPackage(repositoryRoot = path.join(__dirname, '..')) {
  const packageRoot = path.join(repositoryRoot, 'node_modules/@inrupt/solid-client-authn-browser');
  const manifest = path.join(packageRoot, 'package.json');
  if (!fs.existsSync(manifest)) return { patched: 0, alreadyPatched: 0 };
  const version = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  if (version !== VERSION) throw new Error(`Unsupported @inrupt/solid-client-authn-browser ${version}; expected ${VERSION}`);
  // Validate every target before writing any file, including already-patched
  // targets, so an upstream shape change cannot leave a half-patched install.
  const targets = [
    ['src/Session.ts', patchSource],
    ['dist/index.js', patchBundle],
    ['dist/index.mjs', patchBundle],
  ].map(([relativePath, patcher]) => {
    const file = path.join(packageRoot, relativePath);
    const original = fs.readFileSync(file, 'utf8');
    return { file, original, updated: patcher(original) };
  });
  let patched = 0;
  for (const target of targets) {
    if (target.original !== target.updated) {
      fs.writeFileSync(target.file, target.updated);
      patched += 1;
    }
  }
  return { patched, alreadyPatched: targets.length - patched };
}

module.exports = { patchSource, patchBundle, patchInstalledPackage };

if (require.main === module) {
  try {
    console.log('[patch-inrupt-authn-operation-cleanup]', patchInstalledPackage());
  } catch (error) {
    console.error('[patch-inrupt-authn-operation-cleanup] Failed:', error.message);
    process.exitCode = 1;
  }
}
