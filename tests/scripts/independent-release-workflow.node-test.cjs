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

function parsedWorkflow() {
  const result = spawnSync('bun', ['-e', 'console.log(JSON.stringify(Bun.YAML.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))))', path.resolve(__dirname, '../../.github/workflows/independent-release-prepare.yml')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('exact readback is opt-in manual only and JSON crosses the shell exclusively through env', () => {
  const document = parsedWorkflow();
  assert.deepEqual(document.on.workflow_dispatch.inputs.registry_readback, {
    description: 'Optional exact registry readback JSON (registry/package/version/expected sha256, integrity, bytes); read-only, no qualification',
    required: false, type: 'string', default: '',
  });
  const step = document.jobs.contracts.steps.find(step => step.run === 'bun scripts/run-registry-readback-preflight.ts');
  assert.equal(step.if, "${{ github.event_name == 'workflow_dispatch' && inputs.registry_readback != '' }}");
  assert.deepEqual(step.env, { REGISTRY_READBACK_INPUT: '${{ inputs.registry_readback }}' });
  assert.doesNotMatch(step.run, /\$\{\{|eval|\$REGISTRY_READBACK_INPUT/u);
  assert.deepEqual(document.permissions, { contents: 'read' });
  assert.equal(document.jobs.contracts.permissions, undefined);
  assert.equal(document.jobs.contracts.environment, undefined);
  assert.equal(document.on.workflow_call, null);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-readback-env-'));
  try {
    fs.writeFileSync(path.join(parent, 'bun'), '#!/bin/sh\nprintf "%s" "$REGISTRY_READBACK_INPUT" > captured.json\n');
    fs.chmodSync(path.join(parent, 'bun'), 0o700);
    const input = '`touch injected`;$(touch injected);\n"secret"';
    const result = spawnSync('/bin/bash', ['-c', step.run], { cwd: parent, env: { ...process.env, PATH: parent, REGISTRY_READBACK_INPUT: input }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(parent, 'captured.json'), 'utf8'), input);
    assert.equal(fs.existsSync(path.join(parent, 'injected')), false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('real runner uses injected GET transport, preserves 404 blocked report and refuses input authority', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-readback-runner-'));
  const runner = path.resolve(__dirname, '../../scripts/run-registry-readback-preflight.ts');
  const program = `
import {runRegistryReadbackPreflight} from ${JSON.stringify(runner)};
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const mode=process.argv[1];
const manifest=Buffer.from(JSON.stringify({name:'@example/product',version:'1.2.3'}));
const header=Buffer.alloc(512);header.write('package/package.json');header.write('0000644\\0',100);header.write('0000000\\0',108);header.write('0000000\\0',116);header.write(manifest.length.toString(8).padStart(11,'0')+'\\0',124);header.fill(32,148,156);header[156]=48;header.write([...header].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\\0 ',148);
const archive=gzipSync(Buffer.concat([header,manifest,Buffer.alloc((512-manifest.length%512)%512+1024)]));
const input={registry:'https://registry.example/',package:'@example/product',version:'1.2.3',expected:{bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex'),integrity:'sha512-'+createHash('sha512').update(archive).digest('base64')}};
if(mode==='token')input.token='SENSITIVE-INPUT';
if(mode==='path')input.output='../elsewhere';
let calls=0;
const transport=async(url,options)=>{calls++;if(mode==='transporterror')throw Error('SENSITIVE-INPUT');if(options.method!=='GET'||new Headers(options.headers).has('authorization'))throw Error('write or token');
 if(mode==='success')return String(url).endsWith('.tgz')?new Response(archive):Response.json({name:input.package,version:input.version,dist:{integrity:input.expected.integrity,tarball:'https://cdn.example/product.tgz'}});
 return new Response(null,{status:404});};
const env={GITHUB_EVENT_NAME:mode==='pr'?'pull_request':mode==='call'?'workflow_call':mode==='push'?'push':'workflow_dispatch',REGISTRY_READBACK_INPUT:mode==='empty'?'':mode==='malformed'?'SENSITIVE-INPUT {':JSON.stringify(input)};
const code=await runRegistryReadbackPreflight(env,transport);
const file='.test-data/independent-release-prepare/registry-readback.json';
console.log(JSON.stringify({code,calls,record:existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null}));process.exitCode=code;
`;
  try {
    for (const mode of ['pr', 'call', 'push', 'empty', 'missing', 'token', 'path', 'malformed', 'transporterror', 'success']) {
      const cwd = path.join(parent, mode); fs.mkdirSync(cwd);
      const result = spawnSync('bun', ['-e', program, mode], { cwd, encoding: 'utf8' });
      const data = JSON.parse(result.stdout);
      assert.equal(result.stderr, '');
      assert.doesNotMatch(result.stdout, /SENSITIVE-INPUT|elsewhere/u);
      if (['pr', 'call', 'push', 'empty'].includes(mode)) {
        assert.equal(result.status, 0); assert.deepEqual(data, { code: 0, calls: 0, record: null }); continue;
      }
      assert.equal(result.status, mode === 'missing' ? 2 : mode === 'success' ? 0 : 1);
      assert.equal(data.calls, ['missing', 'transporterror'].includes(mode) ? 1 : mode === 'success' ? 2 : 0);
      assert.equal(data.record.status, mode === 'missing' ? 'not-published-blocked' : mode === 'success' ? 'readback-only' : 'readback-failed');
      for (const field of ['published', 'candidatePlanGenerated', 'releaseQualified', 'sourceVerified', 'nativeAdmission', 'legalClearance', 'consumerValidated']) assert.equal(data.record[field], false);
      assert.equal(fs.existsSync(path.join(cwd, 'elsewhere')), false);
    }
    const cli = path.join(parent, 'cli'); fs.mkdirSync(cli);
    const execution = spawnSync('bun', [runner], { cwd: cli, env: { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', REGISTRY_READBACK_INPUT: 'SENSITIVE-INPUT malformed {' }, encoding: 'utf8' });
    assert.equal(execution.status, 1);
    assert.equal(execution.stdout, ''); assert.equal(execution.stderr, '');
    const report = fs.readFileSync(path.join(cli, '.test-data/independent-release-prepare/registry-readback.json'), 'utf8');
    assert.doesNotMatch(report, /SENSITIVE-INPUT/u); assert.equal(JSON.parse(report).status, 'readback-failed');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('summary distinguishes fixture checks from explicitly requested network readback', () => {
  const summary = parsedWorkflow().jobs.contracts.steps.find(step => step.name === 'Explain preparation boundary');
  assert.equal(summary.env.REGISTRY_READBACK_ENABLED, "${{ github.event_name == 'workflow_dispatch' && inputs.registry_readback != '' }}");
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-readback-summary-'));
  try {
    for (const enabled of ['true', 'false']) {
      const file = path.join(parent, enabled);
      const result = spawnSync('bash', ['-c', summary.run], { env: { ...process.env, REGISTRY_READBACK_ENABLED: enabled, GITHUB_STEP_SUMMARY: file }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const text = fs.readFileSync(file, 'utf8');
      assert.match(text, enabled === 'true' ? /Explicit registry readback requested/u : /Contract fixtures only/u);
      if (enabled === 'true') { assert.doesNotMatch(text, /Contract fixtures only/u); assert.match(text, /not candidate product source authority/u); }
      assert.match(text, /not release qualification/u);
    }
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
