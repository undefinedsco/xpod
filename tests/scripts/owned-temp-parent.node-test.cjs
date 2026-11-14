const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOwnedTempRoot, withOwnedTempRoot } = require('../../scripts/lib/owned-temp-root.cjs');
async function fixture(operation) {
  const parent = path.resolve('.test-data/owned-temp-parent'); fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'case-'));
  try { await operation(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const checked = parent => { const stat = fs.lstatSync(parent); return { parent, identity: { dev: stat.dev, ino: stat.ino } }; };
test('explicit parent keeps actual temporary files and rename destination together while default uses OS temp', () => fixture(async root => {
  const destination = path.join(root, 'output-parent'), foreign = path.join(root, 'other-os-temp'); fs.mkdirSync(destination); fs.mkdirSync(foreign);
  const previous = os.tmpdir; os.tmpdir = () => foreign;
  try {
    const ordinary = createOwnedTempRoot('default-'); assert.equal(path.dirname(ordinary.path), foreign); ordinary.cleanup();
    let temporary;
    await withOwnedTempRoot('same-volume-', async owned => {
      temporary = owned; assert.equal(path.dirname(owned), destination); assert.equal(fs.existsSync(path.join(destination, 'output.bin')), false);
      const source = path.join(owned, 'artifact.zip'); fs.writeFileSync(source, 'original bytes'); fs.renameSync(source, path.join(destination, 'output.bin'));
    }, checked(destination));
    assert.equal(fs.existsSync(temporary), false); assert.equal(fs.readFileSync(path.join(destination, 'output.bin'), 'utf8'), 'original bytes'); assert.deepEqual(fs.readdirSync(foreign), []);
  } finally { os.tmpdir = previous; }
}));
test('explicit parent rejects actual symlink ancestors and swapped directory identity before allocation', () => fixture(root => {
  const real = path.join(root, 'real'); fs.mkdirSync(real); const link = path.join(root, 'linked'); fs.symlinkSync(real, link);
  assert.throws(() => createOwnedTempRoot('owned-', { parent: link, identity: checked(real).identity }), /ancestors/); assert.deepEqual(fs.readdirSync(real), []);
  const original = checked(real); fs.renameSync(real, real + '.original'); fs.mkdirSync(real);
  assert.throws(() => createOwnedTempRoot('owned-', original), /identity changed/); assert.deepEqual(fs.readdirSync(real), []); assert.deepEqual(fs.readdirSync(real + '.original'), []);
}));
test('replacement of an owned root preserves both the replacement and the original on primary failure', () => fixture(async root => {
  const primary = new Error('actual operation failure'); let owned;
  await assert.rejects(withOwnedTempRoot('owned-', async directory => {
    owned = directory; fs.writeFileSync(path.join(directory, 'original'), 'original'); fs.renameSync(directory, directory + '.original'); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'replacement'), 'keep'); throw primary;
  }, checked(root)), error => error instanceof AggregateError && error.errors[0] === primary && error.errors[1].message.includes('ownership changed') && error.cause === primary);
  assert.equal(fs.readFileSync(path.join(owned, 'replacement'), 'utf8'), 'keep'); assert.equal(fs.readFileSync(path.join(owned + '.original', 'original'), 'utf8'), 'original');
}));
test('cleanup failure preserves primary and secondary without touching an unrelated destination', () => fixture(async root => {
  const primary = new Error('primary'), secondary = Object.assign(new Error('cleanup blocked'), { code: 'EACCES' }); const remove = fs.rmSync; let owned;
  const destination = path.join(root, 'existing-output'); fs.writeFileSync(destination, 'other owner');
  try {
    fs.rmSync = (file, options) => { if (file === owned) throw secondary; return remove(file, options); };
    await assert.rejects(withOwnedTempRoot('owned-', async directory => { owned = directory; throw primary; }, checked(root)), error => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === secondary && error.cause === primary);
  } finally { fs.rmSync = remove; }
  assert.equal(fs.readFileSync(destination, 'utf8'), 'other owner'); assert.equal(fs.existsSync(owned), true);
}));
