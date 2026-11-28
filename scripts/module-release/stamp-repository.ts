#!/usr/bin/env bun
/**
 * Name the source repository in a packed module manifest (docs/module-publication-v2.md §3).
 *
 * npm refuses a provenance publish whose `repository.url` does not name the signing
 * repository. The repository is written into the packed `package.json` here instead of
 * the source manifests, which the existing producer recipes bind byte for byte. Only
 * that field changes; every other file keeps its bytes and mode. The stamped tarball
 * is what the package check, install check and publish then use.
 *
 * Usage: bun scripts/module-release/stamp-repository.ts <in.tgz> <out.tgz> --directory <packages/xpod-…>
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { c as createTar, t as listTar, x as extractTar } from 'tar';

export const RELEASE_REPOSITORY_URL = 'git+https://github.com/undefinedsco/xpod.git';

export async function stampRepository(input: string, output: string, directory: string): Promise<void> {
  if (!/^packages\/[a-z0-9-]+$/.test(directory)) throw new Error(`invalid package directory: ${directory}`);
  const work = mkdtempSync(path.join(tmpdir(), 'xpod-stamp-repository-'));
  try {
    // Keep the original member list and order: npm packs files only, no directory entries.
    const members: string[] = [];
    await listTar({ file: input, onReadEntry: entry => { if (entry.type === 'File') members.push(entry.path); } });
    await extractTar({ file: input, cwd: work, strict: true });
    const manifestPath = path.join(work, 'package', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const existing = manifest.repository;
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify({ type: 'git', url: RELEASE_REPOSITORY_URL, directory })) {
      throw new Error(`package already names a different repository: ${JSON.stringify(existing)}`);
    }
    manifest.repository = { type: 'git', url: RELEASE_REPOSITORY_URL, directory };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    // `portable` drops host uid/gid/uname so the archive does not depend on the runner.
    await createTar({ gzip: true, file: output, cwd: work, portable: true, noDirRecurse: true }, members);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [input, output, flag, directory] = process.argv.slice(2);
  if (!input || !output || flag !== '--directory' || !directory) {
    console.error('usage: stamp-repository.ts <in.tgz> <out.tgz> --directory <packages/xpod-…>');
    process.exit(64);
  }
  await stampRepository(path.resolve(input), path.resolve(output), directory);
}
