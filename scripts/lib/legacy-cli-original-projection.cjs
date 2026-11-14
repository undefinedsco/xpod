'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const io = require('./root-registry-supply.cjs');
const normal = require('../check-afs-js-archive-ci.cjs');
const MAX = 8 * 1024 ** 2;
function read(root, member) { return io.readRegular(path.join(root, member), MAX); }
function digest(bytes) { return require('node:crypto').createHash('sha256').update(bytes).digest('hex'); }
function required(cleanup) {
  const names = ['result.json', 'source-inputs.json', 'cleanup.json', 'cli.tgz', 'client.tgz'];
  for (const outcome of cleanup.commandOutcomes) {
    names.push(outcome.receipt.path, ...outcome.raw.map(row => row.path));
  }
  assert.equal(names.length, 35);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^(?:result\.json|source-inputs\.json|cleanup\.json|cli\.tgz|client\.tgz|phase-\d{3}(?:\.receipt\.json|\.(?:stdout|stderr)\.raw\.log))$/);
  return names.sort();
}
function createProjection(source, destination, identity) {
  const resultBytes = read(source, 'result.json'), result = JSON.parse(resultBytes);
  const cleanup = JSON.parse(read(source, 'cleanup.json'));
  normal.closedCliOriginals(cleanup, source);
  assert.equal(result.context.checkoutSha, identity.sourceSha);
  assert.equal(String(result.context.runId), String(identity.runId));
  assert.equal(Number(result.context.runAttempt), Number(identity.runAttempt));
  assert.equal(result.inventory.path, 'inventory.json');
  const inventoryBytes = read(source, 'inventory.json');
  assert.equal(digest(inventoryBytes), result.inventory.sha256);
  const full = JSON.parse(inventoryBytes);
  assert.ok(Array.isArray(full.files) && full.files.length <= 100000);
  const originalRows = new Map();
  for (const row of full.files) { assert.equal(originalRows.has(row.path), false); originalRows.set(row.path, row); }
  assert.equal(result.sourceMaterials.path, 'source-materials/materials.json');
  const material = read(source, result.sourceMaterials.path);
  assert.equal(digest(material), result.sourceMaterials.sha256);
  assert.equal(material.length, result.sourceMaterials.bytes);
  const members = required(cleanup).map(member => {
    const bytes = read(source, member), sha256 = digest(bytes);
    if (member !== 'result.json') { const row = originalRows.get(member); assert.equal(row?.sha256, sha256); assert.equal(row?.bytes, bytes.length); }
    return { member, bytes: bytes.length, sha256, original: bytes };
  });
  assert.ok(members.reduce((sum, row) => sum + row.bytes, 0) <= 32 * 1024 ** 2);
  const projection = { schemaVersion: 1, kind: 'legacy-cli-required-original-projection', sourceQualified: false,
    fullOriginals: { artifactName: `legacy-root-normal-cli-originals-${identity.sourceSha}-${identity.runId}-${identity.runAttempt}`,
      sourceSha: identity.sourceSha, runId: String(identity.runId), runAttempt: Number(identity.runAttempt),
      result: { bytes: resultBytes.length, sha256: digest(resultBytes) }, inventory: { bytes: inventoryBytes.length, sha256: digest(inventoryBytes) }, sourceMaterials: result.sourceMaterials },
    members: members.map(({ original, ...row }) => row) };
  fs.mkdirSync(destination);
  for (const row of members) fs.writeFileSync(path.join(destination, row.member), row.original, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(destination, 'projection.original.json'), JSON.stringify(projection, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  verifyProjection(destination, identity);
  return projection;
}
function verifyProjection(directory, identity) {
  const record = JSON.parse(read(directory, 'projection.original.json'));
  assert.equal(record.kind, 'legacy-cli-required-original-projection'); assert.equal(record.schemaVersion, 1); assert.equal(record.sourceQualified, false);
  const full = record.fullOriginals;
  assert.equal(full.sourceSha, identity.sourceSha); assert.equal(full.runId, String(identity.runId)); assert.equal(full.runAttempt, Number(identity.runAttempt));
  assert.equal(full.artifactName, `legacy-root-normal-cli-originals-${identity.sourceSha}-${identity.runId}-${identity.runAttempt}`);
  const cleanup = JSON.parse(read(directory, 'cleanup.json')); normal.closedCliOriginals(cleanup, directory);
  assert.deepEqual(record.members.map(row => row.member), required(cleanup));
  assert.deepEqual(fs.readdirSync(directory).sort(), [...required(cleanup), 'projection.original.json'].sort());
  for (const row of record.members) { const bytes = read(directory, row.member); assert.equal(bytes.length, row.bytes); assert.equal(digest(bytes), row.sha256); }
  const resultBytes = read(directory, 'result.json'), result = JSON.parse(resultBytes);
  assert.equal(resultBytes.length, full.result.bytes); assert.equal(digest(resultBytes), full.result.sha256);
  assert.equal(result.inventory.sha256, full.inventory.sha256); assert.deepEqual(result.sourceMaterials, full.sourceMaterials);
  return record;
}
module.exports = { createProjection, verifyProjection };
