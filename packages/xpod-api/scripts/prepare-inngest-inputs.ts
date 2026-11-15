import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pins from './inngest-input-pins.json';

type Target = keyof typeof pins.assets;
type FetchInput = (url: string) => Promise<Response>;
interface Download { path: string; bytes: number; sha256: string }

export function verifyInngestIdentity(release: any, tag: any, target: Target): void {
  if (!Object.prototype.hasOwnProperty.call(pins.assets, target)) throw new Error('unsupported_target');
  const expected = pins.assets[target];
  if (!expected) throw new Error('unsupported_target');
  if (release.id !== pins.releaseID || release.tag_name !== `v${pins.version}` || release.draft !== false || release.prerelease !== false
    || release.html_url !== `https://github.com/${pins.repository}/releases/tag/v${pins.version}`
    || tag.ref !== `refs/tags/v${pins.version}` || tag.object?.type !== 'commit' || tag.object.sha !== pins.sourceCommit) {
    throw new Error('release_identity_changed');
  }
  const matches = Array.isArray(release.assets) ? release.assets.filter((asset: any) => asset.name === expected.name) : [];
  if (matches.length !== 1 || Object.entries(expected).some(([key, value]) => matches[0][key] !== value)
    || matches[0].browser_download_url !== `https://github.com/${pins.repository}/releases/download/v${pins.version}/${expected.name}`) {
    throw new Error('asset_identity_changed');
  }
}

/** Fresh original inputs for native-material.ts; no packaging or release admission. */
export async function prepareInngestInputs(target: Target, output: string, fetchInput: FetchInput = officialFetch) {
  if (!Object.prototype.hasOwnProperty.call(pins.assets, target)) throw new Error('unsupported_target');
  const directory = path.resolve(output);
  if (directory === path.parse(directory).root) throw new Error('unsafe_output');
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory, { mode: 0o700 }); // Existing evidence is never overwritten.
  const downloads: Download[] = [];
  let failure: string | null = null;
  let streamsClosed = true;
  let primaryFailure: unknown;
  let failed = false;
  async function download(url: string, name: string, limit: number, expected?: { bytes: number; sha256: string }) {
    const response = await fetchInput(url);
    const httpRecord = JSON.stringify({
      url, status: response.status, headers: Object.fromEntries(['content-type', 'content-length', 'etag'].flatMap(key => {
        const value = response.headers.get(key); return value === null ? [] : [[key, value]];
      })),
    });
    try {
      await writeFile(path.join(directory, `${name}.http.safe.json`), httpRecord, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      try { await response.body?.cancel(); } catch (cleanup) {
        streamsClosed = false;
        throw new AggregateError([error, cleanup], 'HTTP evidence write and body close failed');
      }
      throw error;
    }
    if (!response.ok || !response.body) {
      const httpError = new Error(`download_http_${response.status}`);
      try { await response.body?.cancel(); } catch (error) {
        streamsClosed = false;
        throw new AggregateError([httpError, error], 'HTTP failure and body cancellation failed');
      }
      throw httpError;
    }
    const partial = path.join(directory, `${name}.partial`);
    const hash = createHash('sha256'); let bytes = 0;
    const measure = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) { callback(new Error('download_size_exceeded')); return; }
      hash.update(chunk); callback(null, chunk);
    } });
    const reader = Readable.fromWeb(response.body as any);
    const writer = createWriteStream(partial, { flags: 'wx', mode: 0o600 });
    try {
      await pipeline(reader, measure, writer);
    } finally {
      streamsClosed = streamsClosed && reader.closed && measure.closed && writer.closed;
    }
    const sha256 = hash.digest('hex');
    if (expected && (bytes !== expected.bytes || sha256 !== expected.sha256)) throw new Error('download_digest_changed');
    await rename(partial, path.join(directory, name));
    const record = { path: name, bytes, sha256 }; downloads.push(record);
    return record;
  }
  try {
    const api = `https://api.github.com/repos/${pins.repository}`;
    await download(`${api}/releases/tags/v${pins.version}`, 'inngest-release.raw.json', 2 * 1024 * 1024);
    await download(`${api}/git/ref/tags/v${pins.version}`, 'inngest-tag.raw.json', 2 * 1024 * 1024);
    const { readFile } = await import('node:fs/promises');
    const release = JSON.parse(await readFile(path.join(directory, 'inngest-release.raw.json'), 'utf8'));
    const tag = JSON.parse(await readFile(path.join(directory, 'inngest-tag.raw.json'), 'utf8'));
    verifyInngestIdentity(release, tag, target);
    const asset = pins.assets[target];
    await download(`https://github.com/${pins.repository}/releases/download/v${pins.version}/${asset.name}`,
      `inngest-official-${target}.tar.gz`, asset.size, { bytes: asset.size, sha256: asset.digest.slice(7) });
    await download(`${api}/tarball/${pins.sourceCommit}`, 'inngest-original-source.tar.gz', pins.sourceArchive.bytes, pins.sourceArchive);
  } catch (error) {
    failed = true;
    primaryFailure = error;
    failure = error instanceof Error ? error.message : 'input_preparation_failed';
    throw error;
  } finally {
    try {
      await writeFile(path.join(directory, 'prepare-inputs.receipt.safe.json'), JSON.stringify({
        schemaVersion: 1, target, repository: pins.repository, version: pins.version,
        releaseID: pins.releaseID, assetID: pins.assets[target].id, sourceCommit: pins.sourceCommit,
        ok: failure === null, failure, downloads, streamsClosed, releaseAccepted: false,
        scope: 'Original download identity and byte binding; no native execution or build/toolchain admission',
      }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (receiptError) {
      if (failed) throw new AggregateError([primaryFailure, receiptError], 'Input preparation and receipt write failed');
      throw receiptError;
    }
  }
  return { target, directory, releaseAccepted: false };
}

function officialFetch(url: string): Promise<Response> {
  const headers: Record<string, string> = { 'User-Agent': 'xpod-api-input-producer' };
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (url.startsWith('https://api.github.com/') && token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--target' || args[2] !== '--out' || !args[3] || args[3].startsWith('--')) {
    throw new Error('Usage: bun prepare-inngest-inputs.ts --target TARGET --out FRESH_DIRECTORY');
  }
  const result = await prepareInngestInputs(args[1] as Target, args[3]);
  process.stdout.write(JSON.stringify(result) + '\n');
}
