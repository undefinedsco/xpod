/**
 * Research baseline: direct filesystem API versus direct SQLite API.
 * Run: bun scripts/benchmark-directory-storage.ts
 * This does NOT benchmark AgentFS, FUSE/NFS, Pod, or a cold disk cache.
 */
import { Database } from 'bun:sqlite';
import {
  closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import { join, resolve } from 'node:path';

const rounds = 7;
const groups = [
  { name: '1KiB', size: 1024, count: 2000 },
  { name: '10KiB', size: 10 * 1024, count: 2000 },
  { name: '128KiB', size: 128 * 1024, count: 2000 },
];
const parent = resolve('.test-data/directory-storage-baseline');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'run-'));
const db = new Database(join(root, 'files.sqlite'));
let sink = 0;

interface Measurement {
  workload: string;
  operations: number;
  samplesMs: Record<string, number[]>;
  medianMs: Record<string, number>;
  averageUsPerOperation: Record<string, number>;
}
const measurements: Measurement[] = [];

function measure(workload: string, operations: number, variants: Record<string, () => void>): void {
  const entries = Object.entries(variants);
  const samplesMs = Object.fromEntries(entries.map(([name]) => [name, [] as number[]]));
  for (const [, fn] of entries) {
    fn();
  }
  for (let round = 0; round < rounds; round++) {
    // Rotate variant order to avoid always measuring one backend first.
    for (let offset = 0; offset < entries.length; offset++) {
      const [name, fn] = entries[(round + offset) % entries.length];
      const start = performance.now();
      fn();
      samplesMs[name].push(performance.now() - start);
    }
  }
  const medianMs = Object.fromEntries(entries.map(([name]) => {
    const sorted = [...samplesMs[name]].sort((a, b) => a - b);
    return [name, sorted[Math.floor(sorted.length / 2)]];
  }));
  measurements.push({
    workload, operations, samplesMs, medianMs,
    averageUsPerOperation: Object.fromEntries(entries.map(([name]) => [name, medianMs[name] * 1000 / operations])),
  });
}

function shuffled(count: number): number[] {
  const order = Array.from({ length: count }, (_, index) => index);
  let seed = 0x51a73;
  for (let index = count - 1; index > 0; index--) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const other = (seed >>> 0) % (index + 1);
    [order[index], order[other]] = [order[other], order[index]];
  }
  return order;
}

try {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0;');
  db.exec('CREATE TABLE files (group_name TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (group_name, name));');
  const insert = db.query('INSERT INTO files VALUES (?, ?, ?, ?)');
  const get = db.query<{ data: Uint8Array }, [string, string]>('SELECT data FROM files WHERE group_name=? AND name=?');
  const metadata = db.query<{ size: number }, [string, string]>('SELECT size FROM files WHERE group_name=? AND name=?');
  const listing = db.query<{ name: string }, [string]>('SELECT name FROM files WHERE group_name=?');
  const update = db.query('UPDATE files SET data=? WHERE group_name=? AND name=?');
  const fixtures = groups.map((group) => {
    const dir = join(root, group.name);
    mkdirSync(dir);
    const payload = randomBytes(group.size);
    const names = Array.from({ length: group.count }, (_, index) => `${index}.bin`);
    for (const name of names) {
      writeFileSync(join(dir, name), payload);
    }
    db.transaction(() => {
      for (const name of names) {
        insert.run(group.name, name, group.size, payload);
      }
    })();
    // Check full-byte equivalence before timing.
    for (const index of [0, Math.floor(group.count / 2), group.count - 1]) {
      const content = get.get(group.name, names[index]);
      if (!content || !Buffer.from(content.data).equals(readFileSync(join(dir, names[index])))) {
        throw new Error('Fixture data mismatch');
      }
    }
    return { ...group, dir, payload, names, order: shuffled(group.count) };
  });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  for (const group of fixtures) {
    measure(`random whole-file read ${group.name}`, group.count, {
      filesystem: () => {
        for (const index of group.order) {
          const data = readFileSync(join(group.dir, group.names[index]));
          sink += data.length + data[0];
        }
      },
      sqlite: () => {
        for (const index of group.order) {
          const data = get.get(group.name, group.names[index])!.data;
          sink += data.length + data[0];
        }
      },
    });
  }
  const group = fixtures[1];
  measure('metadata lookup 2000 files', group.count, {
    filesystem: () => {
      for (const index of group.order) {
        sink += statSync(join(group.dir, group.names[index])).size;
      }
    },
    sqlite: () => {
      for (const index of group.order) {
        sink += metadata.get(group.name, group.names[index])!.size;
      }
    },
  });
  measure('directory listing repeated 100 times', 100, {
    filesystem: () => {
      for (let index = 0; index < 100; index++) {
        sink += readdirSync(group.dir).length;
      }
    },
    sqlite: () => {
      for (let index = 0; index < 100; index++) {
        sink += listing.all(group.name).length;
      }
    },
  });
  const writeNames = group.order.slice(0, 200).map((index) => group.names[index]);
  const replacement = randomBytes(group.size);
  let filesystemFirstByte = 0;
  let sqliteFirstByte = 0;
  const nextWrite = () => {
    // Every invocation changes bytes, including after warmup, so SQLite
    // cannot skip writing unchanged pages on repeated overwrites.
    replacement[0] = (replacement[0] + 1) % 256;
  };
  const writeRows = () => {
    nextWrite();
    for (const name of writeNames) {
      update.run(replacement, group.name, name);
    }
    sqliteFirstByte = replacement[0];
  };
  const batch = db.transaction(writeRows);
  measure('overwrite 200 files 10KiB, buffered/NORMAL, checkpoint excluded', writeNames.length, {
    filesystem_no_fsync: () => {
      nextWrite();
      for (const name of writeNames) {
        writeFileSync(join(group.dir, name), replacement);
      }
      filesystemFirstByte = replacement[0];
    },
    sqlite_individual_NORMAL: writeRows,
    sqlite_batch_NORMAL: batch,
  });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA synchronous=FULL;');
  measure('overwrite 200 files 10KiB, per-file fsync / per-transaction FULL', writeNames.length, {
    filesystem_fsync: () => {
      nextWrite();
      for (const name of writeNames) {
        const fd = openSync(join(group.dir, name), 'w');
        try {
          writeFileSync(fd, replacement);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      filesystemFirstByte = replacement[0];
    },
    sqlite_individual_FULL: writeRows,
    sqlite_batch_FULL: batch,
  });
  for (const name of writeNames) {
    const file = readFileSync(join(group.dir, name));
    const row = Buffer.from(get.get(group.name, name)!.data);
    if (file[0] !== filesystemFirstByte || row[0] !== sqliteFirstByte ||
        !file.subarray(1).equals(replacement.subarray(1)) || !row.subarray(1).equals(replacement.subarray(1))) {
      throw new Error('Updated data mismatch');
    }
  }
  const output = {
    timestamp: new Date().toISOString(),
    environment: {
      platform: platform(), kernel: release(), cpu: cpus()[0]?.model, arch: process.arch,
      bun: Bun.version, sqlite: db.query('SELECT sqlite_version() AS version').get(),
    },
    protocol: {
      rounds, warmupRounds: 1, concurrency: 1, groups,
      scope: 'Direct synchronous Bun node:fs and bun:sqlite APIs; no mount, Pod or network.',
      cache: 'Warm OS cache; no forced eviction. SQLite connection reused, default page cache.',
      schema: 'One row per whole file BLOB, not AgentFS inode/chunk schema.',
      order: 'Deterministic shuffle; backend measurement order rotated per round.',
      writes: 'Existing-file overwrites; first byte changes every invocation, including warmup. SQLite WAL checkpoint excluded. Batch is one transaction per 200 files; per-file FULL is 200 transactions. FS fsync is not macOS F_FULLFSYNC. Different durability/atomicity semantics must not be conflated.',
      fixtures: '6000 files, 2000 per size; same random payload within each size group, no application compression; full-byte samples and final writes checked.',
      statistic: 'Median of 7 whole-workload durations; per-op values are amortized averages, not operation latency quantiles.',
    },
    measurements, sink,
  };
  console.log(JSON.stringify(output, null, 2));
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
