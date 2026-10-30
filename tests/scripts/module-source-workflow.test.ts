import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CSS_SOURCE_PARENT_VERSIONS, reviewedModuleSupervisorSource, reviewedModuleSourceWorkflow, reviewedModuleProducerSource } from '../../scripts/lib/independent-admission/module-source-phases';
describe('same private origin module source workflow route policy', () => {
  it('preserves exact reviewed parent/producer versions and rejects unknown or mixed source tuples', () => {
    const input = { workflowPath: '.github/workflows/css-native-products.yml', producerWorkflowPath: '.github/workflows/css-native-products.yml',
      workflowSourceSha256: '8312031501f9f0d640e100ddec75e0fe1150d0ee93812b3f8c6785b032319c0f', producerSourceSha256: '431d033a41f01ab317124e1e5488543ea1ac82fa59c2ef3845ddd43ab4e61f4c', target: 'darwin-arm64', producerMachine: 'arm64', producerMacOSVersion: '15.7.2', jobRunnerLabels: ['macos-15'], jobName: 'targets (darwin-arm64) / products' };
    expect(reviewedModuleSourceWorkflow('css', input)).toBe(true);
    const next = {...input, workflowSourceSha256: '601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51', producerSourceSha256: '78e2ec3c272233602083f81d574cfefc5f6c36e9200c1d92e6f7935bd6cac41f'};
    expect(reviewedModuleSourceWorkflow('css', next)).toBe(true);
    expect(reviewedModuleSourceWorkflow('css', {...next, producerSourceSha256: input.producerSourceSha256})).toBe(false);
    expect(reviewedModuleSourceWorkflow('css', {...input, producerSourceSha256: next.producerSourceSha256})).toBe(false);
    expect(reviewedModuleSourceWorkflow('css', {...next, producerSourceSha256: undefined})).toBe(false);
    expect(reviewedModuleProducerSource('css', input.producerSourceSha256)).toBe(true);
    expect(reviewedModuleProducerSource('css', next.producerSourceSha256)).toBe(true);
    expect(reviewedModuleProducerSource('css', '0'.repeat(64))).toBe(false);
    for (const change of [{ workflowSourceSha256: '0'.repeat(64) }, { target: 'darwin-x64' }, { target: 'linux-arm64' },
      { jobName: 'targets (darwin-arm64) / native/macos/build' }, { producerWorkflowPath: '.github/workflows/css-module-product.yml' },
      { workflowPath: '.github/workflows/other-css-native-products.yml' }]) expect(reviewedModuleSourceWorkflow('css', { ...input, ...change })).toBe(false);
    expect(reviewedModuleSourceWorkflow('api', input)).toBe(false);
    expect(reviewedModuleSourceWorkflow('afs', input)).toBe(false);
  });
  it('routes the new exact parent to each canonical hosted target, never borrowed host/native evidence', () => {
    const common = {workflowPath: '.github/workflows/css-native-products.yml', producerWorkflowPath: '.github/workflows/css-native-products.yml',
      workflowSourceSha256: '601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51', producerSourceSha256: '78e2ec3c272233602083f81d574cfefc5f6c36e9200c1d92e6f7935bd6cac41f'};
    for (const [target, runner, producerMachine, producerMacOSVersion] of [
      ['linux-x64', 'ubuntu-24.04', 'x86_64', ''], ['linux-arm64', 'ubuntu-24.04-arm', 'aarch64', ''],
      ['darwin-x64', 'macos-15-intel', 'x86_64', '15.7.2'], ['darwin-arm64', 'macos-15', 'arm64', '15.7.2'],
    ]) {
      const row = {...common, target, producerMachine, producerMacOSVersion, jobRunnerLabels: [runner!], jobName: `targets (${target}) / products`};
      expect(reviewedModuleSourceWorkflow('css', row)).toBe(true);
      for (const change of [{jobName: `targets (${target}) / native / macos / build`}, {jobName: `targets (${target}) / native / linux / module_runtime_materials / archive`},
        {producerMachine: 'borrowed-host'}, {jobRunnerLabels: ['ubuntu-latest']}, {jobRunnerLabels: [runner!, 'self-hosted']}, {producerMacOSVersion: '14.7'}, {target: 'win32-x64'}]) {
        expect(reviewedModuleSourceWorkflow('css', {...row, ...change})).toBe(false);
      }
      if (target !== 'darwin-arm64') expect(reviewedModuleSourceWorkflow('css', {...row,
        workflowSourceSha256: '8312031501f9f0d640e100ddec75e0fe1150d0ee93812b3f8c6785b032319c0f', producerSourceSha256: '431d033a41f01ab317124e1e5488543ea1ac82fa59c2ef3845ddd43ab4e61f4c'})).toBe(false);
    }
  });
  it('keeps the existing module routes and requires the producer to name that same workflow', () => {
    for (const module of ['api', 'css', 'afs'] as const) {
      const workflow = module === 'afs' ? '.github/workflows/agentfs-module-mounted-acceptance.yml' : `.github/workflows/${module}-module-product.yml`;
      const input = { workflowPath: workflow, producerWorkflowPath: workflow, workflowSourceSha256: 'existing private origin policy', jobName: 'existing private origin job' };
      expect(reviewedModuleSourceWorkflow(module, input)).toBe(true);
      expect(reviewedModuleSourceWorkflow(module, { ...input, producerWorkflowPath: 'other' })).toBe(false);
    }
  });
  it('keeps the reviewed historical CSS producer accepted and admits the current diagnostics producer without rewriting history', () => {
    // ACTUAL source bytes, not dynamic re-derivation: these are the shipped files.
    const actual = (name: string) => readFileSync(path.resolve(__dirname, '../..', name));
    const sha = (name: string) => createHash('sha256').update(actual(name)).digest('hex');
    const OLD = '9bc6411c30e8f96402f39b80acf9e8af27350bfde84d0ec6d4e5f8eb04a05da4';
    const NEW = '1ba30f5eaba9070f55135936649c43b109bf7a4a83db43b512edaa6d31abc5cc';
    const CONTROLLED = sha('.github/workflows/css-native-products.yml');
    // The controlled workflow itself is unchanged, and the live producer is the new one.
    expect(CONTROLLED).toBe('601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51');
    expect(sha('scripts/css-module-producer.py')).toBe(NEW);
    // Old route must NOT be removed by registering the new version.
    expect(reviewedModuleProducerSource('css', OLD)).toBe(true);
    // New actual producer must be admitted.
    expect(reviewedModuleProducerSource('css', NEW)).toBe(true);
    expect(reviewedModuleProducerSource('css', sha('scripts/css-module-producer.py'))).toBe(true);
    // The three historical parent tuples keep their exact bytes.
    expect(CSS_SOURCE_PARENT_VERSIONS).toHaveLength(4);
    expect(CSS_SOURCE_PARENT_VERSIONS.slice(0, 3)).toEqual([
      {workflowSha256: '8312031501f9f0d640e100ddec75e0fe1150d0ee93812b3f8c6785b032319c0f', producerSha256: '431d033a41f01ab317124e1e5488543ea1ac82fa59c2ef3845ddd43ab4e61f4c', targets: 'darwin-arm64-only'},
      {workflowSha256: CONTROLLED, producerSha256: '78e2ec3c272233602083f81d574cfefc5f6c36e9200c1d92e6f7935bd6cac41f', targets: 'canonical-catalog'},
      {workflowSha256: CONTROLLED, producerSha256: OLD, targets: 'canonical-catalog'},
    ]);
    // The appended row is the new producer against the SAME controlled workflow.
    expect(CSS_SOURCE_PARENT_VERSIONS[3]).toEqual({workflowSha256: CONTROLLED, producerSha256: NEW, targets: 'canonical-catalog'});
    // Exact controlled route: old and new producer both admitted, same unchanged workflow.
    const base = { workflowPath: '.github/workflows/css-native-products.yml', producerWorkflowPath: '.github/workflows/css-native-products.yml',
      workflowSourceSha256: CONTROLLED, target: 'linux-arm64', producerMachine: 'aarch64', producerMacOSVersion: '',
      jobRunnerLabels: ['ubuntu-24.04-arm'], jobName: 'targets (linux-arm64) / products' };
    expect(reviewedModuleSourceWorkflow('css', { ...base, producerSourceSha256: OLD })).toBe(true);
    expect(reviewedModuleSourceWorkflow('css', { ...base, producerSourceSha256: NEW })).toBe(true);
    // Truly unregistered combinations are rejected (not merely "different").
    expect(reviewedModuleSourceWorkflow('css', { ...base, producerSourceSha256: '0'.repeat(64) })).toBe(false);
    expect(reviewedModuleSourceWorkflow('css', { ...base, workflowSourceSha256: '0'.repeat(64), producerSourceSha256: NEW })).toBe(false);
    // The NORMAL product workflow is a SEPARATE admission path: it is admitted by
    // path equality (producer admission is `reviewedModuleProducerSource`, checked
    // above), and it is NOT a member of the CONTROLLED native-products table.
    const normal = sha('.github/workflows/css-module-product.yml');
    expect(normal).not.toBe(CONTROLLED);
    expect(reviewedModuleSourceWorkflow('css', { ...base, workflowPath: '.github/workflows/css-module-product.yml',
      producerWorkflowPath: '.github/workflows/css-module-product.yml', workflowSourceSha256: normal, producerSourceSha256: NEW })).toBe(true);
    // A CSS producer carrying a DIFFERENT workflow path is rejected outright.
    expect(reviewedModuleSourceWorkflow('css', { ...base, producerWorkflowPath: '.github/workflows/css-module-product.yml' })).toBe(false);
    // Supervisor: the ACTUAL tree is accepted, and EVERY registered CSS producer
    // (historical 78e2ec/9bc641 and the new diagnostics 1ba30f) is a complete
    // reviewed tuple against the unchanged materials/limits/supervisor bytes.
    expect(reviewedModuleSupervisorSource('css', name => actual(name))).toBe(true);
    // A fixed historical byte-image keeps this check valid after commits and
    // in source archives without Git metadata.
    const historical = actual('tests/fixtures/independent-admission/css-producer-metadata-revalidation.original.py');
    expect(createHash('sha256').update(historical).digest('hex')).toBe(OLD);
    expect(reviewedModuleSupervisorSource('css', name => name === 'scripts/css-module-producer.py' ? historical : actual(name))).toBe(true);
    // A genuinely unregistered producer byte-image is refused.
    expect(reviewedModuleSupervisorSource('css', name => name === 'scripts/css-module-producer.py'
      ? Buffer.from('unreviewed CSS producer') : actual(name))).toBe(false);
  });
});
