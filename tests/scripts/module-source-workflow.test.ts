import { describe, expect, it } from 'vitest';
import { reviewedModuleSourceWorkflow, reviewedModuleProducerSource } from '../../scripts/lib/independent-admission/module-source-phases';
describe('same private origin module source workflow route policy', () => {
  it('admits only the exact reviewed current CSS parent/product job/available target tuple', () => {
    const input = { workflowPath: '.github/workflows/css-native-products.yml', producerWorkflowPath: '.github/workflows/css-native-products.yml',
      workflowSourceSha256: '8312031501f9f0d640e100ddec75e0fe1150d0ee93812b3f8c6785b032319c0f', producerSourceSha256: '431d033a41f01ab317124e1e5488543ea1ac82fa59c2ef3845ddd43ab4e61f4c', target: 'darwin-arm64', jobName: 'targets (darwin-arm64) / products' };
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
  it('keeps the existing module routes and requires the producer to name that same workflow', () => {
    for (const module of ['api', 'css', 'afs'] as const) {
      const workflow = module === 'afs' ? '.github/workflows/agentfs-module-mounted-acceptance.yml' : `.github/workflows/${module}-module-product.yml`;
      const input = { workflowPath: workflow, producerWorkflowPath: workflow, workflowSourceSha256: 'existing private origin policy', jobName: 'existing private origin job' };
      expect(reviewedModuleSourceWorkflow(module, input)).toBe(true);
      expect(reviewedModuleSourceWorkflow(module, { ...input, producerWorkflowPath: 'other' })).toBe(false);
    }
  });
});
