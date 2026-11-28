import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RELEASE_REPOSITORY_URL, stampRepository } from '../../scripts/module-release/stamp-repository';

const base = path.resolve('.test-data/module-release-stamp');
mkdirSync(base, { recursive: true });
afterAll(() => rmSync(base, { recursive: true, force: true }));

function pack(manifest: object): string {
  const dir = mkdtempSync(path.join(base, 'pkg-'));
  mkdirSync(path.join(dir, 'package', 'bin'), { recursive: true });
  writeFileSync(path.join(dir, 'package', 'package.json'), JSON.stringify(manifest));
  writeFileSync(path.join(dir, 'package', 'bin', 'tool'), '#!/bin/sh\necho ok\n');
  chmodSync(path.join(dir, 'package', 'bin', 'tool'), 0o755);
  const tarball = path.join(dir, 'in.tgz');
  expect(spawnSync('tar', ['-czf', tarball, '-C', dir, 'package/package.json', 'package/bin/tool']).status).toBe(0);
  return tarball;
}

const read = (tarball: string, member: string) => spawnSync('tar', ['-xzOf', tarball, member], { encoding: 'utf8' }).stdout;

describe('module release repository stamp', () => {
  it('adds the repository to the packed manifest and keeps every other member', async () => {
    const input = pack({ name: '@undefineds.co/xpod-cli', version: '1.0.0' });
    const output = path.join(path.dirname(input), 'out.tgz');
    await stampRepository(input, output, 'packages/xpod-cli');
    expect(JSON.parse(read(output, 'package/package.json')).repository).toEqual({ type: 'git', url: RELEASE_REPOSITORY_URL, directory: 'packages/xpod-cli' });
    expect(read(output, 'package/bin/tool')).toBe('#!/bin/sh\necho ok\n');
    expect(spawnSync('tar', ['-tzf', output], { encoding: 'utf8' }).stdout.trim().split('\n')).toEqual(['package/package.json', 'package/bin/tool']);
  });

  it('refuses a package that already names another repository', async () => {
    const input = pack({ name: '@undefineds.co/xpod-cli', version: '1.0.0', repository: 'https://github.com/someone/fork' });
    await expect(stampRepository(input, path.join(path.dirname(input), 'out.tgz'), 'packages/xpod-cli')).rejects.toThrow('already names a different repository');
  });
});
