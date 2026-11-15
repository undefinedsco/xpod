import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { afsConsumerBudget } = require('../../scripts/lib/afs-consumer-budget.cjs');
const { consumerWorkflowBudget, checkConsumerWorkflowSetup } = require('../../scripts/lib/consumer-workflow-budget.cjs');
function workflow(name: string) {
  return JSON.parse(execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())))'], {
    input: readFileSync('.github/workflows/' + name, 'utf8'), encoding: 'utf8', timeout: 5000,
  }));
}
test('AFS host/command/setup/export/upload windows derive from the one Source authority for each route', () => {
  for (const stage of ['prepublish', 'postpublish']) for (const flow of ['matching-host', 'module-installed']) {
    if (flow === 'module-installed' && stage === 'postpublish') continue;
    const source = afsConsumerBudget(stage), projected = consumerWorkflowBudget('afs', stage, flow);
    expect(projected.job_minutes).toBe(source.hostJobMinutes);
    expect(projected.setup_minutes).toBe(Math.ceil(source.hostSetupSeconds / 60));
    expect(projected.upload_minutes).toBe(Math.ceil(source.uploadWindowSeconds / 60));
    expect(projected.command_minutes).toBe(Math.ceil((source.maximumDurationSeconds - (flow === 'module-installed' ? source.safeExportSeconds : 0)) / 60));
    expect(projected.export_minutes).toBe(flow === 'module-installed' ? Math.ceil(source.safeExportSeconds / 60) : 0);
    expect(projected.command_minutes + projected.export_minutes + projected.setup_minutes + projected.upload_minutes + projected.finalization_minutes <= projected.job_minutes).toBe(true);
  }
  expect(consumerWorkflowBudget('afs', 'postpublish').command_minutes > consumerWorkflowBudget('afs', 'prepublish').command_minutes).toBe(true);
  for (const module of ['client', 'cli', 'api', 'css']) expect(consumerWorkflowBudget(module)).toBe(undefined);
});
test('both matching-host workflows project only AFS while preserving ordinary windows and upload custody', () => {
  for (const [name, stage] of [['independent-archive-consumer.yml', 'prepublish'], ['independent-registry-consumer.yml', 'postpublish']]) {
    const data = workflow(name), resolve = data.jobs.resolve, job = data.jobs.consume;
    expect(resolve.steps.find((step: any) => step.id === 'budget').env.CONSUMER_BUDGET_STAGE).toBe(stage);
    expect(job['timeout-minutes']).toBe("${{ inputs.module == 'afs' && fromJSON(needs.resolve.outputs.afs_job_minutes) || 45 }}");
    const command = job.steps.find((step: any) => step.name?.startsWith('Run fixed '));
    expect(command['timeout-minutes']).toBe("${{ inputs.module == 'afs' && fromJSON(needs.resolve.outputs.afs_command_minutes) || 27 }}");
    expect(job.steps.find((step: any) => step.name === 'Install the reviewed consumer toolchain')['timeout-minutes'])
      .toBe("${{ inputs.module == 'afs' && fromJSON(needs.resolve.outputs.afs_setup_minutes) || 10 }}");
    const uploads = job.steps.filter((step: any) => step.uses === 'actions/upload-artifact@v4');
    for (const step of uploads) expect(step['timeout-minutes']).toBe("${{ inputs.module == 'afs' && fromJSON(needs.resolve.outputs.afs_upload_minutes) || 5 }}");
    expect(uploads[1].if).toBe("${{ failure() && (inputs.module != 'afs' || steps.upload.outcome != 'failure') }}");
    expect(job.steps[0].name).toBe('Start the bounded AFS setup clock');
    expect(job.steps.some((step: any) => step.env?.CONSUMER_BUDGET_CHECK_SETUP === 'true')).toBe(true);
  }
});
test('manual installed AFS uses the full driver and splits safe export out of its same command allowance', () => {
  const data = workflow('module-installed-consumer.yml'), job = data.jobs.prepare;
  expect(data.jobs.select.steps.find((step: any) => step.id === 'budget')?.run).toBe('bun scripts/lib/consumer-workflow-budget.cjs');
  expect(data.jobs.select.steps.find((step: any) => step.id === 'target')?.run.trimEnd().endsWith("'")).toBe(true);
  expect(job['timeout-minutes']).toBe("${{ needs.select.outputs.module == 'afs' && fromJSON(needs.select.outputs.afs_job_minutes) || 30 }}");
  const command = job.steps.find((step: any) => step.id === 'plan');
  expect(command.run).toContain('afs) driver=scripts/lib/afs-module-consumer.py ;;');
  expect(command['timeout-minutes']).toContain('afs_command_minutes');
  expect(job.steps.find((step: any) => step.name?.startsWith('Export bounded'))['timeout-minutes']).toContain('afs_export_minutes');
  expect(job.steps.find((step: any) => step.uses === 'actions/upload-artifact@v4')['timeout-minutes']).toContain('afs_upload_minutes');
});
test('actual Node setup clock spans processes and expires before complete mounted profiles are launched', () => {
  const started = execFileSync('node', ['-e', 'console.log(process.hrtime.bigint().toString())'], { encoding: 'utf8' }).trim();
  const code = 'const {checkConsumerWorkflowSetup}=require("./scripts/lib/consumer-workflow-budget.cjs");checkConsumerWorkflowSetup("afs","prepublish",process.argv[1]);';
  expect(() => execFileSync('node', ['-e', code, started], { stdio: 'pipe', timeout: 5000 })).not.toThrow();
  // Fresh CI hosts can have less uptime than the setup window. Keep the
  // cross-process positive check real, and control only the expiry boundary.
  const expiredCode = 'const {afsConsumerBudget}=require("./scripts/lib/afs-consumer-budget.cjs");process.hrtime.bigint=()=>BigInt(afsConsumerBudget().hostSetupSeconds+1)*1000000000n;' + code;
  expect(() => execFileSync('node', ['-e', expiredCode, '0'], { stdio: 'pipe', timeout: 5000 })).toThrow('setup exceeded');
  expect(() => checkConsumerWorkflowSetup('css', 'prepublish', undefined)).not.toThrow();
  // Bun uses a different hrtime origin. Never accept its clock in the Node check.
  expect(() => checkConsumerWorkflowSetup('afs', 'prepublish', started)).toThrow('Pinned Node required');
});


test('actual resolver writes only the fixed AFS projection to controlled workflow outputs', () => {
  const parent = path.resolve('.test-data/afs-workflow-budget-output'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'resolver-'));
  try {
    const output = path.join(root, 'outputs');
    execFileSync(process.execPath, ['scripts/lib/consumer-workflow-budget.cjs'], { env: {
      PATH: process.env.PATH, GITHUB_OUTPUT: output, CONSUMER_BUDGET_MODULE: 'afs', CONSUMER_BUDGET_STAGE: 'postpublish', CONSUMER_BUDGET_FLOW: 'matching-host',
    }, timeout: 5000 });
    const expected = Object.entries(consumerWorkflowBudget('afs', 'postpublish')).map(([key, value]) => 'afs_' + key + '=' + value).join('\n') + '\n';
    expect(readFileSync(output, 'utf8')).toBe(expected);
    execFileSync(process.execPath, ['scripts/lib/consumer-workflow-budget.cjs'], { env: {
      PATH: process.env.PATH, GITHUB_OUTPUT: output, CONSUMER_BUDGET_MODULE: 'css', CONSUMER_BUDGET_STAGE: 'postpublish',
    }, timeout: 5000 });
    expect(readFileSync(output, 'utf8')).toBe(expected);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
