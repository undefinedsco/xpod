'use strict';
const fs = require('node:fs');
const { afsConsumerBudget } = require('./afs-consumer-budget.cjs');
/** Workflow composition only. The Source-owned declaration/getter is the sole
 * duration authority; non-AFS workflows retain their existing literal windows. */
function consumerWorkflowBudget(module, stage = 'prepublish', flow = 'matching-host') {
  if (!['client', 'cli', 'api', 'css', 'afs'].includes(module)
    || !['prepublish', 'postpublish'].includes(stage)
    || !['matching-host', 'module-installed'].includes(flow)) throw Error('Fixed consumer workflow route required');
  if (module !== 'afs') return undefined;
  if (flow === 'module-installed' && stage !== 'prepublish') throw Error('Installed module preparation uses collected archives');
  const budget = afsConsumerBudget(stage);
  const exportSeconds = flow === 'module-installed' ? budget.safeExportSeconds : 0;
  const projection = Object.freeze({ job_minutes: budget.hostJobMinutes,
    command_minutes: Math.ceil((budget.maximumDurationSeconds - exportSeconds) / 60),
    setup_minutes: Math.ceil(budget.hostSetupSeconds / 60), upload_minutes: Math.ceil(budget.uploadWindowSeconds / 60),
    finalization_minutes: Math.ceil(budget.hostFinalizationSeconds / 60), export_minutes: Math.ceil(exportSeconds / 60) });
  if (Object.values(projection).some(value => !Number.isSafeInteger(value) || value < 0)
    || projection.command_minutes + projection.setup_minutes + projection.upload_minutes + projection.finalization_minutes + projection.export_minutes > projection.job_minutes)
    throw Error('Rounded AFS workflow windows exceed the authoritative host budget');
  return projection;
}
function writeConsumerWorkflowBudget(module, stage, flow, output) {
  const budget = consumerWorkflowBudget(module, stage, flow);
  if (!budget) return;
  if (typeof output !== 'string' || !output) throw Error('Controlled workflow output required');
  fs.appendFileSync(output, Object.entries(budget).map(([key, value]) => 'afs_' + key + '=' + value).join('\n') + '\n');
}
function checkConsumerWorkflowSetup(module, stage, startedNs) {
  if (module !== 'afs') return;
  if (process.versions.bun) throw Error('Pinned Node required for the cross-process AFS setup clock');
  if (typeof startedNs !== 'string' || !/^[0-9]+$/.test(startedNs)) throw Error('Actual AFS setup clock required');
  const elapsed = process.hrtime.bigint() - BigInt(startedNs);
  if (elapsed < 0n || elapsed > BigInt(afsConsumerBudget(stage).hostSetupSeconds) * 1000000000n)
    throw Error('Actual AFS setup exceeded the authoritative host window');
}
module.exports = { consumerWorkflowBudget, writeConsumerWorkflowBudget, checkConsumerWorkflowSetup };
if (require.main === module) {
  if (process.env.CONSUMER_BUDGET_CHECK_SETUP === 'true') checkConsumerWorkflowSetup(process.env.CONSUMER_BUDGET_MODULE,
    process.env.CONSUMER_BUDGET_STAGE || 'prepublish', process.env.AFS_WORKFLOW_SETUP_STARTED_NS);
  else writeConsumerWorkflowBudget(process.env.CONSUMER_BUDGET_MODULE,
    process.env.CONSUMER_BUDGET_STAGE || 'prepublish', process.env.CONSUMER_BUDGET_FLOW || 'matching-host', process.env.GITHUB_OUTPUT);
}
