#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const packageJson = require(path.join(repoRoot, 'package.json'));
const supportedRange = packageJson.engines?.node ?? '>=22 <27';
const currentVersion = process.versions.node;
const currentMajor = Number(currentVersion.split('.')[0]);
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

if (currentMajor < 22 || currentMajor >= 27) {
  fail([
    `Unsupported Node.js ${process.version}. xpod requires ${supportedRange}.`,
    `Suggested fix: nvm use ${nvmVersion}`,
    'Then run: bun install',
  ].join('\n'));
}

try {
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE runtime_check (id INTEGER PRIMARY KEY)');
  database.close();
  console.log(`[abi-check] OK: Node ${process.version}, built-in node:sqlite runtime available.`);
} catch (error) {
  fail([
    `Built-in node:sqlite runtime is unavailable under Node ${process.version}.`,
    `xpod requires ${supportedRange}. Suggested fix:`,
    `  1. nvm use ${nvmVersion}`,
    '  2. bun install',
  ].join('\n'), error);
}
