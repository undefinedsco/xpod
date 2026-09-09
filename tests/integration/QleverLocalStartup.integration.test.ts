import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalQleverNativeSparqlClient } from '../../src/storage/rdf/LocalQleverNativeSparqlClient';
import { runLocalQleverSemanticConformance } from '../../src/acceptance/QleverSemanticConformance';
import {
  createAcceptanceTempDir,
  qleverAcceptanceGateEnabled,
  requireAcceptanceEnv,
} from '../../src/acceptance/QleverSearchConformance';

describe('QLever Local startup acceptance', () => {
  it('gates real Local startup on an explicit runtime command, SELECT/ASK smoke, and semantic fixture', async () => {
    if (!qleverAcceptanceGateEnabled()) {
      expect(process.env.XPOD_QLEVER_ACCEPTANCE_GATE).not.toBe('1');
      return;
    }

    const runtimeCommand = requireAcceptanceEnv('XPOD_QLEVER_SQLITE_RUNTIME_COMMAND');
    const fixturePath = requireAcceptanceEnv('XPOD_QLEVER_SEMANTIC_FIXTURE_PATH');
    const artifactPath = requireAcceptanceEnv('XPOD_QLEVER_SQLITE_SEMANTIC_ARTIFACT_PATH');
    const tempRoot = createAcceptanceTempDir('qlever-local-startup-acceptance');
    const smokeDbPath = join(tempRoot, 'startup-smoke.sqlite');
    mkdirSync(tempRoot, { recursive: true });

    const client = new LocalQleverNativeSparqlClient({
      command: runtimeCommand,
      args: ['--sqlite-path', smokeDbPath],
      cwd: process.env.XPOD_QLEVER_SQLITE_RUNTIME_CWD,
      startupTimeoutMs: Number(process.env.XPOD_QLEVER_SQLITE_SEMANTIC_TIMEOUT_MS ?? 30_000),
      requestTimeoutMs: Number(process.env.XPOD_QLEVER_SQLITE_SEMANTIC_TIMEOUT_MS ?? 30_000),
    });
    try {
      await expect(client.query('ASK {}', {
        basePath: 'urn:xpod:local-startup:',
        acceptMediaType: 'application/sparql-results+json',
      })).resolves.toMatchObject({ status: 'ok' });
      await expect(client.query('SELECT * WHERE {}', {
        basePath: 'urn:xpod:local-startup:',
        acceptMediaType: 'application/sparql-results+json',
      })).resolves.toMatchObject({ status: 'ok' });
    } finally {
      await client.close();
    }

    const report = await runLocalQleverSemanticConformance({
      fixturePath,
      runtimeCommand,
      artifactPath,
      tempRoot,
      runtimeCwd: process.env.XPOD_QLEVER_SQLITE_RUNTIME_CWD,
      timeoutMs: Number(process.env.XPOD_QLEVER_SQLITE_SEMANTIC_TIMEOUT_MS ?? 30_000),
    });
    expect(report.status).toBe('ok');
    expect(report.skipped).toEqual([]);
    expect(report.results.length).toBe(report.caseIds.length);
    rmSync(tempRoot, { recursive: true, force: true });
  });
});
