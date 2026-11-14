import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
/** Tiny non-executed archive: validates material admission, never real Bun behavior. */
export function fixtureZip(name = 'bun-darwin-aarch64/bun', mode = 0o100755): Buffer {
  const bytes = Buffer.from('not an executable; selection fixture only');
  const filename = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  crc = (crc ^ 0xffffffff) >>> 0;
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(filename.length, 28); central.writeUInt32LE((mode << 16) >>> 0, 38);
  const directory = Buffer.concat([central, filename]);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(local.length + filename.length + bytes.length, 16);
  return Buffer.concat([local, filename, bytes, directory, end]);
}
export function makeRuntimeFixture(root: string): string {
  const archive = fixtureZip();
  const bytes = Buffer.from('not an executable; selection fixture only');
  const provenance = { revision: '1.4.2+fixture', bunCommit: 'fixture-source', compiler: { platform: 'darwin-arm64',
    executableSha256: hash(bytes), officialArchiveSha256: hash(archive), officialArchiveUrl: 'https://example.invalid/fixture.zip' } };
  const pinDirectory = path.join(root, 'packages/xpod-cli/licenses/javascript/generated/1.4.2');
  mkdirSync(pinDirectory, { recursive: true });
  writeFileSync(path.join(pinDirectory, 'index.json'), JSON.stringify({ provenance, files: [] }));
  const authority = JSON.stringify({ schemaVersion: 1, version: '1.4.2', target: 'darwin-arm64',
    sourceCommit: 'fixture-source', executableSha256: hash(bytes), files: [],
    assessment: { status: 'pending', applicableRequirements: [], findings: ['fixture; no executable or legal qualification'] } });
  writeFileSync(path.join(root, 'bun.fixture.zip'), archive);
  writeFileSync(path.join(root, 'authority.json'), authority);
  const descriptor = path.join(root, 'runtime-input.json');
  writeFileSync(descriptor, JSON.stringify({ mode: 'controlled-preview', target: 'darwin-arm64',
    archive: 'bun.fixture.zip', authority: 'authority.json', authoritySha256: hash(authority) }));
  return descriptor;
}
