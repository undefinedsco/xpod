import { describe, expect, it, vi } from 'vitest';
import { RepresentationMetadata } from '@solid/community-server';
import { QuintStoreSparqlDataAccessor } from '../../src/storage/accessors/QuintStoreSparqlDataAccessor';
import { MultiDomainIdentifierStrategy } from '../../src/util/identifiers/MultiDomainIdentifierStrategy';

describe('QuintStoreSparqlDataAccessor host canonicalization', () => {
  it('uses the request host in graph identifiers instead of automatically canonicalizing to the SP host', async () => {
    const accessor = new QuintStoreSparqlDataAccessor(
      {
        open: vi.fn(),
        close: vi.fn(),
        getByGraphPrefix: vi.fn(),
      } as any,
      new MultiDomainIdentifierStrategy(
        'https://node-1.nodes.undefineds.co/',
        ['https://id.undefineds.co/'],
      ) as any,
    );

    const sendSparqlUpdate = vi.fn().mockResolvedValue(undefined);
    (accessor as any).initialize = vi.fn().mockResolvedValue(undefined);
    (accessor as any).sendSparqlUpdate = sendSparqlUpdate;

    await accessor.writeContainer(
      { path: 'https://id.undefineds.co/alice/' },
      new RepresentationMetadata(),
    );

    const update = sendSparqlUpdate.mock.calls[0][0];
    const insertGraphs = update.updates.flatMap((entry: any) => entry.insert ?? []);
    const graphNames = insertGraphs.map((graph: any) => graph.name?.value).filter(Boolean);

    expect(graphNames).toContain('meta:https://id.undefineds.co/alice/');
    expect(graphNames).toContain('https://id.undefineds.co/');
    expect(graphNames).not.toContain('meta:https://node-1.nodes.undefineds.co/alice/');
    expect(graphNames).not.toContain('https://node-1.nodes.undefineds.co/');
  });
});
