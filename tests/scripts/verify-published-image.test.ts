import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const testRoot = path.join(repoRoot, '.test-data', 'verify-published-image');
const binRoot = path.join(testRoot, 'bin');
const script = path.join(repoRoot, 'scripts', 'verify-published-image.cjs');
// Fixture projection from GitHub run 33803278992: tested config, pushed index, and linux/amd64 child manifest digests.
const configDigest = 'sha256:c1d4fde330ea6a35ae7a958fa5e4aba81b0b7a0c63d34cfc59f92dbf1b234ef8';
const childDigest = 'sha256:547a5b4c9debe3311648f3f1e5858e78fcc894a2863c7d9c6ec7b4c59617b945';
const indexRef = 'ghcr.io/acme/qlever@sha256:29a4aebb421e4a139c0e5ac1b18e2424d809f75e3a4bc4e4e9ee2eccc6fa0a42';
const childRef = `ghcr.io/acme/qlever@${childDigest}`;

function manifest(digest = configDigest, mediaType = 'application/vnd.oci.image.manifest.v1+json') {
  return { schemaVersion: 2, mediaType, config: { digest }, layers: [] };
}

function index(manifests: unknown[]) {
  return { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests };
}

function platformDescriptor(digest = childDigest, platform = { os: 'linux', architecture: 'amd64' }) {
  return { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest, platform };
}

function attestationDescriptor() {
  return {
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    digest: `sha256:${'a'.repeat(64)}`,
    platform: { os: 'unknown', architecture: 'unknown' },
    annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
  };
}

function writeFakeDocker(): void {
  mkdirSync(binRoot, { recursive: true });
  writeFileSync(path.join(binRoot, 'docker'), `#!/usr/bin/env node
if (process.env.XPOD_FAKE_DOCKER_FAIL) process.exit(42);
if (process.argv.slice(2, -1).join(' ') !== 'buildx imagetools inspect --raw') process.exit(44);
const fixtures = JSON.parse(process.env.XPOD_FAKE_DOCKER_FIXTURES || '{}');
const ref = process.argv[process.argv.length - 1];
if (!/^[^\\s@]+@sha256:[a-f0-9]{64}$/.test(ref)) process.exit(45);
if (!fixtures[ref]) process.exit(43);
if (fixtures[ref] === '__MALFORMED_JSON__') {
  process.stdout.write('{');
  process.exit(0);
}
process.stdout.write(JSON.stringify(fixtures[ref]));
`);
  chmodSync(path.join(binRoot, 'docker'), 0o755);
}

function run(tested: string, published: string, fixtures: Record<string, unknown> = {}, failDocker = false) {
  return spawnSync(process.execPath, [ script, tested, published ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binRoot}:${process.env.PATH}`,
      XPOD_FAKE_DOCKER_FAIL: failDocker ? '1' : '',
      XPOD_FAKE_DOCKER_FIXTURES: JSON.stringify(fixtures),
    },
  });
}

beforeEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  writeFakeDocker();
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('verify-published-image CLI', () => {
  it('accepts an attested index whose digest differs from the matching linux/amd64 config digest', () => {
    const result = run(configDigest, indexRef, {
      [indexRef]: index([ platformDescriptor(), attestationDescriptor() ]),
      [childRef]: manifest(),
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('accepts a direct single manifest when its config digest matches the tested image id', () => {
    const manifestRef = `ghcr.io/acme/qlever@sha256:${'2'.repeat(64)}`;

    expect(run(configDigest, manifestRef, { [manifestRef]: manifest() }).status).toBe(0);
  });

  it('accepts a Docker schema2 direct manifest when its config digest matches', () => {
    const manifestRef = `ghcr.io/acme/qlever@sha256:${'7'.repeat(64)}`;

    expect(run(
      configDigest,
      manifestRef,
      { [manifestRef]: manifest(configDigest, 'application/vnd.docker.distribution.manifest.v2+json') },
    ).status).toBe(0);
  });

  it.each([
    [ 'mismatched config digest', configDigest, indexRef, {
      [indexRef]: index([ platformDescriptor() ]),
      [childRef]: manifest(`sha256:${'d'.repeat(64)}`),
    }, false ],
    [ 'using the pushed index digest as the tested image id', indexRef.split('@')[1], indexRef, {
      [indexRef]: index([ platformDescriptor() ]),
      [childRef]: manifest(),
    }, false ],
    [ 'non-standard manifest type', configDigest, `ghcr.io/acme/qlever@sha256:${'3'.repeat(64)}`, {
      [`ghcr.io/acme/qlever@sha256:${'3'.repeat(64)}`]: manifest(configDigest, 'application/vnd.example.unknown'),
    }, false ],
    [ 'duplicate linux/amd64 descriptors', configDigest, indexRef, {
      [indexRef]: index([ platformDescriptor(), platformDescriptor(`sha256:${'6'.repeat(64)}`) ]),
    }, false ],
    [ 'missing platform descriptor', configDigest, indexRef, {
      [indexRef]: index([{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: childDigest }]),
    }, false ],
    [ 'wrong architecture descriptor', configDigest, indexRef, {
      [indexRef]: index([ platformDescriptor(childDigest, { os: 'linux', architecture: 'arm64' }) ]),
    }, false ],
    [ 'illegal child manifest digest', configDigest, indexRef, {
      [indexRef]: index([ platformDescriptor('sha256:SHORT') ]),
    }, false ],
    [ 'null index manifests', configDigest, indexRef, { [indexRef]: index(null as unknown as unknown[]) }, false ],
    [ 'malformed inspect JSON', configDigest, indexRef, { [indexRef]: '__MALFORMED_JSON__' }, false ],
    [ 'docker inspect failure', configDigest, indexRef, {}, true ],
    [ 'empty tested image digest', '', indexRef, {}, false ],
    [ 'uppercase tested image digest', `sha256:${'A'.repeat(64)}`, indexRef, {}, false ],
    [ 'illegal tested image digest', 'sha256:SHORT', indexRef, {}, false ],
    [ 'illegal published image reference digest', configDigest, 'ghcr.io/acme/qlever:mutable', {}, false ],
  ])('rejects %s', (_name, tested, published, fixtures, failDocker) => {
    const result = run(tested as string, published as string, fixtures as Record<string, unknown>, failDocker as boolean);

    expect(result.status).not.toBe(0);
  });
});
