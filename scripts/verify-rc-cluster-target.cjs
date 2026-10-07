#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ALLOWED_CLUSTER_SERVER = 'https://gzg.sealos.run:6443';
const KUBECTL_TIMEOUT_MS = 15_000;
const KUBECTL_MAX_BUFFER = 1024 * 1024;
const KUBERNETES_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

// Fixed failures only: the offending config, URL and child process output must
// never reach the logs, because they can carry credentials or private hosts.
function fail(reason) {
  // Synchronous fd write so the fixed diagnostic cannot be lost on exit.
  fs.writeSync(2, `RC cluster target check failed: ${reason}\n`);
  process.exit(1);
}

function validateNamespace(value) {
  if (!value) {
    fail('SEALOS_NAMESPACE is required');
  }
  if (!KUBERNETES_NAME.test(value) || value.length > 63) {
    fail('SEALOS_NAMESPACE must be a valid Kubernetes name');
  }
  return value;
}

function readKubeconfig() {
  let raw;
  try {
    raw = execFileSync('kubectl', [ 'config', 'view', '--minify', '--output=json' ], {
      encoding: 'utf8',
      stdio: [ 'ignore', 'pipe', 'pipe' ],
      timeout: KUBECTL_TIMEOUT_MS,
      maxBuffer: KUBECTL_MAX_BUFFER,
    });
  } catch {
    fail('kubectl config view failed');
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    fail('kubectl config view returned invalid JSON');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    fail('kubectl config view returned invalid JSON');
  }
  return config;
}

function resolveSelectedTarget(config) {
  const currentContext = config['current-context'];
  if (typeof currentContext !== 'string' || currentContext.length === 0) {
    fail('kubeconfig has no current-context');
  }
  const contexts = Array.isArray(config.contexts) ? config.contexts : [];
  const contextEntry = contexts.find((entry) => entry && typeof entry === 'object' && entry.name === currentContext);
  const context = contextEntry?.context;
  if (!context || typeof context !== 'object' || Array.isArray(context) || typeof context.cluster !== 'string' || !context.cluster) {
    fail('kubeconfig current-context is incomplete');
  }
  const clusters = Array.isArray(config.clusters) ? config.clusters : [];
  const clusterEntry = clusters.find((entry) => entry && typeof entry === 'object' && entry.name === context.cluster);
  const cluster = clusterEntry?.cluster;
  if (!cluster || typeof cluster !== 'object' || Array.isArray(cluster)) {
    fail('kubeconfig current-context is incomplete');
  }
  return { cluster, context };
}

function main() {
  const namespace = validateNamespace(process.env.SEALOS_NAMESPACE);
  const config = readKubeconfig();
  const { cluster, context } = resolveSelectedTarget(config);
  if (cluster.server !== ALLOWED_CLUSTER_SERVER) {
    fail('cluster server is not the Guangzhou API endpoint');
  }
  if (context.namespace !== namespace) {
    fail('kubeconfig namespace does not match SEALOS_NAMESPACE');
  }
  process.stdout.write('RC cluster target verified: Guangzhou cluster\n');
}

main();
