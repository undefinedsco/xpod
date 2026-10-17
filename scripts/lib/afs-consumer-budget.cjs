'use strict';
const budget = require('./afs-consumer-budget.json');
function afsConsumerBudget(stage = 'prepublish') {
  if (!['prepublish', 'postpublish'].includes(stage)) throw Error('unknown AFS consumer stage');
  if (budget.schemaVersion !== 1 || budget.kind !== 'fixed-afs-consumer-budget' ||
      Object.entries(budget).some(([key, value]) => !['schemaVersion', 'kind'].includes(key) &&
        (!Number.isSafeInteger(value) || value <= 0))) throw Error('invalid fixed AFS budget');
  const fullMountedCommandSeconds = budget.mountedHarnessSeconds + budget.mountedOwnedCloseSeconds + budget.mountedSerializationSeconds;
  const ordinary = budget.runtimeCount * budget.ordinaryCommandsPerRuntime + budget.toolVersionCommands;
  const consumerRunSeconds = ordinary * budget.ordinaryCommandSeconds + budget.runtimeCount * fullMountedCommandSeconds +
    (ordinary + budget.runtimeCount) * budget.commandOwnedCloseSeconds + budget.captureStages * budget.captureStageSeconds +
    budget.runtimeCount * budget.cycleCleanupSeconds;
  const maximumDurationSeconds = consumerRunSeconds + budget.safeExportSeconds + budget.commandOwnedCloseSeconds +
    (stage === 'postpublish' ? budget.registryReadbackSeconds + budget.registrySingleflightSeconds : 0);
  const hostSeconds = maximumDurationSeconds + budget.hostSetupSeconds + budget.hostFinalizationSeconds + budget.uploadWindowSeconds;
  if (hostSeconds >= 6 * 3600) throw Error('AFS host projection exceeds six-hour authority');
  return Object.freeze({stage, hostSetupSeconds: budget.hostSetupSeconds, hostFinalizationSeconds: budget.hostFinalizationSeconds,
    uploadWindowSeconds: budget.uploadWindowSeconds, registryReadbackSeconds: budget.registryReadbackSeconds,
    registrySingleflightSeconds: budget.registrySingleflightSeconds, safeExportSeconds: budget.safeExportSeconds,
    commandOwnedCloseSeconds: budget.commandOwnedCloseSeconds, fullMountedCommandSeconds,
    ordinaryCommandSeconds: budget.ordinaryCommandSeconds, consumerRunSeconds, maximumDurationSeconds,
    hostJobMinutes: Math.ceil(hostSeconds / 60)});
}
module.exports = {afsConsumerBudget};
