const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const workflow = readFileSync(path.resolve(__dirname, '../../.github/workflows/module-installed-consumer.yml'), 'utf8');

test('candidate preparation is manually gated and read-only', () => {
  assert.match(workflow, /\n  workflow_dispatch:/);
  for (const trigger of ['workflow_run', 'workflow_call', 'push', 'schedule']) {
    assert.doesNotMatch(workflow, new RegExp(`\\n  ${trigger}:`));
  }
  assert.match(workflow, /contents: read\n  actions: read/);
  assert.doesNotMatch(workflow, /(?:contents|actions|packages|id-token): write/);
  assert.doesNotMatch(workflow, /(?:bun|npm) publish|gh workflow run/);
});

test('PR bootstrap runs only tiny contracts and never acquires candidates', () => {
  assert.match(workflow, /pull_request:\n    branches: \[staging, main\]/);
  const contracts = workflow.slice(workflow.indexOf('  contracts:'), workflow.indexOf('  prepare:'));
  assert.match(contracts, /if: \$\{\{ github.event_name == 'pull_request' \}\}/);
  assert.match(contracts, /node --test tests\/scripts\/module-installed-consumer-workflow.node-test.cjs/);
  assert.match(contracts, /uses: oven-sh\/setup-bun@v2\n        with:\n          bun-version: '1\.4\.2'/);
  assert.ok(contracts.indexOf('uses: oven-sh/setup-bun@v2') < contracts.indexOf('node --test'), 'Bun discovery needs its runtime before the contract executes');
  assert.doesNotMatch(contracts, /GH_TOKEN|acquire|bun install|--run|prepare-module-consumer-plan.ts/);
  assert.match(workflow, /  prepare:\n    if: \$\{\{ github.event_name == 'workflow_dispatch' \}\}/);
});

test('untrusted request goes through environment and exact validation before checkout', () => {
  assert.equal(workflow.match(/\$\{\{ inputs.request_json \}\}/g).length, 2);
  assert.equal(workflow.match(/MODULE_CONSUMER_REQUEST: \$\{\{ inputs.request_json \}\}/g).length, 2);
  const validation = workflow.indexOf('validateModuleConsumerRequest(request)');
  const checkout = workflow.indexOf('ref: ${{ steps.request.outputs.source_sha }}');
  assert.ok(validation > 0 && checkout > validation);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
});

test('separate source roots, private output and validate-only are explicit', () => {
  assert.match(workflow, /runs-on: macos-15/);
  assert.match(workflow, /node-version: '22\.21\.1'/);
  assert.match(workflow, /bun-version: '1\.4\.2'/);
  assert.match(workflow, /chmod 700 "\$root"/);
  assert.match(workflow, /statfsSync\(root\)/);
  assert.match(workflow, /sourceRoots: \[path.join\(workspace,"tools"\),path.join\(workspace,"product-source"\)\]/);
  assert.match(workflow, /python3 "\$driver" "\$root\/consumer-plan.json" > "\$root\/validation.json"/);
  assert.match(workflow, /public consumer was not executed/);
  assert.match(workflow, /path: \$\{\{ steps.plan.outputs.root \}\}\/safe-evidence\//);
});

test('artifact upload is restricted to bounded evidence export, never the full acquisition root', () => {
  assert.match(workflow, /run: bun scripts\/export-module-consumer-evidence.ts "\$MODULE_CONSUMER_ROOT" "\$MODULE_CONSUMER_ROOT\/safe-evidence"/);
  assert.doesNotMatch(workflow, /path: \$\{\{ steps.plan.outputs.root \}\}\/$/m);
  assert.doesNotMatch(workflow, /include-hidden-files: true/);
  assert.ok(workflow.indexOf('run: bun scripts/export-module-consumer-evidence.ts') < workflow.indexOf('- uses: actions/upload-artifact@v4'));
});

test('real execution requires the explicit manual boolean after validation', () => {
  assert.match(workflow, /execute_consumer:\n[\s\S]*?type: boolean\n        default: false/);
  assert.match(workflow, /EXECUTE_CONSUMER: \$\{\{ inputs.execute_consumer \}\}/);
  assert.match(workflow, /if \[ "\$EXECUTE_CONSUMER" = true \]; then\n            python3 "\$driver" "\$root\/consumer-plan.json" --run/);
  assert.ok(workflow.indexOf('> "$root/validation.json"') < workflow.indexOf(' --run >'));
  assert.match(workflow, /requested run does not establish a passing run/);
});

test('module routing selects only explicit CSS or API drivers from a validated request', () => {
  assert.match(workflow, /appendFileSync\(process.env.GITHUB_OUTPUT, `module=\$\{request.module\}\\n`\)/);
  assert.match(workflow, /MODULE_CONSUMER_MODULE: \$\{\{ steps.request.outputs.module \}\}/);
  assert.match(workflow, /case "\$MODULE_CONSUMER_MODULE" in\n            css\) driver=scripts\/css-module-consumer.py ;;\n            api\) driver=scripts\/api-module-consumer.py ;;\n            \*\) echo 'Unsupported module' >&2; exit 1 ;;/);
  assert.match(workflow, /name: module-consumer-preparation-\$\{\{ steps.request.outputs.module \}\}/);
});

test('Bun consumer contracts live in the Bun runner directory and are actually discovered', () => {
  const { existsSync } = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const root = path.resolve(__dirname, '../..');
  const listed = execFileSync('bun', ['scripts/run-bun-tests.ts', '--list'], { cwd: root, encoding: 'utf8', timeout: 10000 }).split('\n');
  for (const name of ['prepare-module-consumer-plan', 'export-module-consumer-evidence']) {
    const file = 'tests/bun/' + name + '.test.ts';
    assert.ok(listed.includes(file), 'Bun runner must execute ' + file);
    assert.match(readFileSync(path.join(root, file), 'utf8'), /from 'bun:test'/);
    assert.ok(workflow.includes("- '" + file + "'"), 'workflow path filter must follow ' + file);
    assert.equal(existsSync(path.join(root, 'tests/scripts/' + name + '.test.ts')), false);
  }
});
