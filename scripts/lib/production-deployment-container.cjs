'use strict';

// Selects the single application ("service") container from a live Deployment
// manifest. The container name is not stable across environments (the .cn
// deployment names it `xpod`, the .co deployment names it `xpod-co`), so the
// deploy workflow must derive it from the deployed manifest and the target
// image repository instead of hardcoding a name. Regular sidecars are ignored;
// exactly one container must use the target repository or the step fails.

const fs = require('node:fs');

function parseImageRepository(reference) {
  if (typeof reference !== 'string') {
    throw new Error(`malformed image reference: ${JSON.stringify(reference)}`);
  }
  const trimmed = reference.trim();
  if (trimmed.length === 0) {
    throw new Error('malformed image reference: empty');
  }
  const withoutDigest = trimmed.includes('@') ? trimmed.slice(0, trimmed.indexOf('@')) : trimmed;
  if (withoutDigest.length === 0) {
    throw new Error(`malformed image reference: ${trimmed}`);
  }
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  // A colon after the last slash separates a tag; a colon before it is a
  // registry port (for example `localhost:5000/xpod`).
  const repository = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
  if (repository.length === 0) {
    throw new Error(`malformed image reference: ${trimmed}`);
  }
  return repository;
}

function selectServiceContainer(deployment, targetImageReference) {
  if (!deployment || typeof deployment !== 'object') {
    throw new Error('malformed deployment: expected an object');
  }
  const targetRepository = parseImageRepository(targetImageReference);
  const containers = deployment.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length === 0) {
    throw new Error('malformed deployment: spec.template.spec.containers must be a non-empty array');
  }
  const matches = [];
  for (const container of containers) {
    if (!container || typeof container !== 'object' || typeof container.name !== 'string' || container.name.length === 0) {
      throw new Error('malformed deployment: every container must have a non-empty name');
    }
    if (typeof container.image !== 'string' || container.image.length === 0) {
      throw new Error(`malformed deployment: container ${container.name} has no image`);
    }
    if (parseImageRepository(container.image) === targetRepository) {
      matches.push({ name: container.name, image: container.image });
    }
  }
  if (matches.length === 0) {
    throw new Error(`missing service container: no container uses image repository ${targetRepository}`);
  }
  if (matches.length > 1) {
    const names = matches.map((match) => match.name).sort().join(', ');
    throw new Error(`ambiguous service container: multiple containers use image repository ${targetRepository}: ${names}`);
  }
  return {
    serviceContainer: matches[0].name,
    previousImage: matches[0].image,
    repository: targetRepository,
  };
}

function parseArgs(argv) {
  const options = { targetImage: undefined, deploymentJson: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target-image') {
      options.targetImage = argv[index + 1];
      index += 1;
    } else if (arg === '--deployment-json') {
      options.deploymentJson = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (!options.targetImage) {
    throw new Error('--target-image is required');
  }
  const raw = options.deploymentJson ? fs.readFileSync(options.deploymentJson, 'utf8') : fs.readFileSync(0, 'utf8');
  let deployment;
  try {
    deployment = JSON.parse(raw);
  } catch (error) {
    throw new Error(`malformed deployment: not valid JSON (${error.message})`);
  }
  process.stdout.write(`${JSON.stringify(selectServiceContainer(deployment, options.targetImage))}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error::production-deployment-container: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { parseImageRepository, selectServiceContainer };
