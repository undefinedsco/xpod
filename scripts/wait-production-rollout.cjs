#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
function failureReason(pods, container, targetImage) {
  for (const pod of pods.items || []) {
    if (pod.metadata?.deletionTimestamp || !pod.spec?.containers?.some(row => row.name === container && row.image === targetImage)) continue;
    for (const status of [...(pod.status?.containerStatuses || []), ...(pod.status?.initContainerStatuses || [])]) {
      const reason = status.state?.waiting?.reason;
      if (['CreateContainerConfigError', 'CreateContainerError', 'InvalidImageName'].includes(reason)) return 'rollout_configuration_error';
      if (['ErrImagePull', 'ImagePullBackOff'].includes(reason)) return 'rollout_image_pull_wait';
    }
  }
  return undefined;
}
function wait(deployment, namespace, container, targetImage, timeoutSeconds, command, now = () => Date.now()) {
  const deadline = now() + timeoutSeconds * 1000; let pullFailures = 0;
  while (now() < deadline) {
    const result = command(['rollout', 'status', `deployment/${deployment}`, '-n', namespace, '--timeout=15s']);
    if (result.status === 0) return;
    const read = command(['-n', namespace, 'get', 'pods', '-l', `app=${deployment}`, '-o', 'json']);
    if (read.status !== 0) throw new Error('rollout_read_unavailable');
    let pods; try { pods = JSON.parse(read.stdout); } catch { throw new Error('rollout_invalid_response'); }
    const reason = failureReason(pods, container, targetImage);
    if (reason === 'rollout_configuration_error') throw new Error(reason);
    // Pull errors can be transient; only repeated observations classify a failure.
    pullFailures = reason === 'rollout_image_pull_wait' ? pullFailures + 1 : 0;
    if (pullFailures >= 4) throw new Error('rollout_image_pull_persistent');
  }
  throw new Error('rollout_timeout');
}
module.exports = { failureReason, wait };
if (require.main === module) {
  try {
    const [deployment, namespace, container, targetImage, timeout = '900'] = process.argv.slice(2);
    if (![deployment, namespace, container].every(value => /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value || '')) || !Number.isInteger(Number(timeout)) || Number(timeout) <= 0) throw new Error('rollout_invalid_target');
    wait(deployment, namespace, container, targetImage, Number(timeout), args => spawnSync('kubectl', args, { encoding: 'utf8', timeout: 20000 }));
    console.log('rollout_readiness_confirmed');
  } catch (error) {
    const code = /^rollout_[a-z_]+$/.test(error.message) ? error.message : 'rollout_unclassified';
    console.error(JSON.stringify({ status: 'failed', code })); process.exitCode = 1;
  }
}
