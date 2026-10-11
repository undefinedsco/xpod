import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { t as listTar } from 'tar';

const safePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && !/[\x00-\x1f\x7f\\]/.test(value) && !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');

/** Verify the shipped archive itself against the complete source inventory. */
export async function verifyProducerSourceArchive(options: { archive: string; inventory: string }): Promise<void> {
  const inventory = JSON.parse(readFileSync(options.inventory, 'utf8'));
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.files) || !inventory.files.length) throw new Error('Invalid producer source inventory');
  const expected = new Map<string, { bytes: number; sha256: string }>();
  for (const file of inventory.files) {
    if (!safePath(file.path) || expected.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid producer source inventory member');
    expected.set(file.path, file);
  }
  const members = new Set<string>();
  const files = new Set<string>();
  let invalid = false;
  let rootSeen = false;
  await listTar({ file: options.archive, strict: true, onReadEntry: entry => {
    const name = entry.path.replace(/^\.\//, '').replace(/\/$/, '');
    // The producer tar includes one root directory header; it is not a file.
    if (entry.type === 'Directory' && (entry.path === './' || entry.path === '.')) {
      if (rootSeen) invalid = true;
      rootSeen = true; return;
    }
    if (!safePath(name) || members.has(name) || !['File', 'Directory'].includes(entry.type)) { invalid = true; return; }
    members.add(name);
    if (entry.type === 'Directory') {
      if (![...expected.keys()].some(file => file.startsWith(`${name}/`))) invalid = true;
      return;
    }
    const fact = expected.get(name);
    if (!fact || entry.size !== fact.bytes) { invalid = true; return; }
    files.add(name);
    const hash = createHash('sha256'); let size = 0;
    entry.on('data', (chunk: Buffer) => { size += chunk.length; hash.update(chunk); });
    entry.on('end', () => { if (size !== fact.bytes || hash.digest('hex') !== fact.sha256) invalid = true; });
    entry.on('error', () => { invalid = true; });
  } });
  if (invalid || files.size !== expected.size) throw new Error('Producer source archive differs from inventory');
}
