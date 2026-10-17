import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { indexProductArchiveOnDisk, productDiskInventoryLimits } from '../../scripts/lib/independent-admission/product-disk-inventory';
function tgz(rows: { name: string; text?: string; type?: string; size?: number; mode?: number }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const row of rows) {
    const header = Buffer.alloc(512); header.write(row.name); header.write((row.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100);
    header.write((row.size ?? Buffer.byteLength(row.text ?? '')).toString(8).padStart(11, '0') + '\0', 124);
    header.write('ustar\0', 257); header.write('00', 263);
    header[156] = (row.type ?? '0').charCodeAt(0); header.fill(32, 148, 156);
    header.write([...header].reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    const bytes = Buffer.from(row.text ?? ''); blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
async function fixture(run: (file: string, root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'disk-inventory-'));
  try { await run(path.join(root, 'product.tgz'), root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('real tiny tgz disk index binds archive/member hashes and returns independent buffers', async () => {
  await fixture(async file => {
    const bytes = tgz([{ name: 'package/', type: '5', mode: 0o755 }, { name: 'package/package.json', text: '{"name":"tiny"}' }, { name: 'package/bin/run', text: 'hello', mode: 0o755 }]);
    fs.writeFileSync(file, bytes);
    const inventory = await indexProductArchiveOnDisk(file);
    try {
      expect(inventory.archive.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(inventory.members.length).toBe(2); expect(Object.isFrozen(inventory.members[0])).toBe(true);
      const member = inventory.readMember('bin/run', 5); member.fill(0);
      expect(inventory.readMember('bin/run', 5).toString()).toBe('hello');
      expect(() => inventory.readMember('bin/run', 4)).toThrow();
      expect(() => inventory.readMember('../bin/run', 5)).toThrow();
      fs.writeFileSync(file, 'replacement does not replace bound snapshot');
      expect(inventory.readMember('bin/run', 5).toString()).toBe('hello');
    } finally { inventory.dispose(); }
    expect(() => inventory.readMember('bin/run', 5)).toThrow();
  });
});
test('links, escapes, duplicate/colliding paths, mode and member budgets reject', async () => {
  const manifest = { name: 'package/package.json', text: '{}' };
  const bad = [
    [{ name: 'package/link', type: '1' }], [{ name: 'package/link', type: '2' }],
    [{ name: 'package/../escape' }], [{ name: '/absolute' }], [{ name: 'other/file' }],
    [{ name: 'package/a' }, { name: 'package/a' }], [{ name: 'package/a' }, { name: 'package/a/b' }],
    [{ name: 'package/a/b' }, { name: 'package/a' }], [{ name: 'package/a', mode: 0o4755 }],
    [{ name: 'package/a', size: productDiskInventoryLimits.memberBytes + 1 }], [{ name: 'package/a', type: 'x' }],
  ];
  await fixture(async file => {
    for (const rows of bad) { fs.writeFileSync(file, tgz([manifest, ...rows])); await expect(indexProductArchiveOnDisk(file)).rejects.toThrow(); }
  });
});
test('hardlinked inputs and symlink inputs reject without extraction', async () => {
  await fixture(async (file, root) => {
    fs.writeFileSync(file, tgz([{ name: 'package/package.json', text: '{}' }]));
    const alias = path.join(root, 'alias'); fs.linkSync(file, alias);
    await expect(indexProductArchiveOnDisk(file)).rejects.toThrow('single-link'); fs.unlinkSync(alias);
    fs.symlinkSync(file, alias); await expect(indexProductArchiveOnDisk(alias)).rejects.toThrow('linked'); fs.unlinkSync(alias);
    expect(Object.isFrozen(productDiskInventoryLimits)).toBe(true);
  });
});

test('checksum, truncation, end marker and nonzero tail are checked', async () => {
  await fixture(async file => {
    const good = tgz([{ name: 'package/package.json', text: '{}' }]);
    const raw = gunzipSync(good); const corrupted = Buffer.from(raw); corrupted[0] ^= 1;
    const trailing = Buffer.from(raw); trailing[trailing.length - 1] = 1;
    for (const bytes of [gzipSync(corrupted), good.subarray(0, good.length - 4),
      gzipSync(raw.subarray(0, raw.length - 1024)), gzipSync(trailing)]) {
      fs.writeFileSync(file, bytes); await expect(indexProductArchiveOnDisk(file)).rejects.toThrow();
    }
  });
});

test('bound private snapshot rejects post-index disk tampering', async () => {
  await fixture(async file => {
    fs.writeFileSync(file, tgz([{ name: 'package/package.json', text: '{}' }, { name: 'package/data', text: 'bound-payload' }]));
    const previous = new Set(fs.readdirSync(os.tmpdir()));
    const inventory = await indexProductArchiveOnDisk(file);
    try {
      const names = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('xpod-product-inventory-') && !previous.has(name));
      expect(names.length).toBe(1);
      const snapshot = path.join(os.tmpdir(), names[0], 'payload.tar');
      const bytes = fs.readFileSync(snapshot); const offset = bytes.indexOf('bound-payload');
      expect(offset >= 0).toBe(true); fs.chmodSync(snapshot, 0o600);
      const fd = fs.openSync(snapshot, 'r+');
      try { fs.writeSync(fd, Buffer.from('X'), 0, 1, offset); } finally { fs.closeSync(fd); }
      expect(() => inventory.readMember('data', 100)).toThrow('unchanged');
      expect(() => inventory.readMemberRange('data', 0, 1)).toThrow('unchanged');
    } finally { inventory.dispose(); }
  });
});
test('physical USTAR magic/version required; existing single-zero termination accepted', async () => {
  await fixture(async file => {
    const raw = gunzipSync(tgz([{ name: 'package/package.json', text: '{}' }]));
    for (const offset of [257, 263]) {
      const bad = Buffer.from(raw); bad[offset] = 88; bad.fill(32, 148, 156);
      bad.write([...bad.subarray(0, 512)].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
      fs.writeFileSync(file, gzipSync(bad)); await expect(indexProductArchiveOnDisk(file)).rejects.toThrow('USTAR');
    }
    fs.writeFileSync(file, gzipSync(raw.subarray(0, raw.length - 512)));
    const indexed = await indexProductArchiveOnDisk(file); indexed.dispose();
  });
});

test('range reader binds real member bytes, boundaries and fixed scratch budget', async () => {
  await fixture(async file => {
    const text = 'a'.repeat(65536) + 'boundary';
    fs.writeFileSync(file, tgz([{ name: 'package/package.json', text: '{}' }, { name: 'package/data', text }]));
    const inventory = await indexProductArchiveOnDisk(file);
    try {
      expect(inventory.readMemberRange('data', 65534, 6).toString()).toBe('aaboun');
      const copy = inventory.readMemberRange('data', 0, 65536); copy.fill(0);
      expect(inventory.readMemberRange('data', 0, 1).toString()).toBe('a');
      expect(inventory.readMemberRange('data', text.length, 0).length).toBe(0);
      for (const [offset, length] of [[-1, 1], [0, -1], [0, 65537], [text.length, 1],
        [text.length + 1, 0], [0.5, 1], [0, NaN], [Number.MAX_SAFE_INTEGER + 1, 0]]) {
        expect(() => inventory.readMemberRange('data', offset, length)).toThrow();
      }
      expect(() => inventory.readMemberRange('../data', 0, 1)).toThrow();
    } finally { inventory.dispose(); }
    expect(() => inventory.readMemberRange('data', 0, 1)).toThrow();
  });
});

test('range budget counts zero-length calls and rejects invalid input before reservation', async () => {
  await fixture(async file => {
    fs.writeFileSync(file, tgz([{ name: 'package/package.json', text: '{}' }, { name: 'package/empty', text: '' }]));
    const inventory = await indexProductArchiveOnDisk(file);
    try {
      for (let i = 0; i < 4; i++) expect(() => inventory.readMemberRange('empty', -1, 0)).toThrow();
      for (let i = 0; i < productDiskInventoryLimits.rangeCalls; i++) {
        const value = inventory.readMemberRange(i % 2 ? 'empty' : 'package.json', 0, i % 2 ? 0 : 1);
        expect(value.length).toBe(i % 2 ? 0 : 1);
      }
      expect(() => inventory.readMemberRange('empty', 0, 0)).toThrow('cumulative');
      // Exhausting range access does not change the full-read contract.
      expect(inventory.readMember('package.json', 2).toString()).toBe('{}');
    } finally { inventory.dispose(); }
    expect(() => inventory.readMemberRange('empty', 0, 0)).toThrow('unchanged');
  });
});
