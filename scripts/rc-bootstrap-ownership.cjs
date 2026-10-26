#!/usr/bin/env node
/**
 * Bounded ownership + quiescence helper for the RC-only PostgreSQL bootstrap.
 *
 * Three subcommands, all pure JSON-in/JSON-out (no cluster calls):
 *
 *   quiescent   Fail closed unless the canonical xpod-rc app is scaled to zero
 *               and no matching pod is running or terminating. This runs BEFORE
 *               the bootstrap Job is allowed to DROP/CREATE the RC database, so
 *               no live app can race the reset or hold locks. It never scales
 *               anything: an active candidate is a coordination problem for
 *               ROOT, not something this workflow may silently interrupt.
 *
 *   annotate    Stamp a rendered Job with this run's ownership nonce.
 *
 *   delete-options
 *               Verify the existing Job carries this run's nonce AND read its
 *               live UID, then emit a DeleteOptions document with a uid
 *               precondition. A same-name foreign or replacement Job can never
 *               be deleted by name alone.
 */
const fs = require('node:fs');

const OWNER_ANNOTATION = 'xpod.undefineds.co/bootstrap-owner';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function requireNonce(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/.test(value)) {
    throw new Error('a bounded ownership nonce is required');
  }
  return value;
}

const CANONICAL_APP = 'xpod-rc';
const BLOCKING_PHASES = new Set(['Running', 'Pending', 'Unknown']);
const TERMINAL_PHASES = new Set(['Succeeded', 'Failed']);

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

/**
 * Fail closed unless the canonical app is scaled to zero and no pod is running
 * or terminating.
 *
 * `deployment` must be null ONLY for an authoritative 404 (the caller decides
 * that with `--ignore-not-found`; an API error must abort before this is
 * called). A malformed deployment or pod list is an error, never "empty".
 */
function quiescent(deployment, pods) {
  if (deployment !== null) {
    requireObject(deployment, 'deployment');
    if (deployment?.kind !== 'Deployment') throw new Error('deployment object is not a Deployment');
    if (deployment?.metadata?.name !== CANONICAL_APP) {
      throw new Error(`deployment object is not ${CANONICAL_APP}`);
    }
  }
  requireObject(pods, 'pod list');
  if (pods.kind !== undefined && pods.kind !== 'List' && pods.kind !== 'PodList') {
    throw new Error('pod collection is not a List/PodList');
  }
  if (!Array.isArray(pods.items)) throw new Error('pod collection has no items array');

  const problems = [];
  if (deployment !== null) {
    const specReplicas = deployment.spec?.replicas ?? 1;
    if (specReplicas !== 0) problems.push(`spec.replicas is ${specReplicas}, expected 0`);
    for (const field of ['replicas', 'readyReplicas', 'availableReplicas']) {
      const value = deployment.status?.[field] ?? 0;
      if (value !== 0) problems.push(`status.${field} is ${value}, expected 0`);
    }
  }

  for (const pod of pods.items) {
    requireObject(pod, 'pod entry');
    if (pod.kind !== undefined && pod.kind !== 'Pod') throw new Error('pod entry is not a Pod');
    const name = pod?.metadata?.name;
    if (typeof name !== 'string' || !name) throw new Error('pod entry has no metadata.name');
    if (pod.metadata.deletionTimestamp) {
      problems.push(`pod ${name} is still terminating`);
      continue;
    }
    const phase = pod?.status?.phase;
    if (typeof phase !== 'string' || !phase) {
      problems.push(`pod ${name} has no phase`);
      continue;
    }
    if (TERMINAL_PHASES.has(phase)) continue;
    if (BLOCKING_PHASES.has(phase)) {
      problems.push(`pod ${name} is ${phase}`);
      continue;
    }
    throw new Error(`pod ${name} has an unsupported phase: ${phase}`);
  }

  if (problems.length) {
    throw new Error(`RC application is not quiescent: ${problems.join('; ')}`);
  }
  return { quiescent: true, deploymentPresent: deployment !== null, pods: pods.items.length };
}

function annotate(job, nonce) {
  requireNonce(nonce);
  if (job?.kind !== 'Job' || !job?.metadata?.name) throw new Error('job object is malformed');
  const annotations = { ...(job.metadata.annotations ?? {}), [OWNER_ANNOTATION]: nonce };
  return { ...job, metadata: { ...job.metadata, annotations } };
}

function deleteOptions(job, nonce) {
  requireNonce(nonce);
  if (job?.kind !== 'Job' || !job?.metadata?.name) throw new Error('job object is malformed');
  const uid = job.metadata.uid;
  if (typeof uid !== 'string' || !uid) throw new Error('job has no UID; refusing an unqualified delete');
  const owner = job.metadata.annotations?.[OWNER_ANNOTATION];
  if (owner !== nonce) {
    throw new Error('job is not owned by this run; refusing to delete a foreign object');
  }
  return { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid } };
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function cli(argv) {
  const [command] = argv;
  const nonceIndex = argv.indexOf('--owner');
  const nonce = nonceIndex >= 0 ? argv[nonceIndex + 1] : undefined;
  if (command === 'quiescent') {
    const deploymentPath = argValue(argv, '--deployment');
    const podsPath = argValue(argv, '--pods');
    if (!podsPath) throw new Error('--pods is required');
    const deployment = deploymentPath && fs.existsSync(deploymentPath) ? readJson(deploymentPath) : null;
    writeJson(argValue(argv, '--output') ?? '/dev/stdout', quiescent(deployment, readJson(podsPath)));
    return;
  }
  if (command === 'annotate') {
    const input = argValue(argv, '--input');
    const output = argValue(argv, '--output');
    if (!input || !output) throw new Error('--input and --output are required');
    writeJson(output, annotate(readJson(input), nonce));
    return;
  }
  if (command === 'delete-options') {
    const jobPath = argValue(argv, '--job');
    const output = argValue(argv, '--output');
    if (!jobPath || !output) throw new Error('--job and --output are required');
    writeJson(output, deleteOptions(readJson(jobPath), nonce));
    return;
  }
  throw new Error('usage: quiescent|annotate|delete-options');
}

if (require.main === module) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[rc-bootstrap-ownership] ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { quiescent, annotate, deleteOptions, OWNER_ANNOTATION };
