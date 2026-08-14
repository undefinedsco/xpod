import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createAcceptanceTempDir,
  createLocalNativeSearchEngine,
  createPostgresSearchEngine,
  qleverAcceptanceGateEnabled,
  requireAcceptanceEnv,
  runLocalSearchFusionAcceptance,
  runNativeSearchFusionAcceptance,
  runPostgresNativeSearchFusionAcceptance,
} from '../../../src/acceptance/QleverSearchConformance';

const expectedCanonical = [{
  source: 'https://pod.example/alice/projects/demo/moved-card.md',
  sourceKey: 'entity:card:fusion-stable',
  retrievalPointKey: 'point:intro',
  textSnippet: 'alpha late vector canonical card',
  vectorSnippet: 'alpha late vector canonical card',
}];

describe('QLever local/cloud search parity acceptance', () => {
  it('enables native SPARQL only for private PG QLever search', () => {
    const nativeEngine = createPostgresSearchEngine('postgres://postgres@localhost/xpod', true);
    const publicEngine = createPostgresSearchEngine('postgres://postgres@localhost/xpod', false);

    expect(nativeEngine.sparqlQuery).toBeTypeOf('function');
    expect(publicEngine.sparqlQuery).toBeUndefined();
  });

  it('keeps Local FTS-only sources empty until late VEC arrives, then fuses by stable key through moves and scope denial', async () => {
    await expect(runLocalSearchFusionAcceptance()).resolves.toEqual(expectedCanonical);
  });

  it('runs the same native QLever search corpus through Local SQLite and Cloud PG', async () => {
    const localCanonical = await runLocalSearchFusionAcceptance();
    expect(localCanonical).toEqual(expectedCanonical);

    if (!qleverAcceptanceGateEnabled()) {
      expect(process.env.XPOD_QLEVER_ACCEPTANCE_GATE).not.toBe('1');
      return;
    }

    const runtimeCommand = requireAcceptanceEnv('XPOD_QLEVER_SQLITE_RUNTIME_COMMAND');
    const pgDsn = requireAcceptanceEnv('XPOD_QLEVER_PG_DSN');
    const tempRoot = createAcceptanceTempDir('qlever-native-search-parity');
    try {
      const [local, cloud] = await Promise.all([
        runNativeSearchFusionAcceptance(
          createLocalNativeSearchEngine(runtimeCommand, join(tempRoot, 'search.sqlite')),
        ),
        runPostgresNativeSearchFusionAcceptance(pgDsn),
      ]);
      expect(cloud).toEqual(local);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
