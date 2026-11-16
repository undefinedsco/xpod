'use strict';

// Selects the Ready, non-terminating Pod that runs the requested immutable
// image in the Deployment's service container. A rollout can briefly list the
// old Pod as Running (and Ready) while it is terminating next to the new Pod;
// selecting by phase alone therefore proves nothing about the deployed image.
// This module is the single selector shared by the .co and .cn gates.

const fs = require('node:fs');

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function targetDigest(reference) {
  if (typeof reference !== 'string') {
    throw new Error(`malformed target image: ${JSON.stringify(reference)}`);
  }
  const trimmed = reference.trim();
  const separator = trimmed.lastIndexOf('@');
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error(`malformed target image: ${trimmed || 'empty'} (expected repository@sha256:<64 hex>)`);
  }
  const digest = trimmed.slice(separator + 1);
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`malformed target image digest: ${digest} (expected sha256:<64 lowercase hex>)`);
  }
  return digest;
}

function podReady(status) {
  const conditions = status?.conditions;
  if (!Array.isArray(conditions)) {
    return false;
  }
  return conditions.some((condition) => condition?.type === 'Ready' && condition?.status === 'True');
}

function serviceContainerState(pod, serviceContainer) {
  const containers = pod?.spec?.containers;
  if (!Array.isArray(containers)) {
    return { specImage: undefined, status: undefined };
  }
  const specContainer = containers.find((container) => container?.name === serviceContainer);
  const statuses = pod?.status?.containerStatuses;
  const status = Array.isArray(statuses)
    ? statuses.find((containerStatus) => containerStatus?.name === serviceContainer)
    : undefined;
  return { specImage: specContainer?.image, status };
}

function rejectionReason(pod, serviceContainer, targetImageReference, digest) {
  if (pod.metadata.deletionTimestamp) {
    return 'terminating';
  }
  if (pod.status?.phase !== 'Running') {
    return `phase ${pod.status?.phase ?? 'unknown'}`;
  }
  if (!podReady(pod.status)) {
    return 'pod is not Ready';
  }
  const { specImage, status } = serviceContainerState(pod, serviceContainer);
  if (typeof specImage !== 'string' || specImage.length === 0) {
    return `service container ${serviceContainer} is missing from the pod spec`;
  }
  if (specImage !== targetImageReference) {
    return `service container ${serviceContainer} spec image ${specImage} is not the target image`;
  }
  if (!status) {
    return `service container ${serviceContainer} has no container status`;
  }
  if (status.ready !== true) {
    return `service container ${serviceContainer} is not Ready`;
  }
  if (typeof status.imageID !== 'string' || !status.imageID.includes(digest)) {
    return `service container ${serviceContainer} imageID does not contain ${digest}`;
  }
  return undefined;
}

function createdTimestamp(pod) {
  const value = pod.metadata.creationTimestamp;
  return typeof value === 'string' ? value : '';
}

function selectReadyPod(pods, { targetImageReference, serviceContainer } = {}) {
  const digest = targetDigest(targetImageReference);
  if (typeof serviceContainer !== 'string' || serviceContainer.length === 0) {
    throw new Error('malformed service container: expected a non-empty name');
  }
  if (!pods || typeof pods !== 'object' || !Array.isArray(pods.items)) {
    throw new Error('malformed pod list: expected an object with an items array');
  }
  const eligible = [];
  const rejected = [];
  for (const pod of pods.items) {
    if (!pod || typeof pod !== 'object' || !pod.metadata
      || typeof pod.metadata.name !== 'string' || pod.metadata.name.length === 0) {
      throw new Error('malformed pod list: every pod must have a non-empty metadata.name');
    }
    const reason = rejectionReason(pod, serviceContainer, targetImageReference, digest);
    if (reason) {
      rejected.push(`${pod.metadata.name} (${reason})`);
      continue;
    }
    eligible.push({
      podName: pod.metadata.name,
      imageID: pod.status.containerStatuses.find((status) => status.name === serviceContainer).imageID,
      creationTimestamp: createdTimestamp(pod),
    });
  }
  if (eligible.length === 0) {
    const detail = rejected.length === 0 ? 'the pod list is empty' : rejected.slice(0, 5).join('; ');
    throw new Error(`no eligible pod: none is Running, Ready, non-terminating and on target image ${targetImageReference} (${detail})`);
  }
  // Every eligible Pod runs the same immutable digest; prefer the newest Pod
  // only to make the choice deterministic when a surge leaves two Ready Pods.
  eligible.sort((left, right) => {
    if (left.creationTimestamp !== right.creationTimestamp) {
      return left.creationTimestamp < right.creationTimestamp ? 1 : -1;
    }
    return left.podName < right.podName ? -1 : left.podName > right.podName ? 1 : 0;
  });
  return {
    podName: eligible[0].podName,
    imageID: eligible[0].imageID,
    serviceContainer,
    digest,
  };
}

function parseArgs(argv) {
  const options = { targetImage: undefined, serviceContainer: undefined, podsJson: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target-image') {
      options.targetImage = argv[index + 1];
      index += 1;
    } else if (arg === '--service-container') {
      options.serviceContainer = argv[index + 1];
      index += 1;
    } else if (arg === '--pods-json') {
      options.podsJson = argv[index + 1];
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
  if (!options.serviceContainer) {
    throw new Error('--service-container is required');
  }
  const raw = options.podsJson ? fs.readFileSync(options.podsJson, 'utf8') : fs.readFileSync(0, 'utf8');
  let pods;
  try {
    pods = JSON.parse(raw);
  } catch (error) {
    throw new Error(`malformed pod list: not valid JSON (${error.message})`);
  }
  process.stdout.write(`${JSON.stringify(selectReadyPod(pods, {
    targetImageReference: options.targetImage,
    serviceContainer: options.serviceContainer,
  }))}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error::production-deployment-pod: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { selectReadyPod, targetDigest };
