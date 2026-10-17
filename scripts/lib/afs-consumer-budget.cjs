'use strict';
const budget = require('./afs-consumer-budget.json');
const limits = require('./module-artifact-limits.json');
function afsConsumerBudget(stage = 'prepublish') {
  if (!['prepublish', 'postpublish'].includes(stage)) throw Error('unknown AFS consumer stage');
  if (budget.schemaVersion !== 1 || budget.kind !== 'fixed-afs-consumer-budget' ||
      Object.entries(budget).some(([key, value]) => !['schemaVersion', 'kind', 'harnessCommands'].includes(key) &&
        (!Number.isSafeInteger(value) || value <= 0))) throw Error('invalid fixed AFS budget');
  if (!Array.isArray(budget.harnessCommands) || budget.harnessCommands.length !== 6 || new Set(budget.harnessCommands.map(row => row.label)).size !== 6 || budget.harnessCommands.some(row => !/^verifier-harness-(?:checkout|install|build-tools|client|patch-check|remove)$/.test(row.label) || !Number.isSafeInteger(row.timeoutSeconds) || row.timeoutSeconds <= 0)) throw Error('invalid fixed harness command budget');
  const fullMountedCommandSeconds = budget.mountedHarnessSeconds + budget.mountedOwnedCloseSeconds + budget.mountedSerializationSeconds;
  const ordinary = budget.runtimeCount * budget.ordinaryCommandsPerRuntime + budget.toolVersionCommands;
  const consumerRunSeconds = ordinary * budget.ordinaryCommandSeconds + budget.runtimeCount * (fullMountedCommandSeconds + budget.normalInstallSeconds) +
    (ordinary + 2 * budget.runtimeCount + budget.harnessCommands.length) * budget.commandOwnedCloseSeconds + budget.captureStages * budget.captureStageSeconds +
    budget.sourceObservationCommands * budget.sourceObservationCommandSeconds + budget.runtimeCount * budget.cycleCleanupSeconds + budget.harnessCommands.reduce((sum, row) => sum + row.timeoutSeconds, 0);
  const maximumDurationSeconds = consumerRunSeconds + budget.officialRuntimeObservationSeconds + budget.safeExportSeconds + budget.commandOwnedCloseSeconds +
    (stage === 'postpublish' ? budget.registryReadbackSeconds + budget.registrySingleflightSeconds : 0);
  const hostSeconds = maximumDurationSeconds + budget.hostSetupSeconds + budget.hostFinalizationSeconds + budget.uploadWindowSeconds;
  if (hostSeconds >= 6 * 3600) throw Error('AFS host projection exceeds six-hour authority');
  return Object.freeze({stage, officialRuntimeObservationSeconds: budget.officialRuntimeObservationSeconds, freshHarnessLiveBytes: limits.sourceBytes + 2 * limits.dependencyBytes, harnessCommands: Object.freeze(budget.harnessCommands.map(row => Object.freeze({...row}))), hostSetupSeconds: budget.hostSetupSeconds, hostFinalizationSeconds: budget.hostFinalizationSeconds,
    uploadWindowSeconds: budget.uploadWindowSeconds, registryReadbackSeconds: budget.registryReadbackSeconds,
    registrySingleflightSeconds: budget.registrySingleflightSeconds, safeExportSeconds: budget.safeExportSeconds,
    commandOwnedCloseSeconds: budget.commandOwnedCloseSeconds, fullMountedCommandSeconds,
    normalInstallSeconds: budget.normalInstallSeconds, ordinaryCommandSeconds: budget.ordinaryCommandSeconds, consumerRunSeconds, maximumDurationSeconds,
    hostJobMinutes: Math.ceil(hostSeconds / 60)});
}
module.exports = {afsConsumerBudget};
