'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configuration, manifest, podSummary, cleanup, run, OWNER, messageCategory } = require('./diagnose-rc-image-pull.cjs');
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
