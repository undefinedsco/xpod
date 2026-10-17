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
