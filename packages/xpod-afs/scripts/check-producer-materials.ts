import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { resolveProducerMaterials } from './producer-materials';
const indexPath = createRequire(import.meta.url).resolve('@undefineds.co/xpod-cli/producer-materials');
const original = path.dirname(indexPath);
const originalPackage = path.resolve(original, '../..');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'afs-material-negative-'));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let passed = 0;
const accepted: string[] = [];
try {
  await resolveProducerMaterials(indexPath);
  for (const change of ['missing', 'hash-drift', 'duplicate', 'path-traversal', 'symlink', 'unlisted', 'source-inventory', 'client-payload', 'source-authority', 'directory-traversal', 'control-path', 'tar-missing-member', 'tar-replaced-content', 'async-metafile-drift', 'async-archive-drift', 'async-inventory-drift', 'async-client-drift']) {
    const pkg = path.join(scratch, change); const root = path.join(pkg, 'dist/producer-materials');
    mkdirSync(path.dirname(root), { recursive: true }); cpSync(original, root, { recursive: true });
    cpSync(path.join(originalPackage, 'package.json'), path.join(pkg, 'package.json'));
    for (const file of ['client.cjs', 'client.mjs']) cpSync(path.join(originalPackage, 'dist', file), path.join(pkg, 'dist', file));
    const indexFile = path.join(root, 'index.json'); const index = JSON.parse(readFileSync(indexFile, 'utf8'));
    const member = path.join(root, index.clientMetafile);
    if (change === 'missing') unlinkSync(member);
    if (change === 'hash-drift') writeFileSync(member, Buffer.concat([readFileSync(member), Buffer.from('changed')]));
    if (change === 'duplicate') index.files.push(index.files[0]);
    if (change === 'path-traversal') index.files[0].path = '../escape';
    if (change === 'symlink') { unlinkSync(member); const owned = path.join(pkg, 'owned-file'); writeFileSync(owned, 'fixture'); symlinkSync(owned, member); }
    if (change === 'unlisted') writeFileSync(path.join(root, 'unexpected'), 'fixture');
    if (change === 'source-inventory') {
      const filename = path.join(root, index.sourceInventory); const source = JSON.parse(readFileSync(filename, 'utf8'));
      source.files[0].sha256 = '0'.repeat(64); const bytes = Buffer.from(JSON.stringify(source)); writeFileSync(filename, bytes);
      const entry = index.files.find((file: { path: string }) => file.path === index.sourceInventory); entry.bytes = bytes.length; entry.sha256 = hash(bytes);
    }
    if (change === 'client-payload') writeFileSync(path.join(pkg, 'dist/client.cjs'), 'changed');
    if (change === 'source-authority') index.sourceAuthority.snapshotSHA256 = '0'.repeat(64);
    if (change === 'directory-traversal') index.sourceDirectory = '../escape';
    if (change === 'control-path') index.files[0].path = 'unsafe\nname';
    if (change === 'tar-missing-member' || change === 'tar-replaced-content') {
      // Keep the declared source directory/inventory unchanged. Alter only the
      // delivery archive and honestly rebind its outer hash: inner membership
      // must independently reject this otherwise-consistent outer inventory.
      const packedSource = path.join(scratch, 'packed-' + change);
      cpSync(path.join(root, index.sourceDirectory), packedSource, { recursive: true });
      const source = JSON.parse(readFileSync(path.join(root, index.sourceInventory), 'utf8'));
      const changed = path.join(packedSource, source.files[0].path);
      if (change === 'tar-missing-member') unlinkSync(changed);
      else writeFileSync(changed, Buffer.concat([readFileSync(changed), Buffer.from('changed fixture content')]));
      const archive = path.join(root, index.clientSource);
      const result = spawnSync('tar', ['-czf', archive, '-C', packedSource, '.']);
      if (result.error || result.status !== 0 || result.signal) throw new Error('Producer negative archive creation failed');
      const bytes = readFileSync(archive);
      const entry = index.files.find((file: { path: string }) => file.path === index.clientSource);
      entry.bytes = bytes.length; entry.sha256 = hash(bytes);
    }
    writeFileSync(indexFile, JSON.stringify(index));
    let rejected = false;
    // The real verifier is async. Mutate after validation has reached its await,
    // without mocking or replacing the public parser.
    const pending = resolveProducerMaterials(indexFile);
    if (change.startsWith('async-')) {
      const target = change === 'async-client-drift' ? path.join(pkg, 'dist/client.cjs')
        : path.join(root, change === 'async-archive-drift' ? index.clientSource : change === 'async-inventory-drift' ? index.sourceInventory : index.clientMetafile);
      writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from('async changed fixture')]));
    }
    try { await pending; } catch { rejected = true; }
    if (!rejected) accepted.push(change);
    else passed++;
  }
  console.log(JSON.stringify({ actualPublicInventoryPassed: true, rejectedNegatives: passed, incorrectlyAccepted: accepted, nativeAdmission: false }));
  if (accepted.length) throw new Error('Producer material negatives accepted: ' + accepted.join(', '));
} finally { rmSync(scratch, { recursive: true, force: true }); }
