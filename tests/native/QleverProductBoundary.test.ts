import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const qleverSpecPath = path.join(repoRoot, 'docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md');
const qleverPlanPath = path.join(repoRoot, 'docs/superpowers/plans/2026-06-29-native-first-rdf-physical-protocol.md');
const performancePlanPath = path.join(repoRoot, 'docs/rdf-performance-and-migration-plan.md');

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf8'));
}

describe('QLever product boundary', () => {
  it('documents QLever-compatible native acceleration as Cloud Enterprise-only, not local', async () => {
    const spec = await readFile(qleverSpecPath, 'utf8');
    const plan = await readFile(qleverPlanPath, 'utf8');
    const performancePlan = await readFile(performancePlanPath, 'utf8');

    for (const document of [spec, plan, performancePlan]) {
      expect(document).toContain('Cloud Enterprise-only');
      expect(document).toContain('Local deployments do not expose the QLever-compatible native adapter');
    }
    expect(performancePlan).toContain('public cloud configuration stays on `pg-hot-operators`');
  });

  it('keeps local and public cloud configs off the QLever-compatible native path', async () => {
    const localConfig = await readJson('config/local.json') as { '@graph': Array<Record<string, unknown>> };
    const cloudConfig = await readJson('config/cloud.json') as { '@graph': Array<Record<string, unknown>> };

    const localEngine = localConfig['@graph'].find((entry) => entry['@id'] === 'urn:undefineds:xpod:SolidRdfEngine');
    const cloudEngine = cloudConfig['@graph'].find((entry) => entry['@id'] === 'urn:undefineds:xpod:SolidRdfEngine');

    expect(localEngine).toMatchObject({
      '@type': 'SolidRdfEngine',
    });
    expect(cloudEngine).toMatchObject({
      '@type': 'PostgresRdfEngine',
      options_rdfAccelerationProfile: 'pg-hot-operators',
    });

    const localText = JSON.stringify(localConfig);
    const publicCloudText = JSON.stringify(cloudConfig);
    for (const configText of [localText, publicCloudText]) {
      expect(configText).not.toMatch(/qlever/i);
      expect(configText).not.toContain('pg-custom-index');
      expect(configText).not.toContain('xpod_rdf_perm');
    }
  });
});
