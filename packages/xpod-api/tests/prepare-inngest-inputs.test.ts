import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pins from '../scripts/inngest-input-pins.json';
import { prepareInngestInputs, verifyInngestIdentity } from '../scripts/prepare-inngest-inputs';

const release = () => ({ id: pins.releaseID, tag_name: `v${pins.version}`, draft: false, prerelease: false,
  html_url: `https://github.com/${pins.repository}/releases/tag/v${pins.version}`,
  assets: Object.values(pins.assets).map(asset => ({ ...asset,
    browser_download_url: `https://github.com/${pins.repository}/releases/download/v${pins.version}/${asset.name}` })) });
const tag = () => ({ ref: `refs/tags/v${pins.version}`, object: { type: 'commit', sha: pins.sourceCommit } });
async function fixture(action: (directory: string) => Promise<void>) {
  const parent = path.resolve('.test-data/inngest-input-fixtures'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-'));
  try { await action(path.join(root, 'inputs')); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('all four targets require the pinned release, commit, asset ID, size and digest', () => {
  for (const target of Object.keys(pins.assets) as Array<keyof typeof pins.assets>) {
    verifyInngestIdentity(release(), tag(), target);
    for (const key of ['id', 'size', 'digest', 'browser_download_url']) {
      const changed = release(); const asset = changed.assets.find(asset => asset.name === pins.assets[target].name)!;
      Object.assign(asset, { [key]: key === 'id' || key === 'size' ? 0 : 'changed' });
      assert.throws(() => verifyInngestIdentity(changed, tag(), target), /asset_identity_changed/);
    }
    const duplicate = release(); duplicate.assets.push(duplicate.assets.find(asset => asset.name === pins.assets[target].name)!);
    assert.throws(() => verifyInngestIdentity(duplicate, tag(), target), /asset_identity_changed/);
  }
  assert.throws(() => verifyInngestIdentity({ ...release(), id: 0 }, tag(), 'linux-x64'), /release_identity_changed/);
  assert.throws(() => verifyInngestIdentity(release(), { ...tag(), object: { type: 'tag', sha: pins.sourceCommit } }, 'linux-x64'), /release_identity_changed/);
});

test('an HTTP failure closes its body and stops before further requests', () => fixture(async directory => {
  let cancelled = false; let requests = 0;
  await assert.rejects(prepareInngestInputs('linux-arm64', directory, async () => {
    requests++;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 404 });
  }), /download_http_404/);
  assert.equal(requests, 1); assert.equal(cancelled, true);
  const receipt = JSON.parse(readFileSync(path.join(directory, 'prepare-inputs.receipt.safe.json'), 'utf8'));
  assert.equal(receipt.ok, false); assert.equal(receipt.streamsClosed, true); assert.equal(receipt.releaseAccepted, false);
}));

test('wrong archive bytes remain partial and do not trigger the source download', () => fixture(async directory => {
  const requests: string[] = [];
  await assert.rejects(prepareInngestInputs('darwin-x64', directory, async url => {
    requests.push(url);
    return new Response(url.includes('/releases/tags/') ? JSON.stringify(release()) : url.includes('/git/ref/') ? JSON.stringify(tag()) : 'wrong');
  }), /download_digest_changed/);
  assert.equal(requests.length, 3);
  assert.equal(existsSync(path.join(directory, 'inngest-official-darwin-x64.tar.gz')), false);
  assert.equal(readFileSync(path.join(directory, 'inngest-official-darwin-x64.tar.gz.partial'), 'utf8'), 'wrong');
  assert.equal(existsSync(path.join(directory, 'inngest-original-source.tar.gz')), false);
}));

test('existing evidence is preserved without contacting the network', () => fixture(async directory => {
  mkdirSync(directory); writeFileSync(path.join(directory, 'original'), 'preserved'); let requests = 0;
  await assert.rejects(prepareInngestInputs('linux-x64', directory, async () => { requests++; throw new Error('must not fetch'); }));
  assert.equal(requests, 0); assert.equal(readFileSync(path.join(directory, 'original'), 'utf8'), 'preserved');
}));

test('an actual response stream error closes the pipeline and stops before the source download', () => fixture(async directory => {
  let requests = 0;
  await assert.rejects(prepareInngestInputs('linux-x64', directory, async url => {
    requests++;
    if (url.includes('/releases/tags/')) return new Response(JSON.stringify(release()));
    if (url.includes('/git/ref/')) return new Response(JSON.stringify(tag()));
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error('fixture_stream_failure')); } }));
  }), /fixture_stream_failure/);
  assert.equal(requests, 3);
  const receipt = JSON.parse(readFileSync(path.join(directory, 'prepare-inputs.receipt.safe.json'), 'utf8'));
  assert.equal(receipt.ok, false); assert.equal(receipt.streamsClosed, true);
  assert.equal(existsSync(path.join(directory, 'inngest-original-source.tar.gz')), false);
}));

test('a receipt filesystem failure preserves the original download failure', () => fixture(async directory => {
  await assert.rejects(prepareInngestInputs('linux-arm64', directory, async url => {
    if (url.includes('/releases/tags/')) return new Response(JSON.stringify(release()));
    if (url.includes('/git/ref/')) return new Response(JSON.stringify(tag()));
    mkdirSync(path.join(directory, 'prepare-inputs.receipt.safe.json'));
    return new Response('wrong');
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].message, 'download_digest_changed');
    assert.equal(error.errors[1].code, 'EEXIST');
    return true;
  });
}));

test('failed body cancellation retains both errors and does not claim closed streams', () => fixture(async directory => {
  await assert.rejects(prepareInngestInputs('linux-x64', directory, async () =>
    new Response(new ReadableStream({ cancel() { throw new Error('fixture_cancel_failure'); } }), { status: 500 })), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].message, 'download_http_500');
    assert.equal(error.errors[1].message, 'fixture_cancel_failure');
    return true;
  });
  const receipt = JSON.parse(readFileSync(path.join(directory, 'prepare-inputs.receipt.safe.json'), 'utf8'));
  assert.equal(receipt.ok, false); assert.equal(receipt.streamsClosed, false);
}));
