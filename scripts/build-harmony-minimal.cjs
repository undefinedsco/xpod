#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const harmonyDir = path.join(rootDir, 'harmony', 'minimal');
const artifactDir = path.join(rootDir, '.artifacts', 'harmony-minimal');

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function isDirectory(value) {
  return Boolean(value) && fs.existsSync(value) && fs.statSync(value).isDirectory();
}

function isExecutable(file) {
  if (!file || !fs.existsSync(file)) return false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandPath(command) {
  const result = spawnSync('command', ['-v', command], {
    shell: true,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : '';
}

function findHvigor() {
  const explicit = process.env.XPOD_HVIGOR_CLI;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const wrapper = path.join(harmonyDir, 'hvigorw');
  if (isExecutable(wrapper)) return wrapper;

  for (const command of ['hvigorw', 'hvigor']) {
    const found = commandPath(command);
    if (found) return found;
  }

  const localBin = path.join(harmonyDir, 'node_modules', '.bin', 'hvigor');
  if (isExecutable(localBin)) return localBin;

  return '';
}

function findHaps(dir) {
  const output = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.hap')) output.push(full);
    }
  }
  return output.sort();
}

if (!isDirectory(harmonyDir)) {
  fail(`Harmony minimal project not found: ${harmonyDir}`);
}

if (!isDirectory(process.env.DEVECO_SDK_HOME)) {
  fail('DEVECO_SDK_HOME must point to a valid HarmonyOS SDK directory.');
}

const javaCheck = spawnSync('java', ['-version'], { stdio: 'ignore' });
if (javaCheck.status !== 0) {
  fail('A usable JDK is required on PATH.');
}

const hvigor = findHvigor();
if (!hvigor) {
  fail('Hvigor is required. Install/sync with DevEco Studio or set XPOD_HVIGOR_CLI=/path/to/hvigor.');
}

fs.mkdirSync(artifactDir, { recursive: true });

const build = spawnSync(hvigor, ['assembleHap', '--mode', 'module', '-p', 'module=entry@default', '--no-daemon'], {
  cwd: harmonyDir,
  stdio: 'inherit',
  env: process.env,
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const haps = findHaps(harmonyDir);
if (haps.length === 0) {
  fail(`Hvigor finished but no .hap was found under ${harmonyDir}.`);
}

const latestHap = haps[haps.length - 1];
const target = path.join(artifactDir, path.basename(latestHap));
fs.copyFileSync(latestHap, target);
console.log(`HAP copied to ${target}`);
