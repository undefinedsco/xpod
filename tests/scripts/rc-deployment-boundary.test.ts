import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

const { validateBoundary, validateDatabases, rcPostgresHosts } = createRequire(import.meta.url)('../../scripts/check-rc-deployment-boundary.cjs');
const { ownsRcDeployment } = createRequire(import.meta.url)('../../scripts/rc-cleanup-ownership.cjs');
const config = (server = 'https://gzg.sealos.run:6443') => ({
  'current-context': 'gz', contexts: [{ name: 'gz', context: { cluster: 'gz' } }],
  clusters: [{ name: 'gz', cluster: { server } }],
});
const NS = 'ns-iknkxtc8';
const database = 'postgresql://xpod_rc:test-password@xpod-rc-rdf-postgres:5432/xpod_rc';
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

  it('admits the RC-only PostgreSQL service variants', () => {
    for (const host of rcPostgresHosts(NS)) {
      expect(() => validateDatabases(entries(database.replace('xpod-rc-rdf-postgres', host)), NS)).not.toThrow();
    }
  });

  it('rejects the shared production host and production roles/databases', () => {
    for (const host of ['xpod-rdf-postgres', `xpod-rdf-postgres.${NS}`,
      `xpod-rdf-postgres.${NS}.svc`, `xpod-rdf-postgres.${NS}.svc.cluster.local`,
      'production-postgres', 'id.undefineds.cn']) {
      expect(() => validateDatabases(entries(database.replace('xpod-rc-rdf-postgres', host)), NS)).toThrow();
    }
    for (const url of [database.replace('/xpod_rc', '/xpod_cn'),
      database.replace('/xpod_rc', '/xpod_co'),
      database.replace('xpod_rc:', 'postgres:'),
      'invalid']) {
      expect(() => validateDatabases(entries(url), NS)).toThrow();
      try { validateDatabases(entries(url), NS); } catch (error) {
        expect(String(error)).not.toContain('test-password');
      }
    }
  });

  it('rejects ports, query, fragment and mismatched/conflicting credentials', () => {
    for (const url of [database.replace(':5432', ':5433'), `${database}?dbname=xpod_cn`,
      `${database}#override`, `${database}?sslmode=require`]) {
      expect(() => validateDatabases(entries(url), NS)).toThrow();
      try { validateDatabases(entries(url), NS); } catch (error) {
        expect(String(error)).not.toContain('test-password');
      }
    }
    const mismatch = entries();
    mismatch.set('CSS_SPARQL_ENDPOINT', database.replace('test-password', 'other-password'));
    expect(() => validateDatabases(mismatch, NS)).toThrow();
    mismatch.set('CSS_SPARQL_ENDPOINT', database);
    mismatch.set('CSS_TASK_DB_URL', database.replace('/xpod_rc', '/xpod_co'));
    expect(() => validateDatabases(mismatch, NS)).toThrow();
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
    const preflightIndex = steps.findIndex((step: any) => step.name === 'Verify RC-only PostgreSQL and bootstrap without touching production');
    expect(preflightIndex).toBeGreaterThan(0);
    expect(steps[preflightIndex].run).toContain('scripts/verify-protected-rc-database.sh');
    expect(steps[preflightIndex].run).toContain('statefulset/xpod-rc-rdf-postgres');
    const preflight = await readFile(new URL('../../scripts/verify-protected-rc-database.sh', import.meta.url), 'utf8');
    expect(preflight).toContain('SHOW server_version_num');
    expect(preflight).toContain('17????');
    expect(preflight).toContain('BEGIN READ ONLY');
    expect(preflight).toContain("extname = 'xpod_qlever' AND extversion = '0.4.0'");
    // The workflow itself never runs DDL; provisioning belongs to the dedicated
    // RC-only bootstrap Job template.
    expect(text).not.toMatch(/DROP DATABASE|CREATE DATABASE|CREATE EXTENSION|ALTER SCHEMA/);
    expect(text).not.toContain('"postgres-ephemeral": "passed"');
    expect(steps.findIndex((step: any) => step.name === 'Create runtime secrets')).toBeGreaterThan(preflightIndex);
    expect(steps.findIndex((step: any) => step.name === 'Deploy RC image by digest')).toBeGreaterThan(preflightIndex);
  });
});
