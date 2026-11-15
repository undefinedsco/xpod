#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const YAML = require('yaml');

// The RC PostgreSQL templates are deliberately NOT in the kustomization: the
// app Deployment must still be produced by one final apply, while the RC-only
// PG StatefulSet/bootstrap Job are provisioned separately beforehand.
const PG_PLACEHOLDER = 'ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres:replace-me';
const PG_TEMPLATES = [ 'postgres.yaml', 'postgres-bootstrap.yaml' ];

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
      case '--pg-image':
        args.pgImage = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--pg-output':
        args.pgOutput = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      case '--pg-only':
        args.pgOnly = true;
        break;
      case '--pg-owner':
        args.pgOwner = validateKubernetesName(readOptionValue(argv, index, arg), 'pgOwner');
        index += 1;
        break;
      case '--pg-job-name':
        args.pgJobName = validateKubernetesName(readOptionValue(argv, index, arg), 'pgJobName');
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  for (const key of [ 'overlay', 'namespace' ]) {
    if (!args[key]) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} requires a value`);
  }
  if (!args.pgOnly && !args.output) throw new Error('--output requires a value');
  if (args.pgJobName !== undefined && args.pgOutput === undefined) {
    throw new Error('--pg-job-name requires --pg-output');
  }
  if (args.pgOwner !== undefined && args.pgJobName === undefined) {
    throw new Error('--pg-owner requires --pg-job-name');
  }
  if (args.pgOnly && (args.pgImage === undefined || args.pgOutput === undefined)) {
    throw new Error('--pg-only requires --pg-image and --pg-output');
  }
  if (args.pgOnly && args.output !== undefined) {
    throw new Error('--pg-only renders no app manifest; drop --output');
  }
  if (args.pgImage !== undefined || args.pgOutput !== undefined) {
    // Both halves are mandatory together: a PG image without a destination
    // would silently render nothing, and a destination without an image would
    // bake a stale placeholder.
    if (!args.pgImage || !args.pgOutput) {
      throw new Error('--pg-image and --pg-output must be provided together');
    }
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

const PG_BOOTSTRAP_STATIC_NAME = 'xpod-rc-postgres-bootstrap';

const OWNER_ANNOTATION = 'xpod.undefineds.co/bootstrap-owner';

function renderPgManifests(tempOverlay, output, image, jobName, owner) {
  const canonical = validateImmutableImage(image);
  const parts = [];
  for (const name of PG_TEMPLATES) {
    const file = path.join(tempOverlay, name);
    if (!fs.existsSync(file)) throw new Error(`missing RC PostgreSQL template: ${name}`);
    const raw = fs.readFileSync(file, 'utf8');
    // Substitute here as well as in the app pass so this function is usable on
    // a pristine overlay. Substitution is idempotent.
    let text = raw.replaceAll(PG_PLACEHOLDER, canonical);
    if (owner !== undefined && jobName === undefined) {
      throw new Error('an owner annotation requires a run-scoped Job name');
    }
    if (jobName !== undefined && name === 'postgres-bootstrap.yaml') {
      // D2: the bootstrap Job must be run-owned. A fixed name lets a COMPLETE
      // Job from an earlier run satisfy `wait --for=condition=complete` and
      // skip provisioning entirely, and its pod template is immutable so a
      // changed template cannot be applied over it.
      if (jobName === PG_BOOTSTRAP_STATIC_NAME) {
        throw new Error('--pg-job-name must be run-scoped, not the static template name');
      }
      text = text.replace(`name: ${PG_BOOTSTRAP_STATIC_NAME}`, `name: ${jobName}`);
      if (owner !== undefined) {
        // Ownership is stamped before apply so a same-name foreign or replaced
        // Job can be detected later and never deleted by name alone.
        text = text.replace(
          `  name: ${jobName}\n  labels:`,
          `  name: ${jobName}\n  annotations:\n    ${OWNER_ANNOTATION}: ${owner}\n  labels:`,
        );
        if (!text.includes(`${OWNER_ANNOTATION}: ${owner}`)) {
          throw new Error('failed to stamp the bootstrap Job ownership annotation');
        }
      }
    }
    if (text.includes(PG_PLACEHOLDER)) {
      throw new Error(`RC PostgreSQL template ${name} still contains the mutable placeholder`);
    }
    if (!text.includes(canonical)) {
      throw new Error(`RC PostgreSQL template ${name} does not carry the provided immutable image`);
    }
    const docs = YAML.parseAllDocuments(text).map((document) => document.toJSON()).filter(Boolean);
    if (!docs.length) throw new Error(`RC PostgreSQL template ${name} is empty`);
    for (const document of docs) {
      if (!document.kind || !document.metadata?.name) {
        throw new Error(`RC PostgreSQL template ${name} has an object without kind/name`);
      }
      if (document.metadata.namespace === 'xpod-rc') {
        throw new Error(`RC PostgreSQL template ${name} must not pin the xpod-rc namespace`);
      }
      const containers = document.spec?.template?.spec?.containers ?? [];
      for (const container of containers) {
        if (container.image !== canonical) {
          throw new Error(`RC PostgreSQL template ${name} container ${container.name} does not use the provided image`);
        }
      }
    }
    parts.push(text.trimEnd());
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${parts.join('\n---\n')}\n`);
  return parts.join('\n---\n');
}

function renderRcManifests(input) {
  if (input.pgOnly) {
    if (input.image !== undefined) throw new Error('--pg-only must not receive an app --image');
    const pgImage = validateImmutableImage(input.pgImage);
    const pgJobName = input.pgJobName === undefined
      ? undefined : validateKubernetesName(input.pgJobName, 'pgJobName');
    const pgOwner = input.pgOwner === undefined
      ? undefined : validateKubernetesName(input.pgOwner, 'pgOwner');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-rc-pg-'));
    try {
      const tempOverlay = path.join(tempRoot, 'rc');
      copyOverlay(input.overlay, tempOverlay);
      return renderPgManifests(tempOverlay, input.pgOutput, pgImage, pgJobName, pgOwner);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
  const namespace = validateKubernetesName(input.namespace, 'namespace');
  const secretName = input.secretName === undefined ? undefined : validateKubernetesName(input.secretName, 'secretName');
  const seedSecretName = input.seedSecretName === undefined ? undefined : validateKubernetesName(input.seedSecretName, 'seedSecretName');
  const image = input.image === undefined ? undefined : validateImmutableImage(input.image);
  const pgImage = input.pgImage === undefined ? undefined : validateImmutableImage(input.pgImage);
  if ((pgImage === undefined) !== (input.pgOutput === undefined)) {
    throw new Error('--pg-image and --pg-output must be provided together');
  }
  const pgJobName = input.pgJobName === undefined
    ? undefined : validateKubernetesName(input.pgJobName, 'pgJobName');
  const pgOwner = input.pgOwner === undefined
    ? undefined : validateKubernetesName(input.pgOwner, 'pgOwner');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-rc-overlay-'));
  try {
    const tempOverlay = path.join(tempRoot, 'rc');
    copyOverlay(input.overlay, tempOverlay);
    rewriteKustomization(tempOverlay, namespace);
    replaceYamlValues(tempOverlay, [
      secretName && [ 'xpod-rc-secret', secretName ],
      seedSecretName && [ 'xpod-rc-seed-secret', seedSecretName ],
      image && [ 'ghcr.io/undefinedsco/xpod:replace-me', image ],
      pgImage && [ PG_PLACEHOLDER, pgImage ],
    ].filter(Boolean));
    const manifest = execFileSync('kubectl', [ 'kustomize', tempOverlay ], {
      encoding: 'utf8',
      stdio: [ 'ignore', 'pipe', 'pipe' ],
    });
    assertNoRcResidue(manifest, secretName);
    fs.mkdirSync(path.dirname(input.output), { recursive: true });
    fs.writeFileSync(input.output, manifest);
    if (pgImage !== undefined && input.pgOutput !== undefined) {
      // Rendered from the same canonical NATIVE_PG_IMAGE input as the app and
      // the pull preflight; there is no second PG digest constant.
      renderPgManifests(tempOverlay, input.pgOutput, pgImage, pgJobName, pgOwner);
    }
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
  renderPgManifests,
  validateImmutableImage,
  validateKubernetesName,
  PG_PLACEHOLDER,
  PG_TEMPLATES,
  PG_BOOTSTRAP_STATIC_NAME,
  OWNER_ANNOTATION,
};
