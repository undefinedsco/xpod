import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { externalRefreshFromEnvironment, readExternalRefreshFixture, verifyExternalRefreshStorage } from './browserExternalRefreshFixture';

async function fixture(run: (root: string, manifest: string, input: any) => void | Promise<void>): Promise<void> {
  const parent = path.resolve('.test-data/external-refresh-contract');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'owned-'));
  const manifest = path.join(root, 'manifest.json');
  const input = { schemaVersion: 1, sourceSha: 'a'.repeat(40), mode: 'local', baseUrl: 'http://127.0.0.1:49101/',
    issuer: 'http://localhost:49102/', image: { reference: `example/image@sha256:${'b'.repeat(64)}`, platform: 'linux/amd64', id: `sha256:${'c'.repeat(64)}` },
    profile: { kind: 'renew', accessTokenTtl: 30, refreshTokenTtl: 180, originalConfigSHA256: 'd'.repeat(64), derivedConfigSHA256: 'e'.repeat(64) },
    binding: { webId: 'http://localhost:49102/alice/profile/card#me', podUrl: 'http://127.0.0.1:49101/alice/' },
    ownershipRoot: root, accountFile: path.join(root, 'account.json'), outputDirectory: path.join(root, 'output') };
  mkdirSync(input.outputDirectory, { mode: 0o700 });
  writeFileSync(input.accountFile, JSON.stringify({ email: 'fixture@example.invalid', password: 'private-fixture', ...input.binding }), { mode: 0o600 });
  writeFileSync(manifest, JSON.stringify(input), { mode: 0o600 });
  try { await run(root, manifest, input); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('external mode presence fails closed including empty input; absent keeps default', () => {
  assert.equal(externalRefreshFromEnvironment({}), undefined);
  assert.throws(() => externalRefreshFromEnvironment({ XPOD_E2E_REFRESH_MANIFEST: '' }));
  assert.throws(() => externalRefreshFromEnvironment({ XPOD_E2E_REFRESH_MANIFEST: '/missing' }));
});

test('authoritative managed Local binding is used without deriving WebID from Pod', () => fixture((_root, manifest, input) => {
  const result = readExternalRefreshFixture(manifest);
  assert.equal(result.ready.account.webId, input.binding.webId);
  assert.equal(result.ready.account.podUrl, input.binding.podUrl);
  assert.notEqual(new URL(result.ready.account.webId).origin, new URL(result.ready.account.podUrl).origin);
}));

test('private account and manifest modes and exact binding are mandatory', () => fixture((_root, manifest, input) => {
  chmodSync(manifest, 0o644);
  assert.throws(() => readExternalRefreshFixture(manifest));
  chmodSync(manifest, 0o600);
  chmodSync(input.accountFile, 0o644);
  assert.throws(() => readExternalRefreshFixture(manifest));
  chmodSync(input.accountFile, 0o600);
  writeFileSync(input.accountFile, JSON.stringify({ email: 'fixture@example.invalid', password: 'private-fixture', ...input.binding, webId: 'http://localhost:49102/other#me' }));
  assert.throws(() => readExternalRefreshFixture(manifest));
}));

test('symlinked file, output ancestor and escape paths are rejected', () => fixture((root, manifest, input) => {
  const account = input.accountFile;
  input.accountFile = path.join(root, 'alias.json');
  symlinkSync(account, input.accountFile);
  writeFileSync(manifest, JSON.stringify(input));
  assert.throws(() => readExternalRefreshFixture(manifest));
  input.accountFile = account;
  symlinkSync(input.outputDirectory, path.join(root, 'alias-output'));
  input.outputDirectory = path.join(root, 'alias-output');
  writeFileSync(manifest, JSON.stringify(input));
  assert.throws(() => readExternalRefreshFixture(manifest));
  input.outputDirectory = path.dirname(root);
  writeFileSync(manifest, JSON.stringify(input));
  assert.throws(() => readExternalRefreshFixture(manifest));
}));

test('a Cloud Pod cannot satisfy Local storage acceptance; policy drift rejected centrally', () => fixture(async (_root, manifest, input) => {
  input.binding.podUrl = 'http://localhost:49102/cloud-pod/';
  const transport = (async () => Response.json({ publicUrl: 'https://local-pod.example.invalid/' })) as typeof fetch;
  await assert.rejects(verifyExternalRefreshStorage(input, transport), /managed Local route/);
  input.profile.accessTokenTtl = 3600;
  writeFileSync(manifest, JSON.stringify(input));
  assert.throws(() => readExternalRefreshFixture(manifest), /policy/);
}));

test('shared SDK route accepts a canonical Local domain distinct from management origin', () => fixture(async (_root, _manifest, input) => {
  input.binding.podUrl = 'https://local-pod.example.invalid/alice/';
  const requests: string[] = [];
  const transport = (async (value: string | URL | Request) => {
    requests.push(value instanceof Request ? value.url : String(value));
    return requests.length === 1 ? Response.json({ publicUrl: 'https://local-pod.example.invalid/' }) : new Response(null, { status: 403 });
  }) as typeof fetch;
  const localFetch = await verifyExternalRefreshStorage(input, transport);
  assert.equal((await localFetch(new URL('private.txt', input.binding.podUrl))).status, 403);
  assert.equal(requests[0], 'http://127.0.0.1:49101/provision/status');
  assert.equal(requests[1], 'http://127.0.0.1:49101/alice/private.txt');
}));

test('B creates one private output directory after validation and never creates parents', () => fixture((root, manifest, input) => {
  input.outputDirectory = path.join(root, 'not-created-yet');
  writeFileSync(manifest, JSON.stringify(input));
  assert.throws(() => readExternalRefreshFixture(manifest));
  assert.equal(readExternalRefreshFixture(manifest, true).input.outputDirectory, input.outputDirectory);
  input.outputDirectory = path.join(root, 'missing-parent', 'output');
  writeFileSync(manifest, JSON.stringify(input));
  assert.throws(() => readExternalRefreshFixture(manifest, true));
}));
