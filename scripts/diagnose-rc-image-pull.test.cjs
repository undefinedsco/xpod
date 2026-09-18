'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configuration, manifest, podSummary, cleanup, run, OWNER, messageCategory, inspect, diagnosticError, kubectl } = require('./diagnose-rc-image-pull.cjs');
const env = { SEALOS_NAMESPACE: 'rc-space', RC_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };
const config = configuration(env);
const owner = '12345678-1234-1234-1234-123456789abc';

function fixture(options = {}) {
  let pod = options.existing || null;
  const calls = [];
  const logs = [];
  let state;
  let clock = 0;
  return {
    calls, logs,
    get state() { return state; },
    options: {
      now: () => clock,
      sleep: async () => { clock += 1800001; },
      save: (value) => { state = { ...value }; },
      log: (value) => logs.push(value),
      call: (args, input) => {
        calls.push({ args, input });
        if (args[1] === 'pods') return JSON.stringify({ items: options.nodePods ?? [{ spec: { nodeName: config.node }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }] });
        if (args[0] === 'create') {
          pod = JSON.parse(input);
          pod.metadata.uid = 'pod-uid';
          pod.metadata.resourceVersion = '42';
          pod.status = options.status || {
            phase: 'Succeeded', containerStatuses: [{ name: 'image-pull', imageID: `docker-pullable://image@${config.digest}`, containerID: 'containerd://123', state: { terminated: { reason: 'Completed', exitCode: 0 } } }],
          };
          if (options.createThrows) throw new Error('create response lost');
          return JSON.stringify(pod);
        }
        if (args[0] === 'delete') { pod = null; return '{}'; }
        if (args[1] === 'events') return JSON.stringify({ items: [{ reason: 'Pulled', message: 'https://registry/blob?token=SECRET Authorization: Bearer SECRET', count: 1 }] });
        if (options.readThrows && state?.uid && calls.filter((c) => c.args[1] === 'pod').length === 2) throw new Error('read failed');
        return pod ? JSON.stringify(pod) : '';
      },
    },
  };
}

test('strict configuration rejects namespace/digest/run identity injection', () => {
  for (const [key, value] of [
    ['SEALOS_NAMESPACE', 'rc-space\n'], ['RC_IMAGE_DIGEST', `${env.RC_IMAGE_DIGEST}\n`], ['GITHUB_RUN_ID', '123\n'], ['SEALOS_NAMESPACE', 'a/b'], ['SEALOS_NAMESPACE', '-x'], ['SEALOS_NAMESPACE', ''],
    ['RC_IMAGE_DIGEST', 'ghcr.io/other@sha256:abc'], ['RC_IMAGE_DIGEST', `sha256:${'A'.repeat(64)}`],
    ['GITHUB_RUN_ID', '1; echo'], ['GITHUB_RUN_ATTEMPT', '../2'],
  ]) assert.throws(() => configuration({ ...env, [key]: value }));
  assert.equal(config.name, 'xpod-rc-pull-123-2');
});

test('manifest is limited to the fixed node/image and nonprivileged no-volume true command', () => {
  const pod = manifest(config, owner);
  assert.equal(pod.spec.nodeName, 'sealos-io-node-14');
  assert.equal(pod.spec.containers[0].image, `ghcr.io/undefinedsco/xpod@${config.digest}`);
  assert.deepEqual(pod.spec.containers[0].command, ['/bin/true']);
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.securityContext.runAsUser, 1000);
  assert.equal(pod.spec.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.equal(pod.spec.containers[0].securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(pod.spec.containers[0].securityContext.capabilities.drop, ['ALL']);
  assert.equal(pod.spec.restartPolicy, 'Never');
  assert.equal(pod.spec.activeDeadlineSeconds, 1800);
  assert.equal(pod.spec.volumes, undefined);
  assert.equal(pod.spec.imagePullSecrets, undefined);
});

test('existing Pod is never created over or deleted', async () => {
  const f = fixture({ existing: { metadata: { uid: 'existing' } } });
  await assert.rejects(run(config, f.options), /already exists/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.state, undefined);
});

test('success requires execution evidence, logs safe fields, deletes owned UID with preconditions', async () => {
  const f = fixture();
  const result = await run(config, f.options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.imageDigest, config.digest);
  assert.match(f.logs.join('\n'), /Pulled/);
  assert.doesNotMatch(f.logs.join('\n'), /SECRET|Authorization|https:|containerd:/);
  const deletion = f.calls.find((c) => c.args[0] === 'delete');
  assert.deepEqual(deletion.args, ['delete', '--raw', '/api/v1/namespaces/rc-space/pods/xpod-rc-pull-123-2', '-f', '-']);
  assert.deepEqual(JSON.parse(deletion.input).preconditions, { uid: 'pod-uid', resourceVersion: '42' });
});

for (const [name, options, error] of [
  ['failed Pod', { status: { phase: 'Failed' } }, /Pod failed/],
  ['missing success evidence', { status: { phase: 'Succeeded' } }, /lacks container/],
  ['timeout', { status: { phase: 'Pending' } }, /30 minute/],
  ['read error', { readThrows: true }, /read failed/],
  ['ambiguous create', { createThrows: true }, /response lost/],
]) test(`${name} still cleans up only the owned probe`, async () => {
  const f = fixture(options);
  await assert.rejects(run(config, f.options), error);
  assert.equal(f.calls.filter((c) => c.args[0] === 'delete').length, 1);
});

test('cleanup refuses different ownership, replaced UID and wrong namespace', () => {
  const state = { ...config, owner, uid: 'expected' };
  for (const metadata of [
    { uid: 'expected', annotations: { [OWNER]: 'another-owner' } },
    { uid: 'replaced', annotations: { [OWNER]: owner } },
  ]) {
    const calls = [];
    assert.throws(() => cleanup(config, state, (args) => { calls.push(args); return JSON.stringify({ metadata }); }), /Refusing cleanup/);
    assert.equal(calls.length, 1);
  }
  assert.throws(() => cleanup(config, { ...state, namespace: 'production' }, () => assert.fail('must not call kubectl')), /Invalid cleanup/);
});

test('summary never exposes raw status message or a malformed reason', () => {
  const summary = podSummary({ status: { phase: 'Pending', containerStatuses: [{ name: 'image-pull', imageID: 'https://secret?token=SECRET', state: { waiting: { reason: 'Bearer SECRET', message: 'SECRET' } } }] } });
  assert.equal(summary.reason, 'Unspecified');
  assert.doesNotMatch(JSON.stringify(summary), /SECRET/);
});


test('message classification only returns fixed categories, never secret URL or header content', () => {
  for (const [message, expected] of [
    ['GET https://registry/blob?token=SECRET failed: TLS handshake timeout Authorization: Bearer SECRET', 'TLS'],
    ['https://registry/blob?sig=SECRET: no space left on device', 'no-space'],
    ['Authorization: Bearer SECRET failed with unauthorized', 'unauthorized'],
    ['https://registry/blob?token=SECRET: context deadline exceeded', 'timeout'],
    ['https://registry/blob?secret=SECRET: 429 Too Many Requests', 'rate-limit'],
    ['https://registry/blob?token=SECRET: manifest unknown', 'not-found'],
    ['https://registry/blob?token=SECRET: failed to unpack layer', 'unpack'],
    ['https://registry/blob?token=SECRET Authorization: Bearer SECRET', 'other'],
  ]) {
    assert.equal(messageCategory(message), expected);
    assert.doesNotMatch(messageCategory(message), /SECRET|https:|Authorization|Bearer/);
  }
});


test('node choice is strictly allowlisted', () => {
  for (const node of ['sealos-io-node-11', 'sealos-io-node-10\n', '--all', ' node14']) {
    assert.throws(() => configuration({ ...env, RC_PROBE_NODE: node }), /Invalid probe node/);
  }
  const alternate = configuration({ ...env, RC_PROBE_NODE: 'sealos-io-node-10' });
  assert.equal(manifest(alternate, owner).spec.nodeName, 'sealos-io-node-10');
});

test('probe refuses absent, unready, terminating or other-node evidence before mutation', async () => {
  for (const nodePods of [[], [{ spec: { nodeName: config.node }, status: { phase: 'Running' } }],
    [{ spec: { nodeName: 'sealos-io-node-10' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }],
    [{ metadata: { deletionTimestamp: 'now' }, spec: { nodeName: config.node }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }]]) {
    const f = fixture({ nodePods });
    await assert.rejects(run(config, f.options), /Running Ready/);
    assert.equal(f.state, undefined);
    assert.ok(f.calls.every(({ args }) => args[0] === 'get'));
  }
});

test('inspect only checks permissions and reads sanitized aggregate Pod state', () => {
  const calls = [], logs = [];
  inspect(config, (args) => {
    calls.push(args);
    if (args[0] === 'auth') return args[2] === 'get' ? 'yes' : 'no';
    assert.deepEqual(args, ['get', 'pods', '-n', config.namespace, '-o', 'json']);
    return JSON.stringify({ items: [{ metadata: { name: 'SECRET' }, spec: { nodeName: config.node, env: 'SECRET' }, status: { phase: 'Running', message: 'SECRET', conditions: [{ type: 'Ready', status: 'True' }] } }] });
  }, (line) => logs.push(JSON.parse(line)));
  assert.equal(calls.length, 19);
  assert.ok(calls.every((args) => args[0] === 'auth' || args[0] === 'get'));
  assert.equal(logs.filter((line) => line.event === 'permission').length, 11);
  assert.deepEqual(logs.find((line) => line.event === 'namespace-pod-counts').groups, [{ node: config.node, phase: 'Running', count: 1, ready: 1 }]);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
});

test('inspect errors never emit raw output or mutate cluster resources', () => {
  const logs = [];
  inspect(config, () => { throw new Error('SECRET'); }, (line) => logs.push(JSON.parse(line)));
  assert.equal(logs.length, 19);
  assert.ok(logs.every((line) => line.error === 'unavailable'));
  assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
});


test('workflow keeps inspect separate from probe and cleanup mutations', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../.github/workflows/diagnose-production.yml'), 'utf8');
  assert.match(source, /default: inspect/);
  assert.match(source, /Inspect RC permissions[^]*?if: inputs.environment == 'rc' && inputs.rc_mode == 'inspect'/);
  assert.match(source, /Probe exact RC[^]*?if: inputs.environment == 'rc' && inputs.rc_mode == 'probe'/);
  assert.match(source, /Clean up only[^]*?if: always\(\) && inputs.environment == 'rc' && inputs.rc_mode == 'probe'/);
  assert.throws(() => manifest({ ...config, node: 'unobserved' }, owner), /Invalid probe node/);
});


test('node inspection allowlists conditions, quantities, pull settings and image disk counters', () => {
  const calls = [], logs = [];
  inspect(config, (args) => {
    calls.push(args);
    if (args[0] === 'auth') return 'yes';
    if (args[1] === 'pods') return '{"items":[]}';
    if (args[1] === 'node') return JSON.stringify({ metadata: { labels: { SECRET: 'SECRET' } }, status: {
      addresses: ['SECRET'], conditions: [{ type: 'Ready', status: 'True', message: 'SECRET' }, { type: 'DiskPressure', status: 'False' }],
      allocatable: { cpu: '1500m', memory: '32Gi', 'ephemeral-storage': '123456789', pods: '110', SECRET: 'SECRET' },
    } });
    if (args[2].endsWith('/configz')) return JSON.stringify({ kubeletconfig: { serializeImagePulls: true, maxParallelImagePulls: 1, imagePullProgressDeadline: '1m30s', authentication: 'SECRET', tlsCertFile: 'SECRET' } });
    assert.ok(args[2].endsWith('/stats/summary'));
    return JSON.stringify({ node: { nodeName: 'SECRET', runtime: { imageFs: { availableBytes: 100, usedBytes: 200, capacityBytes: 300, inodesFree: 40, mountpoint: 'SECRET' } } }, pods: ['SECRET'] });
  }, (line) => logs.push(JSON.parse(line)));
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|authentication|tlsCert|mountpoint|addresses/);
  const nodes = logs.filter((line) => line.event.startsWith('node-') && line.event !== 'node-list');
  assert.equal(nodes.length, 6);
  assert.deepEqual([...new Set(nodes.map((line) => line.node))], ['sealos-io-node-14', 'sealos-io-node-10']);
  assert.equal(nodes[0].allocatable.memory, '32Gi');
  assert.equal(nodes[1].serializeImagePulls, true);
  assert.equal(nodes[1].maxParallelImagePulls, 1);
  assert.equal(nodes[1].imagePullProgressDeadline, '1m30s');
  assert.equal(nodes[2].availableBytes, 100);
  assert.ok(calls.every((args) => ['get', 'auth'].includes(args[0])));
});

test('malformed node fields cannot leak arbitrary strings or objects', () => {
  const logs = [];
  inspect(config, (args) => {
    if (args[0] === 'auth') return 'yes';
    if (args[1] === 'pods') return '{"items":[]}';
    return JSON.stringify({ status: { conditions: [{ type: 'Ready', status: 'SECRET' }], allocatable: { cpu: 'SECRET', memory: '123Gi\nSECRET' } },
      kubeletconfig: { serializeImagePulls: 'SECRET', maxParallelImagePulls: 'SECRET', imagePullProgressDeadline: 'SECRET' },
      node: { runtime: { imageFs: { availableBytes: 'SECRET', usedBytes: -1, capacityBytes: { SECRET: 1 }, inodesFree: 1.5 } } } });
  }, (line) => logs.push(JSON.parse(line)));
  assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
  assert.equal(logs.find((line) => line.event === 'node-image-fs').availableBytes, null);
});


test('node list and diagnostic errors expose only fixed safe fields', () => {
  const logs = [];
  inspect(config, (args) => {
    if (args[0] === 'auth') return 'yes';
    if (args[1] === 'pods') return '{"items":[]}';
    if (args[1] === 'nodes') return JSON.stringify({ items: [
      { metadata: { name: 'sealos-io-node-10', labels: { SECRET: 'SECRET' } }, status: { addresses: ['SECRET'], conditions: [{ type: 'Ready', status: 'True', message: 'SECRET' }] } },
      { metadata: { name: 'SECRET/token' }, status: { conditions: [{ type: 'Ready', status: 'SECRET' }] } },
    ] });
    const error = new Error('SECRET stderr'); error.category = 'not-found'; error.exitCode = 1; throw error;
  }, (line) => logs.push(JSON.parse(line)));
  const summary = logs.find((line) => line.event === 'node-list');
  assert.equal(summary.count, 2);
  assert.equal(summary.nodes[0].name, 'sealos-io-node-10');
  assert.equal(summary.nodes[1].name, null);
  assert.equal(logs.find((line) => line.event === 'node-status').category, 'not-found');
  assert.equal(logs.find((line) => line.event === 'node-status').exitCode, 1);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|addresses|labels|stderr/);
  assert.deepEqual(diagnosticError({ category: 'SECRET', exitCode: 'SECRET' }), { error: 'unavailable', category: 'other', exitCode: null });
});


test('kubectl classifies stderr without retaining or throwing sensitive stderr', () => {
  for (const [stderr, category] of [['Forbidden SECRET', 'unauthorized'], ['nodes SECRET not found', 'not-found'], ['TLS handshake SECRET timeout', 'TLS']]) {
    assert.throws(() => kubectl(['get', 'nodes'], undefined, () => { const error = new Error('SECRET'); error.stderr = stderr; error.status = 1; throw error; }), (error) => {
      assert.equal(error.category, category); assert.equal(error.exitCode, 1);
      assert.doesNotMatch(error.message + JSON.stringify(error), /SECRET/); return true;
    });
  }
});
