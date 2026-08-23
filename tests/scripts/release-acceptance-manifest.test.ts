import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = new URL('../../scripts/release-acceptance-manifest.cjs', import.meta.url);
const sourceRef = '3e77098627ba955766c103872442595b7526884a';
const xpodImage = 'ghcr.io/undefinedsco/xpod@sha256:1111111111111111111111111111111111111111111111111111111111111111';
const postgresImage = 'registry.example.com/undefineds/postgres@sha256:2222222222222222222222222222222222222222222222222222222222222222';

function run(args: string[]) {
  return execFileSync('node', [script.pathname, ...args], { encoding: 'utf8' });
}

function expectFailure(args: string[]) {
  expect(() => run(args)).toThrow();
}

describe('release acceptance manifest', () => {
  it('creates and validates schema v2 manifests with both immutable release images', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'xpod-acceptance-'));
    const manifest = path.join(dir, 'release-acceptance.json');

    run([
      'create',
      '--source-ref', sourceRef,
      '--xpod-image-digest', xpodImage,
      '--postgres-image-digest', postgresImage,
      '--output', manifest,
    ]);

    const parsed = JSON.parse(await readFile(manifest, 'utf8'));
    expect(parsed).toMatchObject({
      schemaVersion: 2,
      kind: 'undefineds.xpod.releaseAcceptance',
      sourceRef,
      xpodImageDigest: xpodImage,
      postgresImageDigest: postgresImage,
    });

    expect(run([
      'validate',
      '--manifest', manifest,
      '--source-ref', sourceRef,
      '--xpod-image-digest', xpodImage,
      '--postgres-image-digest', postgresImage,
      '--require-postgres-image',
    ])).toContain('valid');
  });

  it('keeps the public application gate independent from private PostgreSQL images', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'xpod-acceptance-'));
    const manifest = path.join(dir, 'public-release-acceptance.json');

    run([
      'create',
      '--source-ref', sourceRef,
      '--xpod-image-digest', xpodImage,
      '--output', manifest,
    ]);

    expect(run([
      'validate',
      '--manifest', manifest,
      '--source-ref', sourceRef,
      '--xpod-image-digest', xpodImage,
    ])).toContain('valid');
    expectFailure([
      'validate',
      '--manifest', manifest,
      '--source-ref', sourceRef,
      '--xpod-image-digest', xpodImage,
      '--require-postgres-image',
    ]);
    expectFailure([
      'validate',
      '--manifest', manifest,
      '--source-ref', sourceRef,
      '--xpod-image-digest', xpodImage,
      '--postgres-image-digest', postgresImage,
      '--require-postgres-image',
    ]);
  });

  it('rejects mutable tags and mismatched promotion inputs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'xpod-acceptance-'));
    const manifest = path.join(dir, 'release-acceptance.json');
    await writeFile(manifest, JSON.stringify({
      schemaVersion: 2,
      kind: 'undefineds.xpod.releaseAcceptance',
      sourceRef,
      xpodImageDigest: xpodImage,
      postgresImageDigest: postgresImage,
    }));

    expectFailure([
      'validate',
      '--manifest', manifest,
      '--source-ref', sourceRef,
      '--xpod-image-digest', 'ghcr.io/undefinedsco/xpod:latest',
    ]);
    expectFailure([
      'validate',
      '--manifest', manifest,
      '--source-ref', sourceRef.replace(/.$/, '0'),
      '--xpod-image-digest', xpodImage,
    ]);
    expectFailure([
      'validate',
      '--manifest', manifest,
      '--source-ref', sourceRef,
      '--xpod-image-digest', xpodImage,
      '--postgres-image-digest', postgresImage.replace(/.$/, '3'),
    ]);
  });
});
