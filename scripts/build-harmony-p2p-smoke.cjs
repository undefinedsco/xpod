#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const harmonyDir = path.join(rootDir, 'harmony', 'p2p-smoke');
const artifactDir = path.join(rootDir, '.artifacts', 'harmony-p2p-smoke');

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
  const result = spawnSync('command', ['-v', command], { shell: true, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : '';
}

function findJavaHome() {
  if (isExecutable(path.join(process.env.JAVA_HOME || '', 'bin', 'java'))) return process.env.JAVA_HOME;
  const candidates = [
    '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
    '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
    '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home',
  ];
  for (const candidate of candidates) {
    if (isExecutable(path.join(candidate, 'bin', 'java'))) return candidate;
  }
  return '';
}

function javaVersion(javaHome) {
  const java = path.join(javaHome || '', 'bin', 'java');
  if (!isExecutable(java)) return '';
  const result = spawnSync(java, ['-version'], { encoding: 'utf8' });
  return `${result.stderr || result.stdout}`.split(/\r?\n/)[0] || '';
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
  const repoHvigor = path.join(rootDir, '.artifacts', 'harmony-toolchain', 'node_modules', '@ohos', 'hvigor', 'bin', 'hvigor.js');
  if (fs.existsSync(repoHvigor)) return repoHvigor;
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

function inferCommandLineToolsSdkHome(hvigor) {
  if (!hvigor) return '';
  const normalized = path.resolve(hvigor);
  const binDir = path.dirname(normalized);
  const commandLineToolsDir = path.basename(binDir) === 'bin' ? path.dirname(binDir) : '';
  if (commandLineToolsDir && path.basename(commandLineToolsDir) === 'command-line-tools') {
    const sdk = path.join(commandLineToolsDir, 'sdk');
    if (isDirectory(sdk)) return sdk;
  }

  const hvigorDir = path.dirname(path.dirname(normalized));
  const siblingCommandLineTools = path.basename(hvigorDir) === 'hvigor' ? path.dirname(hvigorDir) : '';
  if (siblingCommandLineTools && path.basename(siblingCommandLineTools) === 'command-line-tools') {
    const sdk = path.join(siblingCommandLineTools, 'sdk');
    if (isDirectory(sdk)) return sdk;
  }
  return '';
}

function findSdkHome(hvigor) {
  if (isDirectory(process.env.DEVECO_SDK_HOME || '')) return process.env.DEVECO_SDK_HOME;
  return inferCommandLineToolsSdkHome(hvigor);
}

function diagnose() {
  const javaHome = findJavaHome();
  const hvigor = findHvigor();
  const sdkHome = findSdkHome(hvigor);
  const rows = [
    'Harmony P2P smoke build doctor',
    `project: ${path.relative(rootDir, harmonyDir)}`,
    `java: ${javaHome ? `${javaHome} (${javaVersion(javaHome)})` : 'missing'}`,
    `hvigor: ${hvigor || 'missing'}`,
    `DEVECO_SDK_HOME: ${isDirectory(sdkHome) ? sdkHome : 'missing'}`,
  ];
  console.log(rows.join('\n'));
  return { javaHome, hvigor, sdkHome };
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const doctorOnly = process.argv.includes('--doctor');
const diagnosis = diagnose();
if (doctorOnly) process.exit(0);

if (!isDirectory(harmonyDir)) fail(`Harmony P2P smoke project not found: ${harmonyDir}`);
if (!diagnosis.javaHome) fail('A usable JDK is required. Set JAVA_HOME or install OpenJDK 17/21.');
if (!diagnosis.hvigor) fail('Hvigor is required. Install/sync DevEco Studio or set XPOD_HVIGOR_CLI=/path/to/hvigor.');
if (!isDirectory(diagnosis.sdkHome)) fail('DEVECO_SDK_HOME must point to a valid HarmonyOS SDK directory.');

fs.mkdirSync(artifactDir, { recursive: true });
const env = {
  ...process.env,
  JAVA_HOME: diagnosis.javaHome,
  DEVECO_SDK_HOME: diagnosis.sdkHome,
  PATH: `${path.join(diagnosis.javaHome, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
};
const hvigorProgram = diagnosis.hvigor.endsWith('.js') ? process.execPath : diagnosis.hvigor;
const hvigorArgs = diagnosis.hvigor.endsWith('.js')
  ? [diagnosis.hvigor, 'assembleHap', '--mode', 'module', '-p', 'module=entry@default', '--no-daemon']
  : ['assembleHap', '--mode', 'module', '-p', 'module=entry@default', '--no-daemon'];
const build = spawnSync(hvigorProgram, hvigorArgs, { cwd: harmonyDir, stdio: 'inherit', env });
if (build.status !== 0) process.exit(build.status ?? 1);
const haps = findHaps(harmonyDir);
if (haps.length === 0) fail(`Hvigor finished but no .hap was found under ${harmonyDir}.`);
const latestHap = haps[haps.length - 1];
const target = path.join(artifactDir, path.basename(latestHap));
fs.copyFileSync(latestHap, target);
console.log(`HAP copied to ${target}`);
