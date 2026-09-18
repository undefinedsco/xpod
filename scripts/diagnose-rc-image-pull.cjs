#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const IMAGE = 'ghcr.io/undefinedsco/xpod';
const NODES = ['sealos-io-node-14', 'sealos-io-node-10'];
const OWNER = 'xpod.undefineds.co/rc-pull-owner';
const DEADLINE_MS = 30 * 60 * 1000;

function configuration(env) {
  const namespace = env.SEALOS_NAMESPACE || '';
  const node = env.RC_PROBE_NODE || NODES[0];
  if (!NODES.includes(node)) throw new Error('Invalid probe node');
  const digest = env.RC_IMAGE_DIGEST || '';
  const runId = env.GITHUB_RUN_ID || '';
  const attempt = env.GITHUB_RUN_ATTEMPT || '';
  if ([namespace, digest, runId, attempt].some((value) => /\s/.test(value))) throw new Error('Invalid input whitespace');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace)) throw new Error('Invalid namespace');
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid image digest');
  if (!/^[1-9][0-9]{0,19}$/.test(runId) || !/^[1-9][0-9]{0,5}$/.test(attempt)) throw new Error('Invalid run identity');
  return { namespace, digest, node, name: `xpod-rc-pull-${runId}-${attempt}` };
}

function manifest(config, owner) {
  if (!NODES.includes(config.node)) throw new Error('Invalid probe node');
  return {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name: config.name, namespace: config.namespace, annotations: { [OWNER]: owner } },
    spec: {
      nodeName: config.node, restartPolicy: 'Never', activeDeadlineSeconds: 1800,
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{
        name: 'image-pull', image: `${IMAGE}@${config.digest}`, imagePullPolicy: 'Always', command: ['/bin/true'],
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '100m', memory: '64Mi' } },
      }],
    },
  };
}

function kubectl(args, input) {
  try {
    return execFileSync('kubectl', ['--request-timeout=30s', ...args], {
      input, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (args[0] === 'auth' && args[1] === 'can-i' && error.status === 1 && String(error.stdout).trim() === 'no') return 'no';
    // Do not expose kubectl stderr: registry redirects may contain credentials.
    throw new Error(`kubectl ${args[0]} failed (output withheld)`);
  }
}

function getPod(config, call) {
  const raw = call(['get', 'pod', config.name, '-n', config.namespace, '--ignore-not-found', '-o', 'json']);
  return raw ? JSON.parse(raw) : null;
}

function safeReason(value) {
  return typeof value === 'string' && value.trim() === value && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(value) ? value : 'Unspecified';
}

function messageCategory(value) {
  if (typeof value !== 'string' || !value) return 'none';
  if (/no space left|disk.*full|insufficient.*storage/i.test(value)) return 'no-space';
  if (/unauthorized|authentication required|access denied|forbidden/i.test(value)) return 'unauthorized';
  if (/too many requests|rate.?limit|\b429\b/i.test(value)) return 'rate-limit';
  if (/tls|x509|certificate|ssl/i.test(value)) return 'TLS';
  if (/timeout|timed out|deadline exceeded/i.test(value)) return 'timeout';
  if (/not found|manifest unknown|name unknown|\b404\b/i.test(value)) return 'not-found';
  if (/unpack|extract|snapshot|apply layer/i.test(value)) return 'unpack';
  return 'other';
}

function podSummary(pod) {
  const container = pod.status?.containerStatuses?.find((item) => item.name === 'image-pull');
  const state = container?.state || {};
  // No raw image ID, container ID, message, URL, env or pod spec is logged.
  return {
    phase: safeReason(pod.status?.phase),
    state: state.terminated ? 'terminated' : state.running ? 'running' : state.waiting ? 'waiting' : 'pending',
    reason: safeReason(state.terminated?.reason || state.waiting?.reason),
    messageCategory: messageCategory(state.terminated?.message || state.waiting?.message),
    imageDigest: container?.imageID?.match(/sha256:[a-f0-9]{64}/)?.[0] || null,
    hasImageID: Boolean(container?.imageID), hasContainerID: Boolean(container?.containerID),
    exitCode: Number.isInteger(state.terminated?.exitCode) ? state.terminated.exitCode : null,
  };
}

function namespacePods(config, call) {
  const result = JSON.parse(call(['get', 'pods', '-n', config.namespace, '-o', 'json']));
  if (!Array.isArray(result.items)) throw new Error('Invalid Pod list');
  return result.items;
}

function readyPod(pod, node) {
  return pod.spec?.nodeName === node && !pod.metadata?.deletionTimestamp &&
    pod.status?.phase === 'Running' && pod.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True');
}

function inspectNodes(call, log) {
  for (const node of NODES) {
    for (const kind of ['status', 'pull-config', 'image-fs']) {
      try {
        const args = kind === 'status' ? ['get', 'node', node, '-o', 'json'] :
          ['get', '--raw', `/api/v1/nodes/${node}/proxy/${kind === 'pull-config' ? 'configz' : 'stats/summary'}`];
        const result = JSON.parse(call(args));
        const values = {};
        if (kind === 'status') {
          values.conditions = {};
          for (const key of ['Ready', 'DiskPressure', 'MemoryPressure', 'PIDPressure']) {
            const status = result.status?.conditions?.find((item) => item.type === key)?.status;
            values.conditions[key] = ['True', 'False', 'Unknown'].includes(status) ? status : null;
          }
          values.allocatable = {};
          for (const key of ['cpu', 'memory', 'ephemeral-storage', 'pods']) {
            const value = result.status?.allocatable?.[key];
            values.allocatable[key] = typeof value === 'string' && value.length <= 40 &&
              /^(?:[0-9]+(?:\.[0-9]+)?)(?:[numkKMGTPE]|[KMGTPE]i|[eE][+-]?[0-9]+)?$/.test(value) ? value : null;
          }
        } else if (kind === 'pull-config') {
          const config = result.kubeletconfig;
          values.serializeImagePulls = typeof config?.serializeImagePulls === 'boolean' ? config.serializeImagePulls : null;
          values.maxParallelImagePulls = Number.isSafeInteger(config?.maxParallelImagePulls) && config.maxParallelImagePulls >= 0 ? config.maxParallelImagePulls : null;
          const duration = config?.imagePullProgressDeadline;
          values.imagePullProgressDeadline = typeof duration === 'string' && duration.length <= 40 &&
            /^(?:[0-9]+(?:\.[0-9]+)?(?:ns|us|ms|s|m|h))+$/.test(duration) ? duration : null;
        } else {
          const fs = result.node?.runtime?.imageFs;
          for (const key of ['availableBytes', 'usedBytes', 'capacityBytes', 'inodesFree']) {
            values[key] = Number.isSafeInteger(fs?.[key]) && fs[key] >= 0 ? fs[key] : null;
          }
        }
        log(JSON.stringify({ event: `node-${kind}`, node, ...values }));
      } catch { log(JSON.stringify({ event: `node-${kind}`, node, error: 'unavailable' })); }
    }
  }
}

function inspect(config, call = kubectl, log = console.log) {
  const checks = [
    ['get', 'nodes'], ['list', 'nodes'], ['get', 'nodes/proxy'],
    ...['pods', 'events'].flatMap((resource) => ['get', 'list', 'create', 'delete'].map((verb) => [verb, resource, '-n', config.namespace])),
  ];
  for (const args of checks) {
    let allowed = false;
    let error = null;
    try {
      const result = call(['auth', 'can-i', ...args]);
      if (result !== 'yes' && result !== 'no') error = 'invalid-response';
      allowed = result === 'yes';
    } catch { error = 'unavailable'; }
    log(JSON.stringify({ event: 'permission', verb: args[0], resource: args[1], allowed, error }));
  }
  try {
    const pods = namespacePods(config, call);
    const counts = new Map();
    for (const pod of pods) {
      const rawNode = pod.spec?.nodeName;
      const node = typeof rawNode === 'string' && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(rawNode) ? rawNode : 'unscheduled';
      const phase = ['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown'].includes(pod.status?.phase) ? pod.status.phase : 'Unknown';
      const key = `${node}:${phase}`;
      const row = counts.get(key) || { node, phase, count: 0, ready: 0 };
      row.count++;
      if (readyPod(pod, node)) row.ready++;
      counts.set(key, row);
    }
    log(JSON.stringify({ event: 'namespace-pod-counts', count: pods.length, groups: [...counts.values()] }));
  } catch { log(JSON.stringify({ event: 'namespace-pod-counts', error: 'unavailable' })); }
  inspectNodes(call, log);
}

function cleanup(config, state, call = kubectl, log = console.log) {
  if (!state || state.namespace !== config.namespace || state.name !== config.name || state.digest !== config.digest ||
      typeof state.owner !== 'string' || state.owner.length !== 36 || !/^[a-f0-9-]{36}$/.test(state.owner)) throw new Error('Invalid cleanup ownership record');
  const pod = getPod(config, call);
  if (!pod) return;
  if (pod.metadata?.annotations?.[OWNER] !== state.owner || !pod.metadata?.uid ||
      (state.uid && state.uid !== pod.metadata.uid)) throw new Error('Refusing cleanup of unowned or replaced Pod');
  // Server-side UID + resourceVersion preconditions close the read/delete race.
  call(['delete', '--raw', `/api/v1/namespaces/${config.namespace}/pods/${config.name}`, '-f', '-'], JSON.stringify({
    apiVersion: 'v1', kind: 'DeleteOptions', gracePeriodSeconds: 1,
    preconditions: { uid: pod.metadata.uid, resourceVersion: pod.metadata.resourceVersion },
  }));
  log(JSON.stringify({ event: 'owned-probe-deleted', name: config.name }));
}

async function run(config, options = {}) {
  const call = options.call || kubectl;
  const log = options.log || console.log;
  const save = options.save || (() => {});
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // A missing Pod is the only allowed initial state. RBAC/network errors fail closed.
  if (getPod(config, call)) throw new Error('Probe name already exists; refusing to overwrite');
  if (!NODES.includes(config.node)) throw new Error('Invalid probe node');
  if (!namespacePods(config, call).some((pod) => readyPod(pod, config.node))) throw new Error('Target lacks a Running Ready namespace Pod');
  const state = { ...config, owner: randomUUID() };
  save(state); // Allows the workflow's always cleanup after interruption or ambiguous create response.
  try {
    const created = JSON.parse(call(['create', '-n', config.namespace, '-f', '-', '-o', 'json'], JSON.stringify(manifest(config, state.owner))));
    if (!created.metadata?.uid || created.metadata?.annotations?.[OWNER] !== state.owner) throw new Error('Created Pod ownership was not confirmed');
    state.uid = created.metadata.uid;
    save(state);
    const deadline = now() + DEADLINE_MS;
    const seenEvents = new Set();
    while (now() < deadline) {
      if (options.cancelled?.()) throw new Error('Probe interrupted');
      const pod = getPod(config, call);
      if (!pod || pod.metadata?.uid !== state.uid || pod.metadata?.annotations?.[OWNER] !== state.owner) throw new Error('Probe disappeared or ownership changed');
      const summary = podSummary(pod);
      log(JSON.stringify({ event: 'probe-status', ...summary }));
      try {
        const events = JSON.parse(call(['get', 'events', '-n', config.namespace, '--field-selector', `involvedObject.uid=${state.uid}`, '-o', 'json']));
        for (const event of events.items || []) {
          const reason = safeReason(event.reason);
          const key = `${event.metadata?.uid}:${event.count}:${reason}`;
          if (!seenEvents.has(key)) {
            seenEvents.add(key);
            log(JSON.stringify({ event: 'probe-event', reason, messageCategory: messageCategory(event.message), count: Number.isInteger(event.count) ? event.count : 1 }));
          }
        }
      } catch {
        log(JSON.stringify({ event: 'events-unavailable' }));
      }
      if (summary.phase === 'Succeeded') {
        if (!summary.hasImageID || !summary.hasContainerID || summary.exitCode !== 0) throw new Error('Pod success lacks container execution evidence');
        return summary;
      }
      if (summary.phase === 'Failed') throw new Error('Probe Pod failed');
      await sleep(20000);
    }
    throw new Error('Probe exceeded 30 minute observation deadline');
  } finally {
    cleanup(config, state, call, log);
  }
}

async function main() {
  const config = configuration(process.env);
  if (process.argv.length === 3 && process.argv[2] === '--inspect') return inspect(config);
  if (!process.env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is required');
  const stateFile = path.join(process.env.RUNNER_TEMP, `${config.name}.json`);
  if (process.argv[2] === '--cleanup') {
    if (fs.existsSync(stateFile)) cleanup(config, JSON.parse(fs.readFileSync(stateFile, 'utf8')));
    return;
  }
  if (process.argv.length > 2) throw new Error('Unknown argument');
  let cancelled = false;
  process.on('SIGTERM', () => { cancelled = true; });
  process.on('SIGINT', () => { cancelled = true; });
  if (fs.existsSync(stateFile)) throw new Error('Existing ownership record; refusing to reuse');
  await run(config, {
    cancelled: () => cancelled,
    save: (state) => fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 }),
  });
}

if (require.main === module) main().catch(() => { console.error('RC probe failed; consult sanitized status and event records. Raw error output is withheld.'); process.exitCode = 1; });
module.exports = { configuration, manifest, podSummary, cleanup, run, OWNER, messageCategory, inspect };
