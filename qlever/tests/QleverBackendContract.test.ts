import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const script = path.join(repoRoot, 'qlever/scripts/check-qlever-backend-contract.cjs');
const source = path.join(repoRoot, 'qlever/backend_contract/src/xpod_rdf_backend_contract.cpp');
const candidateSource = path.join(repoRoot, 'qlever/candidate_contract/src/xpod_rdf_candidate_contract.cpp');

type PendingEvidence = {
  schemaVersion: number;
  backend: 'sqlite';
  status: 'pending-live-runtime';
  reason: string;
  callbackCoverage: Record<string, never>;
  rowDigest: null;
  scopeOutcomes: Record<string, never>;
  versions: null;
  unsupportedOptionalLeaves: string[];
};

describe('public QLever local backend contract', () => {
  it('ships provider-neutral contract runners in the public SDK source set', () => {
    expect(existsSync(source)).toBe(true);
    expect(existsSync(candidateSource)).toBe(true);
    const backendRunner = readFileSync(source, 'utf8');
    const candidateRunner = readFileSync(candidateSource, 'utf8');

    expect(backendRunner).toContain('xpod_qlever_backend_provider_create');
    expect(candidateRunner).toContain('xpod_qlever_backend_provider_create');
    expect(backendRunner).not.toContain('scan_block_metadata');
    expect(candidateRunner).not.toContain('scan_block_metadata');

    const sdkDockerfile = readFileSync(path.join(repoRoot, 'docker/qlever-runtime-sdk/Dockerfile'), 'utf8');
    const incrementalDockerfile = readFileSync(
      path.join(repoRoot, 'docker/qlever-runtime-sdk/Dockerfile.incremental'),
      'utf8',
    );
    const workflow = readFileSync(path.join(repoRoot, '.github/workflows/publish-qlever-runtime-sdk.yml'), 'utf8');
    for (const text of [sdkDockerfile, incrementalDockerfile, workflow]) {
      expect(text).toContain('qlever/backend_contract');
      expect(text).toContain('qlever/candidate_contract');
      expect(text).toContain('test -d /components/qlever/backend_contract');
      expect(text).toContain('test -d /components/qlever/candidate_contract');
      expect(text).not.toContain('qlever/rdf_pg_backend');
    }
  });

  it('exposes a package command that defaults to sqlite and reports missing local DB truthfully', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['check:qlever-backend-contract']).toBe(
      'node qlever/scripts/check-qlever-backend-contract.cjs',
    );

    const result = spawnSync('node', [script], {
      cwd: repoRoot,
      env: { ...process.env, XPOD_QLEVER_SQLITE_DB: '' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()) as PendingEvidence).toEqual({
      schemaVersion: 1,
      backend: 'sqlite',
      status: 'pending-live-runtime',
      reason: 'XPOD_QLEVER_SQLITE_DB not provided',
      callbackCoverage: {},
      rowDigest: null,
      scopeOutcomes: {},
      versions: null,
      unsupportedOptionalLeaves: [],
    });
  });

  it('rejects PG aliases in the public Local contract runner', () => {
    for (const backend of ['pg', 'postgres', 'postgresql']) {
      const result = spawnSync('node', [script, `--backend=${backend}`], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`unsupported backend ${backend}`);
    }

    const scriptSource = readFileSync(script, 'utf8');
    expect(scriptSource).toContain("const backend = requested?.slice('--backend='.length) ?? 'sqlite'");
    expect(scriptSource).toContain("backend !== 'sqlite'");
    expect(scriptSource).toContain('rdf_sqlite_backend');
    expect(scriptSource).toContain('xpod_rdf_sqlite_backend');
    expect(scriptSource).not.toMatch(/rdf_pg_backend|XPOD_QLEVER_PG_DSN|psql|libpq|PostgreSQL/);
  });

  it('can prepare the sqlite contract schema without compiling native code', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'xpod-qlever-sqlite-contract-'));
    try {
      const databasePath = path.join(root, 'contract.sqlite');
      const result = spawnSync('node', [script, '--prepare-only'], {
        cwd: repoRoot,
        env: { ...process.env, XPOD_QLEVER_SQLITE_DB: databasePath },
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        schemaVersion: 1,
        backend: 'sqlite',
        status: 'prepared',
        databasePath,
      });
      expect(existsSync(databasePath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
