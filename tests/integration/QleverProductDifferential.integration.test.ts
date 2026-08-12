import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAcceptanceTempDir,
  qleverAcceptanceGateEnabled,
  requireAcceptanceEnv,
  runLocalSearchFusionAcceptance,
} from '../../src/acceptance/QleverSearchConformance';
import {
  assertSemanticConformanceParity,
  runLocalQleverSemanticConformance,
  runPostgresQleverSemanticConformance,
} from '../../src/acceptance/QleverSemanticConformance';

describe('QLever product differential acceptance', () => {
  it('requires explicit Local and Cloud evidence when the acceptance gate is enabled', async () => {
    await expect(runLocalSearchFusionAcceptance()).resolves.toHaveLength(1);

    if (!qleverAcceptanceGateEnabled()) {
      expect(process.env.XPOD_QLEVER_ACCEPTANCE_GATE).not.toBe('1');
      return;
    }

    const runtimeCommand = requireAcceptanceEnv('XPOD_QLEVER_SQLITE_RUNTIME_COMMAND');
    const fixturePath = requireAcceptanceEnv('XPOD_QLEVER_SEMANTIC_FIXTURE_PATH');
    const pgDsn = requireAcceptanceEnv('XPOD_QLEVER_PG_DSN');
    const tempRoot = createAcceptanceTempDir('qlever-product-differential-acceptance');
    mkdirSync(tempRoot, { recursive: true });
    const sqliteReportPath = join(tempRoot, 'sqlite-semantic.json');
    const pgReportPath = join(tempRoot, 'pg-semantic.json');

    try {
      const [sqliteReport, pgReport] = await Promise.all([
        runLocalQleverSemanticConformance({
          fixturePath,
          runtimeCommand,
          artifactPath: sqliteReportPath,
          tempRoot: join(tempRoot, 'sqlite'),
        }),
        runPostgresQleverSemanticConformance({
          fixturePath,
          connectionString: pgDsn,
          artifactPath: pgReportPath,
        }),
      ]);
      expect(sqliteReport).toMatchObject({ status: 'ok', skipped: [] });
      expect(pgReport).toMatchObject({ status: 'ok', skipped: [] });
      expect(assertSemanticConformanceParity(sqliteReport, pgReport)).toMatchObject({
        caseIds: sqliteReport.caseIds,
        canonicalDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
