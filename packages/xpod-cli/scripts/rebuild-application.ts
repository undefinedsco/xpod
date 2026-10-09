#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyApplicationSources } from '../src/application-sources';
import { bunBundleArguments, bunBundleEnvironment } from '../src/native-target';
import { sha256File } from '../src/manifest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const kit = verifyApplicationSources(root);
if (process.argv.slice(2).some((arg) => arg !== '--verify-only')) { throw new Error('Only --verify-only is supported'); }
if (process.argv.includes('--verify-only')) {
  console.log(JSON.stringify({ verified: true, target: kit.target, originalCliSha256: kit.cliSha256 }));
} else {
  const hostTarget = `${process.platform}-${process.arch}`;
  const out = path.join(root, '.test-data/rebuild');
  mkdirSync(out, { recursive: true });
  const outfile = path.join(out, 'xpodcli.mjs');
  const stage = mkdtempSync(path.join(tmpdir(), 'xpod-cli-source-rebuild-'));
  const metafile = path.join(out, 'metafile.json');
  const args = bunBundleArguments({ target: kit.target, hostTarget, entry: kit.recipe.entry, outfile, metafile });
  let rebuiltInputs: { path: string; sha256: string }[];
  try {
    for (const file of kit.files) {
      const destination = path.join(stage, file.path);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(path.join(root, file.path), destination);
      if (sha256File(destination) !== file.sha256) { throw new Error(`Source changed during staging: ${file.path}`); }
    }
    const result = spawnSync(process.execPath, args, { cwd: stage, env: bunBundleEnvironment(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) { throw new Error(`Application rebuild failed: ${result.stderr}`); }
    const metadata = JSON.parse(readFileSync(metafile, 'utf8')) as { inputs: Record<string, unknown> };
    const files = new Map(kit.files.map((file) => [file.path, file.sha256]));
    rebuiltInputs = Object.keys(metadata.inputs).map((input) => {
      const relative = path.relative(stage, path.resolve(stage, input)).split(path.sep).join('/');
      if (!files.has(relative)) { throw new Error(`Rebuild used unverified input: ${relative}`); }
      const sha256 = sha256File(path.join(stage, relative));
      if (files.get(relative) !== sha256) { throw new Error(`Rebuild used unverified input: ${relative}`); }
      return { path: relative, sha256 };
    });
  } finally { rmSync(stage, { recursive: true, force: true }); }
  const receipt = {
    target: kit.target, originalCliSha256: kit.cliSha256, cliSha256: sha256File(outfile),
    originalCompiler: kit.compiler,
    compiler: { version: process.versions.bun, executableSha256: sha256File(process.execPath) },
    arguments: args, rebuiltInputs, usesInvokedBundler: true,
    distribution: 'external-runtime',
    scope: 'Portable JavaScript rebuild only; no runtime embedded or whole-artifact clearance',
  };
  writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ target: kit.target, cliSha256: receipt.cliSha256, compiler: receipt.compiler, verifiedInputs: rebuiltInputs.length, receipt: path.join(out, 'receipt.json') }));
}
