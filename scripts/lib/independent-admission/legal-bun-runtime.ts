import { captureLegalFileIdentity, assertLegalFileIdentity, type LegalFileIdentity } from './legal-file-custody';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, stat, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as yauzl from 'yauzl';
const TARGETS = {
  x64: { name: 'bun-linux-x64.zip', sha256: '36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913', root: 'bun-linux-x64' },
  arm64: { name: 'bun-linux-aarch64.zip', sha256: '54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7', root: 'bun-linux-aarch64' },
} as const;
const SUMS_SHA = '99ebf3e6afe003b57eae3f257abce7e9aa851452429e84ef16b1b401e9d7cff1';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fail(reason: string): never { throw Error('Official Bun runtime: ' + reason); }
async function fileHash(filename: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename, { highWaterMark: 65536 })) digest.update(chunk);
  return digest.digest('hex');
}
async function official(url: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { signal });
  const host = new URL(response.url).hostname;
  if (!response.ok || !response.body || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(host)) fail('official asset response rejected');
  return response;
}
async function* responseChunks(response: Response): AsyncGenerator<Uint8Array> {
  if (!response.body) fail('asset body absent');
  const reader = response.body.getReader();
  try { for (;;) { const next = await reader.read(); if (next.done) return; yield next.value; } }
  finally { await reader.cancel().catch(() => {}); }
}
/** Fixed current-controller target only; no downloaded code is ever executed.
 * ZIP and checksum custody remains on disk, including failed partial downloads. */
export async function observeLinuxBun142Executable(): Promise<{ sha256: string; archivePath: string; archiveSha256: string; archiveIdentity: LegalFileIdentity }> {
  if (process.platform !== 'linux' || !(process.arch in TARGETS)) fail('unsupported controller target');
  const target = TARGETS[process.arch as keyof typeof TARGETS];
  const signal = AbortSignal.timeout(30000);
  const root = fileURLToPath(new URL('../../../.test-data/legal-bun-runtime/', import.meta.url));
  await mkdir(root, { recursive: true });
  const sumsResponse = await official('https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/SHASUMS256.txt', signal);
  const sumsChunks: Buffer[] = []; let sumsBytes = 0;
  for await (const bytes of responseChunks(sumsResponse)) { sumsBytes += bytes.length; if (sumsBytes > 8192) fail('checksum budget'); sumsChunks.push(Buffer.from(bytes)); }
  const sums = Buffer.concat(sumsChunks);
  if (hash(sums) !== SUMS_SHA || !sums.toString().split('\n').includes(target.sha256 + '  ' + target.name)) fail('fixed release checksum differs');
  const sumsPath = path.join(root, 'SHASUMS256.' + SUMS_SHA + '.original.txt');
  await open(sumsPath, 'wx').then(async file => { try { await file.writeFile(sums); } finally { await file.close(); } }).catch(async error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await fileHash(sumsPath) !== SUMS_SHA) throw error; });
  await chmod(sumsPath, 0o444);
  const archivePath = path.join(root, target.name + '.' + target.sha256 + '.original.zip');
  const exists = await stat(archivePath).catch(() => undefined);
  if (!exists) {
    const temporary = archivePath + '.download.original';
    const file = await open(temporary, 'wx'); let size = 0;
    try {
      const response = await official('https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/' + target.name, signal);
      for await (const bytes of responseChunks(response)) {
        size += bytes.length; if (size > 64 * 1024 ** 2 - 8192) fail('single-target aggregate download budget');
        for (let offset = 0; offset < bytes.length; offset += 65536) await file.writeFile(Buffer.from(bytes.subarray(offset, offset + 65536)));
      }
    } finally { await file.close(); }
    if (await fileHash(temporary) !== target.sha256) fail('downloaded ZIP differs');
    // Preserve the verified audit original; no overwrite or deletion of originals.
    await chmod(temporary, 0o444);
    const { link } = await import('node:fs/promises'); await link(temporary, archivePath);
  }
  const archiveIdentity = captureLegalFileIdentity(archivePath);
  if ((await stat(archivePath)).size > 64 * 1024 ** 2 - 8192 || await fileHash(archivePath) !== target.sha256) fail('cached ZIP differs');
  if (signal.aborted) fail('asset verification deadline');
  const executableHash = await inspectBunExecutableZip(archivePath, target.root, signal);
  assertLegalFileIdentity(archiveIdentity);
  const executableIdentity = captureLegalFileIdentity(process.execPath);
  if (signal.aborted || await fileHash(process.execPath) !== executableHash) fail('official ZIP executable differs from controller');
  assertLegalFileIdentity(executableIdentity);
  assertLegalFileIdentity(archiveIdentity);
  return Object.freeze({ sha256: executableHash, archivePath, archiveSha256: target.sha256, archiveIdentity });
}

/** Bounded ZIP parser only, never official custody or an executable issuer. */
export function inspectBunExecutableZip(archivePath: string, expectedRoot: string, signal: AbortSignal): Promise<string> {
  if (!/^bun-linux-(?:x64|aarch64)$/u.test(expectedRoot) || signal.aborted) return Promise.reject(Error('ZIP target/deadline'));
  return new Promise<string>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(error ?? Error('ZIP missing')); return; }
      const entries: yauzl.Entry[] = []; const names = new Set<string>(); let expanded = 0;
      const abort = () => { zip.close(); reject(Error('Official Bun runtime: ZIP deadline')); };
      signal.addEventListener('abort', abort, { once: true });
      const failed = (reason: unknown) => { signal.removeEventListener('abort', abort); zip.close(); reject(reason); };
      zip.on('error', failed);
      zip.on('entry', entry => {
        const mode = entry.externalFileAttributes >>> 16;
        if (names.has(entry.fileName) || entries.length >= 8 || ![expectedRoot + '/', expectedRoot + '/bun'].includes(entry.fileName)
          || ((mode & 0o170000) !== 0 && (mode & 0o170000) !== (entry.fileName.endsWith('/') ? 0o040000 : 0o100000)) || (entry.generalPurposeBitFlag & 1)) { failed(Error('Unsafe official ZIP inventory')); return; }
        names.add(entry.fileName); expanded += entry.uncompressedSize;
        if (expanded > 256 * 1024 ** 2) { failed(Error('ZIP expansion budget')); return; }
        entries.push(entry); zip.readEntry();
      });
      zip.on('end', () => {
        const entry = entries.find(row => row.fileName === expectedRoot + '/bun');
        if (!entry || !entry.uncompressedSize) { failed(Error('Exact official executable absent')); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { failed(streamError ?? Error('ZIP executable stream missing')); return; }
          const digest = createHash('sha256'); let size = 0;
          stream.on('error', failed);
          stream.on('data', (bytes: Buffer) => { size += bytes.length; if (size > entry.uncompressedSize) { stream.destroy(Error('ZIP executable size')); return; } digest.update(bytes); });
          stream.on('end', () => { if (size !== entry.uncompressedSize) { failed(Error('ZIP executable truncated')); return; } signal.removeEventListener('abort', abort); zip.close(); resolve(digest.digest('hex')); });
        });
      });
      zip.readEntry();
    });
  });
}
