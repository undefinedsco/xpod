const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/independent-release-prepare.yml'), 'utf8');

test('preparation has no publication authority or legacy gate bypass', () => {
  assert.match(workflow, /permissions:\n  contents: read\n/u);
  assert.doesNotMatch(workflow, /(?:id-token|packages|actions): write|NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.|continue-on-error|environment:|tags:|candidate\.yml|release\.yml/u);
  assert.doesNotMatch(workflow, /\b(?:npm|bun) publish|dist-tag|gh release|docker push/u);
  assert.match(workflow, /published':False,'releaseQualified':False/u);
  assert.match(workflow, /Planner success is not release qualification/u);
  assert.match(workflow, /name: Independent release contract checks/u);
  assert.match(workflow, /Contract fixtures only: no actual candidate archive or receipt was inspected/u);
});

test('actual checkout and PR event head remain distinct and artifacts bind actual SHA', () => {
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /github\.event\.pull_request\.head\.sha \|\| github\.sha/u);
  assert.match(workflow, /actual_sha="\$\(git rev-parse HEAD\)"/u);
  assert.match(workflow, /test "\$actual_sha" = "\$GITHUB_SHA"/u);
  assert.match(workflow, /'checkoutSha':sys\.argv\[1\],'eventHeadSha':os\.environ\['EVENT_HEAD_SHA'\]/u);
  assert.match(workflow, /name: independent-release-contracts-\$\{\{ steps\.source\.outputs\.sha \}\}/u);
  assert.match(workflow, /if: \$\{\{ always\(\) && steps\.source\.outputs\.sha != '' \}\}/u);
});

test('independent contract gate covers authoritative implementation inputs without root dependencies', () => {
  assert.match(workflow, /pull_request:\n    branches: \[staging, main\]/u);
  assert.match(workflow, /push:\n    branches: \[staging\]/u);
  for (const input of ['scripts/**', 'packages/**', 'tests/scripts/**', 'tests/bun/**', 'package.json', 'bun.lock']) {
    assert.equal(workflow.split(`- '${input}'`).length - 1, 2);
  }
  assert.match(workflow, /bun test tests\/bun\/independent-release-plan\.test\.ts/u);
  assert.match(workflow, /node --test tests\/scripts\/independent-release-workflow\.node-test\.cjs/u);
  assert.match(workflow, /run: bun install --frozen-lockfile/u);
  assert.doesNotMatch(workflow, /needs:|MODULE_CATALOG|packagePrefix|@undefineds\.co\/xpod-/u);
});

test('actual YAML source-binding script distinguishes PR head and rejects an unrelated checkout', () => {
  const file = path.resolve(__dirname, '../../.github/workflows/independent-release-prepare.yml');
  const parsed = spawnSync('bun', ['-e', 'console.log(JSON.stringify(Bun.YAML.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))))', file], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const document = JSON.parse(parsed.stdout);
  assert.deepEqual(document.permissions, { contents: 'read' });
  assert.deepEqual(document.on.pull_request.branches, ['staging', 'main']);
  const job = document.jobs.contracts;
  assert.equal(job['runs-on'], 'ubuntu-latest');
  const installIndex = job.steps.findIndex(step => step.run === 'bun install --frozen-lockfile');
  const contractIndex = job.steps.findIndex(step => step.run?.includes('bun test tests/bun/independent-release-plan.test.ts'));
  assert.ok(installIndex >= 0 && installIndex < contractIndex);
  const source = job.steps.find(step => step.id === 'source');
  assert.equal(typeof source.run, 'string');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-workflow-contract-'));
  const root = path.join(parent, 'source');
  fs.mkdirSync(root);
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    run('git', ['init', '--quiet']);
    run('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'source binding fixture']);
    const actual = run('git', ['rev-parse', 'HEAD']);
    const eventHead = actual === '1'.repeat(40) ? '2'.repeat(40) : '1'.repeat(40);
    const output = path.join(parent, 'output');
    const env = { ...process.env, GITHUB_SHA: actual, EVENT_HEAD_SHA: eventHead,
      GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/62/merge', GITHUB_OUTPUT: output };
    const success = spawnSync('bash', ['-c', source.run], { cwd: root, encoding: 'utf8', env });
    assert.equal(success.status, 0, success.stderr);
    const record = JSON.parse(fs.readFileSync(path.join(root, '.test-data/independent-release-prepare/source.json'), 'utf8'));
    assert.equal(record.checkoutSha, actual);
    assert.equal(record.eventHeadSha, eventHead);
    assert.equal(record.status, 'contract-check-only');
    assert.equal(record.candidatePlanGenerated, false);
    assert.equal(record.published, false);
    assert.equal(record.releaseQualified, false);
    assert.equal(fs.readFileSync(output, 'utf8'), `sha=${actual}\n`);
    const wrong = spawnSync('bash', ['-c', source.run], { cwd: root, encoding: 'utf8', env: { ...env, GITHUB_SHA: eventHead } });
    assert.notEqual(wrong.status, 0);
    assert.equal(fs.readFileSync(output, 'utf8'), `sha=${actual}\n`);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
