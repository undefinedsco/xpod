import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResourceChangeEvent, ResourceChangeListener } from '../../src/storage/ObservableResourceStore';
import { PostgresDerivedIndexJournal } from '../../src/storage/PostgresDerivedIndexJournal';
import { PgliteRdfSqlExecutor } from '../../src/storage/rdf/PostgresRdfSqlExecutor';

describe('PostgresDerivedIndexJournal', () => {
  it('delivers changes in sequence within each Pod', async () => {
    const db = new PGlite();
    const journal = new PostgresDerivedIndexJournal({
      executor: new PgliteRdfSqlExecutor(db),
      resolvePodScope: (event) => event.path.split('/')[1]!,
    });
    await journal.open();
    await journal.recordResourceChange(event('/alice/2'));
    await journal.recordResourceChange(event('/bob/1'));
    await journal.recordResourceChange(event('/alice/3'));

    const delivered: string[] = [];
    const listener: ResourceChangeListener = {
      onResourceChanged: async (change) => { delivered.push(change.path); },
    };
    expect(await journal.replayPending(listener)).toMatchObject({ delivered: 3, failed: 0 });
    expect(delivered.indexOf('/alice/2')).toBeLessThan(delivered.indexOf('/alice/3'));
  });

  it('keeps a failed head pending and does not overtake it within the Pod', async () => {
    const db = new PGlite();
    const journal = new PostgresDerivedIndexJournal({
      executor: new PgliteRdfSqlExecutor(db),
      resolvePodScope: () => 'alice',
      retryDelayMs: 60_000,
    });
    await journal.open();
    await journal.recordResourceChange(event('/alice/1'));
    await journal.recordResourceChange(event('/alice/2'));

    const delivered: string[] = [];
    const listener: ResourceChangeListener = {
      onResourceChanged: async (change) => {
        delivered.push(change.path);
        throw new Error('index unavailable');
      },
    };
    expect(await journal.replayPending(listener)).toMatchObject({ delivered: 0, failed: 1 });
    expect(delivered).toEqual(['/alice/1']);
    expect(await journal.pendingCount('alice')).toBe(2);
  });

  it('enqueues an authority snapshot for bootstrap self-healing', async () => {
    const db = new PGlite();
    const journal = new PostgresDerivedIndexJournal({
      executor: new PgliteRdfSqlExecutor(db),
      resolvePodScope: () => 'alice',
    });
    await journal.open();
    await journal.reconcilePod('alice', ['/alice/a.md', '/alice/b.ttl']);
    expect(await journal.pendingCount('alice')).toBe(2);
  });

  it('is the single durable recorder around the cloud ResourceStore backend', async () => {
    const cloud = JSON.parse(await readFile(path.join(process.cwd(), 'config/cloud.json'), 'utf8'));
    const graph = cloud['@graph'] as Array<Record<string, any>>;
    const journal = graph.find((entry) => entry['@id'] === 'urn:undefineds:xpod:DerivedIndexChangeJournal');
    const override = graph.find((entry) => entry.overrideInstance?.['@id'] === 'urn:solid-server:default:ResourceStore_Backend');
    expect(journal).toMatchObject({ '@type': 'PostgresDerivedIndexJournal' });
    expect(override?.overrideParameters).toMatchObject({
      '@type': 'ObservableResourceStore',
      options_recorders: [{ '@id': 'urn:undefineds:xpod:DerivedIndexChangeJournal' }],
    });
    expect(JSON.stringify(override)).not.toContain('SqliteSolidFsSyncJournal');
  });
});

function event(path: string): ResourceChangeEvent {
  return { path, action: 'update', isContainer: false, timestamp: Date.now() };
}
