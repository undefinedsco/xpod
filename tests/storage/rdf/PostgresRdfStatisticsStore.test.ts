import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  PostgresRdfStatisticsStore,
  type PostgresRdfSqlExecutor,
} from '../../../src/storage/rdf';

class RecordingExecutor implements PostgresRdfSqlExecutor {
  public readonly queries: Array<{ sql: string; params: unknown[] }> = [];

  public constructor(private readonly rows: Record<string, unknown>[][]) {}

  public async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.queries.push({ sql, params });
    return (this.rows.shift() ?? []) as T[];
  }

  public async exec(): Promise<void> {}

  public async transaction<T>(fn: (tx: PostgresRdfSqlExecutor) => Promise<T>): Promise<T> {
    return fn(this);
  }

  public async close(): Promise<void> {}
}

describe('PostgresRdfStatisticsStore', () => {
  it('does not retain PostgreSQL-private RDF3X statistics tables or dirty queues', () => {
    const source = readFileSync(path.resolve(__dirname, '../../../src/storage/rdf/PostgresRdfEngine.ts'), 'utf8');

    expect(source).not.toContain('rdf3x_stat_');
    expect(source).not.toContain('rdf3x_dirty_');
    expect(source).not.toContain('rdf3x_metadata');
  });

  it('returns one exact Pod snapshot only when facts and exact versions match', async () => {
    const executor = new RecordingExecutor([[
      {
        facts_version: '12',
        exact_stats_version: '12',
        planner_stats_version: '10',
        planner_dirty: true,
        has_unscoped_facts: false,
        quad_count: '40',
        graph_count: '3',
        predicate_count: '7',
        subject_count: '11',
        object_count: '19',
        source_count: '2',
      },
    ]]);
    const store = new PostgresRdfStatisticsStore(executor);

    await expect(store.podSnapshot('https://pod.example/')).resolves.toEqual({
      podScopeId: 'https://pod.example/',
      factsVersion: 12,
      exactStatsVersion: 12,
      plannerStatsVersion: 10,
      plannerDirty: true,
      hasUnscopedFacts: false,
      quadCount: 40,
      graphCount: 3,
      predicateCount: 7,
      subjectCount: 11,
      objectCount: 19,
      sourceCount: 2,
      exact: true,
    });
    expect(executor.queries[0]?.params).toEqual(['https://pod.example/']);
  });

  it('reads exact single and pair dimensions through one engine-neutral API', async () => {
    const executor = new RecordingExecutor([
      [{ quad_count: '9', distinct_left: '4', distinct_right: '5' }],
      [{ quad_count: '3' }],
    ]);
    const store = new PostgresRdfStatisticsStore(executor);

    await expect(store.dimension('pod-a', 'predicate', 42)).resolves.toEqual({
      quadCount: 9,
      distinctLeft: 4,
      distinctRight: 5,
    });
    await expect(store.pair('pod-a', 'PO', 42, 99)).resolves.toEqual({ quadCount: 3 });
    expect(executor.queries.map(({ params }) => params)).toEqual([
      ['pod-a', 'predicate', 42],
      ['pod-a', 'po', 42, 99],
    ]);
  });

  it('uses shared statistics only when an exact graph belongs to one Pod', async () => {
    const onePod = new PostgresRdfStatisticsStore(new RecordingExecutor([[
      { pod_scope_id: 'pod-a' },
    ]]));
    const ambiguous = new PostgresRdfStatisticsStore(new RecordingExecutor([[
      { pod_scope_id: 'pod-a' },
      { pod_scope_id: 'pod-b' },
    ]]));

    await expect(onePod.podScopeForGraph(42)).resolves.toBe('pod-a');
    await expect(ambiguous.podScopeForGraph(42)).resolves.toBeUndefined();
  });

  it('returns undefined for absent Pod statistics instead of scanning facts itself', async () => {
    const store = new PostgresRdfStatisticsStore(new RecordingExecutor([[], [], [], []]));

    await expect(store.podScopeForGraph(1)).resolves.toBeUndefined();
    await expect(store.podSnapshot('missing')).resolves.toBeUndefined();
    await expect(store.dimension('missing', 'graph', 1)).resolves.toBeUndefined();
    await expect(store.pair('missing', 'SP', 1, 2)).resolves.toBeUndefined();
  });
});
