import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

const { validateBoundary, validateDatabases } = createRequire(import.meta.url)('../../scripts/check-rc-deployment-boundary.cjs');
const { ownsRcDeployment } = createRequire(import.meta.url)('../../scripts/rc-cleanup-ownership.cjs');
const config = (server = 'https://gzg.sealos.run:6443') => ({
  'current-context': 'gz', contexts: [{ name: 'gz', context: { cluster: 'gz' } }],
  clusters: [{ name: 'gz', cluster: { server } }],
});
const database = 'postgresql://xpod_rc:test-password@xpod-rdf-postgres:5432/xpod_rc';
const entries = (url = database) => new Map([['CSS_IDENTITY_DB_URL', url], ['CSS_SPARQL_ENDPOINT', url]]);

describe('GZ RC deployment boundary', () => {
  it('retains absent, malformed and other-run deployments during cleanup', () => {
    const deployment = { metadata: { name: 'xpod-rc', namespace: 'ns-iknkxtc8' },
      spec: { template: { spec: { volumes: [{ secret: { secretName: 'xpod-rc-seed-123-1' } }] } } } };
    expect(ownsRcDeployment(deployment, 'ns-iknkxtc8', 'xpod-rc-seed-123-1')).toBe(true);
    expect(ownsRcDeployment(deployment, 'ns-iknkxtc8', 'xpod-rc-seed-124-1')).toBe(false);
    expect(ownsRcDeployment(deployment, 'other', 'xpod-rc-seed-123-1')).toBe(false);
    expect(ownsRcDeployment(deployment, 'ns-iknkxtc8', '')).toBe(false);
    expect(ownsRcDeployment(null, 'ns-iknkxtc8', 'xpod-rc-seed-123-1')).toBe(false);
    expect(ownsRcDeployment({}, 'ns-iknkxtc8', 'xpod-rc-seed-123-1')).toBe(false);
  });

  it('admits only the active GZ cluster and exact namespace', () => {
    expect(() => validateBoundary(config(), 'ns-iknkxtc8')).not.toThrow();
    for (const server of ['https://sg.sealos.run:6443', 'https://gzg.sealos.run:6443.evil', '']) {
      expect(() => validateBoundary(config(server), 'ns-iknkxtc8')).toThrow();
    }
    expect(() => validateBoundary(config(), 'production')).toThrow();
    expect(() => validateBoundary({}, 'ns-iknkxtc8')).toThrow();
  });

  it('admits the isolated RC role and database without leaking credentials', () => {
    expect(() => validateDatabases(entries())).not.toThrow();
    for (const url of [database.replace('/xpod_rc', '/xpod_cn'),
      database.replace('xpod_rc:', 'postgres:'), database.replace('xpod-rdf-postgres', 'other'),
      `${database}?dbname=xpod_cn`, `${database}#override`, 'invalid']) {
      expect(() => validateDatabases(entries(url))).toThrow();
      try { validateDatabases(entries(url)); } catch (error) {
        expect(String(error)).not.toContain('test-password');
      }
    }
    const mismatch = entries();
    mismatch.set('CSS_SPARQL_ENDPOINT', database.replace('test-password', 'other-password'));
    expect(() => validateDatabases(mismatch)).toThrow();
    mismatch.set('CSS_SPARQL_ENDPOINT', database);
    mismatch.set('CSS_TASK_DB_URL', database.replace('/xpod_rc', '/xpod_co'));
    expect(() => validateDatabases(mismatch)).toThrow();
  });

  it('runs CI on main and staging pushes and PRs', async () => {
    const text = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const workflow = parseDocument(text).toJS();
    expect(workflow.on.push.branches).toEqual(['main', 'staging']);
    expect(workflow.on.pull_request.branches).toEqual(['main', 'staging']);
  });

  it('checks the local kubeconfig before either job contacts the cluster', async () => {
    const text = await readFile(new URL('../../.github/workflows/candidate.yml', import.meta.url), 'utf8');
    const workflow = parseDocument(text).toJS();
    for (const job of ['rc_prerequisites', 'deploy_and_accept', 'cleanup_rc']) {
      const commands = workflow.jobs[job].steps.map((step: any) => step.run || '').join('\n');
      const boundary = commands.indexOf('node scripts/check-rc-deployment-boundary.cjs');
      expect(boundary).toBeGreaterThan(0);
      expect(boundary).toBeLessThan(commands.indexOf('kubectl '));
    }
  });

  it('requires actual PG17 and extensions before recording database acceptance', async () => {
    const text = await readFile(new URL('../../.github/workflows/candidate.yml', import.meta.url), 'utf8');
    const workflow = parseDocument(text).toJS();
    const steps = workflow.jobs.deploy_and_accept.steps;
    const resetIndex = steps.findIndex((step: any) => step.name === 'Reset the shared RC database');
    const reset = steps[resetIndex].run;
    expect(reset.indexOf('SHOW server_version_num')).toBeLessThan(reset.indexOf('DROP DATABASE'));
    expect(reset).toContain('17????');
    expect(reset).toContain('test "$extensions" = 3');
    expect(reset).toContain('ALTER SCHEMA xpod_rdf OWNER TO xpod_rc');
    expect(text).not.toContain('"postgres-ephemeral": "passed"');
    expect(steps.findIndex((step: any) => step.name === 'Deploy RC image by digest')).toBeGreaterThan(resetIndex);
  });
});
