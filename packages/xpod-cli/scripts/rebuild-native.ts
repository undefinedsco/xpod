#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeGitEnvironment, runSourceCommand, verifyNativeSources } from '../src/native-sources';
import { verifySourceFiles } from '../src/source-materials';
import { assertNativeTarget, bunCompileTarget } from '../src/native-target';
import { sha256File } from '../src/manifest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
let out = path.join(root, '.test-data/rebuild-native');
let test = false;
let verifyOnly = false;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--out') { out = path.resolve(process.argv[++i]); }
  else if (arg === '--test') { test = true; }
  else if (arg === '--verify-only') { verifyOnly = true; }
  else { throw new Error(`Unknown argument: ${arg}`); }
}
const kit = verifyNativeSources(root);
const sourceKitSha256 = sha256File(path.join(root, 'source-kit.json'));
if (verifyOnly) {
  console.log(JSON.stringify({ verified: true, sourceKitSha256, engine: kit.engine, files: kit.files.length }));
} else {
  const target = `${process.platform}-${process.arch}`;
  bunCompileTarget(target);
  if (kit.files.some((file) => {
    const relative = path.relative(out, path.join(root, file.path));
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  })) { throw new Error('Native output directory overlaps preserved source'); }
  // Explicit compiler paths prevent a Homebrew/system rustc from overriding
  // rustup's intended compiler. Missing toolchains fail without installation.
  const cargo = runSourceCommand('rustup', ['which', '--toolchain', kit.toolchain, 'cargo'], root).trim();
  const rustc = runSourceCommand('rustup', ['which', '--toolchain', kit.toolchain, 'rustc'], root).trim();
  const compiler = { toolchain: kit.toolchain, cargoSha256: sha256File(cargo), rustcSha256: sha256File(rustc), rustcVersion: runSourceCommand(rustc, ['-vV'], root).trim() };
  mkdirSync(out, { recursive: true });
  const stage = mkdtempSync(path.join(tmpdir(), 'xpod-native-source-rebuild-'));
  const env = nativeGitEnvironment(stage);
  for (const key of Object.keys(env)) {
    if (key.startsWith('CARGO_') || ['RUSTC', 'RUSTDOC', 'RUSTFLAGS', 'RUSTDOCFLAGS', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER'].includes(key)) { delete env[key]; }
  }
  Object.assign(env, {
    CARGO_HOME: path.join(stage, 'cargo-home'), CARGO_TARGET_DIR: path.join(out, 'target'),
    RUSTC: rustc, RUSTUP_TOOLCHAIN: kit.toolchain, GIT_CEILING_DIRECTORIES: stage,
  });
  const run = (action: 'build' | 'test'): void => {
    const result = spawnSync(cargo, [action, '--release', '--frozen'], { cwd: path.join(stage, 'helper'), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(path.join(out, `${action}.log`), result.stdout + '\n' + result.stderr);
    if (result.status !== 0) { throw new Error(`Native ${action} failed; see ${path.join(out, `${action}.log`)}`); }
  };
  try {
    for (const file of kit.files) {
      const destination = path.join(stage, file.path); mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(path.join(root, file.path), destination);
      if (sha256File(destination) !== file.sha256) { throw new Error(`Native source changed during staging: ${file.path}`); }
    }
    run('build');
    if (test) { run('test'); }
    verifySourceFiles(stage, kit.files);
  } finally { rmSync(stage, { recursive: true, force: true }); }
  const compiled = path.join(out, 'target/release/agentfs-pod');
  assertNativeTarget(compiled, target);
  const helper = path.join(out, 'agentfs-pod'); cpSync(compiled, helper);
  const receipt = {
    schemaVersion: 1, target, engine: kit.engine, sourceKitSha256, helperSha256: sha256File(helper),
    compiler, buildArguments: ['build', '--release', '--frozen'], testsPassed: test,
    registryPackages: kit.registryPackages, sourceFiles: kit.files.length,
    isolatedCargoHome: true, stagedVerifiedFilesOnly: true,
    scope: 'Native helper rebuild only; toolchain/system dependencies external; not Bun/JSC or whole-artifact release clearance',
  };
  writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ target, helper, helperSha256: receipt.helperSha256, sourceKitSha256, testsPassed: test, receipt: path.join(out, 'receipt.json') }));
}
