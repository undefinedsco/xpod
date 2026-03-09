#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const packageJson = require(path.join(repoRoot, 'package.json'));
const supportedRange = packageJson.engines?.node ?? '>=22 <23';
const currentVersion = process.versions.node;
const currentMajor = Number(currentVersion.split('.')[0]);
const currentAbi = process.versions.modules;
const nvmrcPath = path.join(repoRoot, '.nvmrc');
const nvmVersion = fs.existsSync(nvmrcPath) ? fs.readFileSync(nvmrcPath, 'utf8').trim() : '22';

function fail(message, error) {
  console.error(`[abi-check] ${message}`);
  if (error) {
    const details = error instanceof Error ? error.message : String(error);
    console.error(details);
  }
  process.exit(1);
}

if (currentMajor < 22 || currentMajor >= 23) {
  fail([
    `Unsupported Node.js ${process.version}. xpod requires ${supportedRange}.`,
    `Suggested fix: nvm use ${nvmVersion}`,
    'Then run: yarn install --force --ignore-engines',
  ].join('\n'));
}

try {
  require('better-sqlite3');
  console.log(`[abi-check] OK: Node ${process.version}, ABI ${currentAbi}, better-sqlite3 loaded.`);
} catch (error) {
  const details = error instanceof Error ? error.message : String(error);
  const isAbiMismatch = /NODE_MODULE_VERSION|compiled against a different Node\.js version/i.test(details);
  if (!isAbiMismatch) {
    fail('Failed to load better-sqlite3.', error);
  }

  fail([
    `Native module ABI mismatch under Node ${process.version} (ABI ${currentAbi}).`,
    `xpod requires ${supportedRange}. Suggested fix:`,
    `  1. nvm use ${nvmVersion}`,
    '  2. yarn install --force --ignore-engines',
    'If the problem persists, delete node_modules and reinstall under the same Node version.',
  ].join('\n'), error);
}
