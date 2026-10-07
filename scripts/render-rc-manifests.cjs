#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const YAML = require('yaml');

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--overlay':
        args.overlay = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      case '--output':
        args.output = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      case '--namespace':
        args.namespace = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--secret-name':
        args.secretName = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--seed-secret-name':
        args.seedSecretName = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--run-ownership':
        args.runOwnership = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      case '--admission':
        args.admission = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      case '--current-deployment':
        args.currentDeployment = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      case '--image':
        args.image = readOptionValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  for (const key of [ 'overlay', 'output', 'namespace' ]) {
    if (!args[key]) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} requires a value`);
  }
  return args;
}

function validateImmutableImage(value) {
  if (typeof value !== 'string' || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error('image must use an immutable sha256 digest');
  }
  return value;
}

function validateKubernetesName(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  if (value.length > 63 || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value)) {
    throw new Error(`${fieldName} must be a valid Kubernetes name`);
  }
  return value;
}

function copyOverlay(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyOverlay(sourcePath, targetPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function rewriteKustomization(overlayDir, namespace) {
  const kustomizationPath = path.join(overlayDir, 'kustomization.yaml');
  const kustomization = YAML.parse(fs.readFileSync(kustomizationPath, 'utf8'));
  kustomization.namespace = namespace;
  kustomization.resources = (kustomization.resources ?? []).filter((resource) => resource !== 'namespace.yaml');
  fs.writeFileSync(kustomizationPath, YAML.stringify(kustomization));
}

function replaceYamlValues(overlayDir, replacements) {
  for (const entry of fs.readdirSync(overlayDir, { withFileTypes: true })) {
    const filePath = path.join(overlayDir, entry.name);
    if (entry.isDirectory()) {
      replaceYamlValues(filePath, replacements);
      continue;
    }
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    let next = fs.readFileSync(filePath, 'utf8');
    for (const [ source, target ] of replacements) {
      next = next.replaceAll(source, target);
    }
    fs.writeFileSync(filePath, next);
  }
}

function assertNoRcResidue(manifest, secretName) {
  const objects = YAML.parseAllDocuments(manifest)
    .map((document) => document.toJSON())
    .filter(Boolean);
  if (objects.some((object) => object.kind === 'Namespace' && object.metadata?.name === 'xpod-rc')) {
    throw new Error('rendered manifest must not contain Namespace/xpod-rc');
  }
  if (objects.some((object) => object.metadata?.namespace === 'xpod-rc')) {
    throw new Error('rendered manifest must not contain metadata.namespace xpod-rc');
  }
  if (secretName !== 'xpod-rc-secret' && manifest.includes('xpod-rc-secret')) {
    throw new Error('rendered manifest must not contain xpod-rc-secret');
  }
  if (manifest.includes('secretName: xpod-rc-seed-secret')) {
    throw new Error('rendered manifest must not contain the xpod-rc-seed placeholder');
  }
  if (manifest.includes('ghcr.io/undefinedsco/xpod:replace-me')) {
    throw new Error('rendered manifest must not contain a mutable placeholder image');
  }
}

function renderRcManifests(input) {
  const namespace = validateKubernetesName(input.namespace, 'namespace');
  const { GZ_NAMESPACE, objectIdentity } = require('./verify-gz-rc-prerequisites.cjs');
  if (namespace !== GZ_NAMESPACE) throw new Error('RC rendering is limited to the assigned GZ namespace');
  if (path.resolve(input.overlay) !== path.resolve(__dirname, '../deploy/sealos/rc')) throw new Error('RC renderer cannot initialize or replace PostgreSQL');
  if (!input.currentDeployment) throw new Error('current GZ Deployment identity is required');
  const current = JSON.parse(fs.readFileSync(input.currentDeployment, 'utf8'));
  objectIdentity(current, 'Deployment', 'xpod-rc');
  if (!input.admission) throw new Error('source-bound GZ admission is required');
  const admission = JSON.parse(fs.readFileSync(input.admission, 'utf8'));
  const expectedSource = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8',timeout:10000}).trim();
  if (admission.status !== 'ok' || admission.namespace !== GZ_NAMESPACE || admission.sourceSha !== expectedSource) throw new Error('GZ admission is incomplete or bound to a different source');
  const admitted = admission.identities.find(entry => entry.kind === 'Deployment' && entry.name === 'xpod-rc');
  if (admitted?.uid !== current.metadata.uid || admitted.resourceVersion !== current.metadata.resourceVersion) throw new Error('RC Deployment changed after admission');
  const secretName = input.secretName === undefined ? undefined : validateKubernetesName(input.secretName, 'secretName');
  const seedSecretName = input.seedSecretName === undefined ? undefined : validateKubernetesName(input.seedSecretName, 'seedSecretName');
  const image = input.image === undefined ? undefined : validateImmutableImage(input.image);
  if (!secretName || !seedSecretName || !image) throw new Error('xpod-rc-secret, seed and image replacements are required');
  if (!input.runOwnership) throw new Error('run-owned managed executor is required');
  const ownership = JSON.parse(fs.readFileSync(input.runOwnership,'utf8'));
  const { OWNER, OWNERSHIP, ownershipForDeployment } = require('./verify-gz-rc-prerequisites.cjs');
  if (ownership.sourceSha !== expectedSource || !ownership.nonce || ownership.secrets?.length !== 2 || ownership.secrets[0].name !== secretName || ownership.secrets[1].name !== seedSecretName
    || !ownership.secrets.every(entry => entry.uid) || ownership.executor?.status !== 'ready' || !ownership.executor.deploymentUID || !ownership.executor.serviceUID
    || !/^xpod-rc-inngest-\d+-\d+$/.test(ownership.executor.name)) throw new Error('managed executor or Secret birth ownership is incomplete');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-rc-overlay-'));
  try {
    const tempOverlay = path.join(tempRoot, 'rc');
    copyOverlay(input.overlay, tempOverlay);
    rewriteKustomization(tempOverlay, namespace);
    replaceYamlValues(tempOverlay, [
      secretName && [ 'xpod-rc-secret', secretName ],
      seedSecretName && [ 'xpod-rc-seed-secret', seedSecretName ],
      image && [ 'ghcr.io/undefinedsco/xpod:replace-me', image ],
    ].filter(Boolean));
    let manifest = execFileSync('kubectl', [ 'kustomize', tempOverlay ], {
      encoding: 'utf8',
      stdio: [ 'ignore', 'pipe', 'pipe' ],
      timeout: 120000,
    });
    assertNoRcResidue(manifest, secretName);
    const objects = YAML.parseAllDocuments(manifest).map(document => document.toJSON()).filter(Boolean);
    for (const object of objects) {
      if (!['ConfigMap', 'Service', 'Deployment'].includes(object.kind) || object.metadata?.namespace !== GZ_NAMESPACE
        || !['xpod-rc', 'xpod-rc-config'].includes(object.metadata?.name)) throw new Error('final manifest contains a shared or foreign resource');
      const identity = admission.identities.find(entry => entry.kind === object.kind && entry.name === object.metadata.name);
      if (!identity?.uid || !identity.resourceVersion) throw new Error('RC resource ownership is missing from admission');
      object.metadata.uid = identity.uid; object.metadata.resourceVersion = identity.resourceVersion;
      if (object.kind === 'Deployment') {
        object.metadata.uid = current.metadata.uid;
        object.metadata.resourceVersion = current.metadata.resourceVersion;
        object.metadata.annotations = {...object.metadata.annotations,[OWNER]:ownership.nonce,[OWNERSHIP]:JSON.stringify(ownershipForDeployment(ownership))};
        const container = object.spec.template.spec.containers.find(entry => entry.name === 'xpod');
        container.env.find(entry => entry.name === 'XPOD_INNGEST_BASE_URL').value = `http://${ownership.executor.name}:8288`;
        // Do not change unrelated existing template settings while changing the RC payload.
        const old = current.spec?.template?.spec;
        if (old?.imagePullSecrets) object.spec.template.spec.imagePullSecrets = old.imagePullSecrets;
      }
    }
    manifest = objects.map(object => YAML.stringify(object)).join('---\n');
    fs.mkdirSync(path.dirname(input.output), { recursive: true });
    fs.writeFileSync(input.output, manifest, {mode:0o600});
    return manifest;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  renderRcManifests(args);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[render-rc-manifests] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  renderRcManifests,
  validateImmutableImage,
  validateKubernetesName,
};
