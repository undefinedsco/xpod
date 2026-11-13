import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (name: string) => parse(readFileSync(path.join(root, '.github/workflows', name), 'utf8')) as any;

/** Expensive independent producers are manual; cheap contracts stay automatic. */
describe('independent module producer scheduling', () => {
  it('keeps API contract automatic and makes expensive producers dispatch-only', () => {
    const workflow = load('api-module-product.yml');
    expect(workflow.on.push.branches).toEqual(['staging']);
    expect(workflow.on.pull_request.branches).toEqual(['staging', 'main']);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.jobs.contract.if).toBeUndefined();
    expect(workflow.jobs.products.if).toBe("${{ github.event_name == 'workflow_dispatch' }}");
    expect(workflow.jobs.products.needs).toBe('contract');
    expect(workflow.jobs.products.strategy['max-parallel']).toBe(4);
  });

  it('keeps CSS contract automatic and makes native/products/pending dispatch-only', () => {
    const workflow = load('css-module-product.yml');
    expect(workflow.on.pull_request.branches).toEqual(['staging', 'main']);
    expect(workflow.jobs.contract.if).toBeUndefined();
    for (const name of ['native', 'products', 'pending-native-sources']) {
      expect(workflow.jobs[name].if).toBe("${{ github.event_name == 'workflow_dispatch' }}");
    }
    expect(workflow.jobs.products.needs).toEqual(['contract', 'native']);
    expect(workflow.jobs.products.strategy['max-parallel']).toBe(1);
    expect(workflow.jobs.native.uses).toBe('./.github/workflows/build-qlever-macos-runtime.yml');
  });

  it('preserves exact controlled CSS native workflow bytes for its existing SDK route', () => {
    const workflow = load('css-native-products.yml');
    expect(workflow.on.push.branches).toEqual(['staging']);
    expect(workflow.on.workflow_dispatch.inputs.target.default).toBe('all');
    expect(workflow.jobs.contract.if).toBeUndefined();
    expect(workflow.jobs.targets.if).toBeUndefined();
    const bytes = readFileSync(path.join(root, '.github/workflows/css-native-products.yml'));
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51');
    expect(workflow.jobs.targets.needs).toBe('contract');
    expect(workflow.jobs.targets.strategy['max-parallel']).toBe(1);
  });

  it('gives AFS a cheap automatic contract and manual mounted acceptance', () => {
    const workflow = load('agentfs-module-mounted-acceptance.yml');
    expect(workflow.on.pull_request.branches).toEqual(['staging', 'main']);
    expect(workflow.on.push.branches).toEqual(['staging', 'main']);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.jobs.contract.if).toBeUndefined();
    expect(workflow.jobs.contract.steps.at(-1).run).toContain('tests/scripts/agentfs_linux_cidfile_test.py');
    expect(workflow.jobs['mounted-module'].if).toBe("${{ github.event_name == 'workflow_dispatch' }}");
    expect(workflow.jobs['mounted-module'].needs).toBe('contract');
    expect(workflow.jobs['mounted-module']['timeout-minutes']).toBe(120);
    expect(workflow.jobs['mounted-module'].strategy.matrix.include).toHaveLength(4);
    // The identity regression moved, never duplicated.
    const text = readFileSync(path.join(root, '.github/workflows/agentfs-module-mounted-acceptance.yml'), 'utf8');
    expect(text.match(/Owned container identity publication regression/gu)).toHaveLength(1);
    for (const name of ['Owned container identity publication regression']) {
      expect(workflow.jobs['mounted-module'].steps.some((step: any) => step.name === name)).toBe(false);
    }
  });

  it('does not remove any mandatory service qualification gate', () => {
    const ci = load('ci.yml');
    expect(ci.on.push.branches).toEqual(['main', 'staging']);
    expect(ci.jobs.test.if).toBe("${{ github.event_name != 'workflow_dispatch' }}");
    for (const name of ['integration-lite', 'bun-runtime', 'integration-full']) {
      expect(ci.jobs[name].if).toBe("${{ github.event_name != 'workflow_dispatch' }}");
    }
    const candidate = load('candidate.yml');
    expect(candidate.on.push.branches).toEqual(['staging']);
    expect(candidate.jobs.deploy_and_accept).toBeDefined();
    expect(candidate.jobs.build_desktop_rc).toBeDefined();
    expect(candidate.jobs.runtime_mode_matrix).toBeDefined();
    const legacy = load('legacy-root-compat.yml');
    expect(legacy.on.push.branches).toEqual(['main']);
    expect(legacy.on.pull_request.branches).toEqual(['main', 'staging']);
    expect(legacy.on).toHaveProperty('workflow_call');
  });
});
