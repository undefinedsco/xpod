const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { collectBunOnlyTests } = require('../../scripts/bun-test-discovery.cjs');
test('both runners share discovery for Bun tests in scripts, tests, UI and source', () => {
  const base = path.resolve('.test-data/bun-discovery'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'case-'));
  const put = (file, body) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), body); };
  try {
    const selected = ['scripts/lib/private.tiny.test.ts', 'tests/scripts/fresh.spec.ts', 'ui/src/fresh.test.tsx', 'src/fresh.test.cts'];
    for (const file of selected) put(file, "import {test} from'bun:test';");
    put('tests/bun/declared.test.ts', 'export {};');
    put('tests/scripts/node.test.ts', "import {test} from 'vitest';");
    put('tests/scripts/program-fixture.test.ts', `import {test} from 'vitest'; const fixture = \"import {test} from 'bun:test';\";`);
    put('tests/scripts/comment.test.ts', `// import {test} from 'bun:test';\nimport {test} from 'vitest';`);
    put('scripts/lib/dist/ignored.test.ts', "import {test} from 'bun:test';");
    put('tests/.test-data/ignored.test.ts', "import {test} from 'bun:test';");
    put('packages/xpod-cli/tests/separate-owner.test.ts', "import {test} from 'bun:test';");
    assert.deepEqual(collectBunOnlyTests(root).map(file => path.relative(root, file).split(path.sep).join('/')), [...selected, 'tests/bun/declared.test.ts'].sort());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('the actual private release suites are selected by the Bun gate', () => {
  const root = path.resolve(__dirname, '../..'); const files = collectBunOnlyTests(root).map(file => path.relative(root, file).split(path.sep).join('/'));
  for (const file of ['tests/scripts/afs-consumer-original-range.tiny.test.ts', 'scripts/lib/independent-admission/remote-consumer-bundle.tiny.test.ts']) assert.ok(files.includes(file), file);
});

test('Bun bootstrap parses actual imports without loading TypeScript or installing dependencies', () => {
  const { execFileSync } = require('node:child_process');
  const base = path.resolve('.test-data/bun-discovery'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'bootstrap-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, 'tests'));
    for (const name of ['bun-test-discovery.cjs', 'test-runner-ownership.cjs', 'test-runner-ownership.json', 'test-file-names.json']) {
      fs.copyFileSync(path.resolve(__dirname, '../../scripts', name), path.join(root, 'scripts', name));
    }
    const blocked = path.join(root, 'node_modules/typescript'); fs.mkdirSync(blocked, { recursive: true });
    fs.writeFileSync(path.join(blocked, 'package.json'), JSON.stringify({ name: 'typescript', main: 'index.js' }));
    fs.writeFileSync(path.join(blocked, 'index.js'), "throw Error('bootstrap must not load TypeScript');");
    fs.writeFileSync(path.join(root, 'tests/real.test.tsx'), "import {test} from 'bun:test'; const element = <div/>;");
    fs.writeFileSync(path.join(root, 'tests/fixture.test.ts'), `const fixture = "import {test} from 'bun:test';"; // from 'bun:test'`);
    const program = "console.log(JSON.stringify(require('./scripts/bun-test-discovery.cjs').collectBunOnlyTests(process.cwd())))";
    const selected = JSON.parse(execFileSync('bun', ['--no-install', '-e', program], { cwd: root, encoding: 'utf8', timeout: 10000 }));
    assert.deepEqual(selected, [path.join(root, 'tests/real.test.tsx')]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
