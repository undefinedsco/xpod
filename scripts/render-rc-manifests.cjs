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
  const secretName = input.secretName === undefined ? undefined : validateKubernetesName(input.secretName, 'secretName');
  const seedSecretName = input.seedSecretName === undefined ? undefined : validateKubernetesName(input.seedSecretName, 'seedSecretName');
  const image = input.image === undefined ? undefined : validateImmutableImage(input.image);
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
    const manifest = execFileSync('kubectl', [ 'kustomize', tempOverlay ], {
      encoding: 'utf8',
      stdio: [ 'ignore', 'pipe', 'pipe' ],
    });
    assertNoRcResidue(manifest, secretName);
    fs.mkdirSync(path.dirname(input.output), { recursive: true });
    fs.writeFileSync(input.output, manifest);
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
