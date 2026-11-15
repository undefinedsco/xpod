const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tools } = require('../../scripts/lib/legacy-afs-supply.cjs');
// verify() also compares the original AFS stage source-manifest hash to this file.
const sourceFiles = [...tools, 'packages/xpod-afs/package.json'];

test('normal AFS producer tools and source manifest keep exact Git bytes with core.autocrlf=true', () => {
  const repository = path.resolve(__dirname, '../..');
  const parent = path.join(repository, '.test-data/legacy-source-eol'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  const emptyConfig = path.join(root, 'empty.config'); fs.writeFileSync(emptyConfig, '');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'core.safecrlf', 'false');
    fs.copyFileSync(path.join(repository, '.gitattributes'), path.join(root, '.gitattributes'));
    for (const file of sourceFiles) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      const blob = execFileSync('git', ['show', 'HEAD:' + file], { cwd: repository, env });
      assert.ok(blob.includes(10), file); assert.ok(!blob.includes(Buffer.from('\r\n')), file);
      fs.writeFileSync(path.join(root, file), blob);
    }
    git('add', '--', '.gitattributes', ...sourceFiles);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
    git('config', 'core.autocrlf', 'true');
    for (const file of sourceFiles) fs.unlinkSync(path.join(root, file));
    git('checkout', '--', ...sourceFiles);
    for (const file of sourceFiles) {
      assert.deepEqual(fs.readFileSync(path.join(root, file)), git('show', 'HEAD:' + file), file);
      const attributes = git('check-attr', 'text', 'eol', '--', file).toString();
      assert.ok(attributes.includes(': text: set'), attributes); assert.ok(attributes.includes(': eol: lf'), attributes);
    }
    assert.equal(git('status', '--porcelain', '--untracked-files=no').toString(), '');
    // Without attributes, the very same Git object checks out as CRLF and stays Git-clean.
    git('rm', '-q', '.gitattributes');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'remove attributes');
    const first = tools[0]; fs.unlinkSync(path.join(root, first)); git('checkout', '--', first);
    const blob = git('show', 'HEAD:' + first), checkedOut = fs.readFileSync(path.join(root, first));
    assert.notDeepEqual(checkedOut, blob);
    assert.deepEqual(checkedOut, Buffer.from(blob.toString('utf8').replace(/\n/g, '\r\n')));
    assert.equal(git('status', '--porcelain', '--untracked-files=no').toString(), '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
