import type { PostgresRdfSqlExecutor } from './PostgresRdfSqlExecutor';
import type {
  RdfStatisticsDimensionKind,
  RdfStatisticsDimensionSnapshot,
  RdfStatisticsPairKind,
  RdfStatisticsPairSnapshot,
  RdfStatisticsPodSnapshot,
  RdfStatisticsStore,
} from './RdfStatisticsStore';

interface PodStatisticsRow {
  facts_version: number | string;
  exact_stats_version: number | string;
  planner_stats_version: number | string | null;
  planner_dirty: boolean;
  has_unscoped_facts: boolean;
  quad_count: number | string;
  graph_count: number | string;
  predicate_count: number | string;
  subject_count: number | string;
  object_count: number | string;
  source_count: number | string;
}

interface DimensionStatisticsRow {
  quad_count: number | string;
  distinct_left: number | string;
  distinct_right: number | string;
}

interface PairStatisticsRow {
  quad_count: number | string;
}

export class PostgresRdfStatisticsStore implements RdfStatisticsStore {
  public constructor(private readonly executor: PostgresRdfSqlExecutor) {}

  public async podScopeForGraph(graphId: number): Promise<string | undefined> {
    const rows = await this.executor.query<{ pod_scope_id: string }>(`
      SELECT DISTINCT source.workspace AS pod_scope_id
      FROM rdf_quads quad
      JOIN rdf_sources source ON source.id = quad.source_file_id
      WHERE quad.graph_id = $1
      LIMIT 2
    `, [graphId]);
    return rows.length === 1 ? rows[0]?.pod_scope_id : undefined;
  }

  public async podSnapshot(podScopeId: string): Promise<RdfStatisticsPodSnapshot | undefined> {
    const rows = await this.executor.query<PodStatisticsRow>(`
      SELECT
        version.facts_version,
        version.exact_stats_version,
        version.planner_stats_version,
        version.planner_dirty,
        version.has_unscoped_facts,
        pod.quad_count,
        pod.graph_count,
        pod.predicate_count,
        pod.subject_count,
        pod.object_count,
        pod.source_count
      FROM xpod_rdf.rdf_stats_versions version
      JOIN xpod_rdf.rdf_stats_pod pod USING (pod_scope_id)
      WHERE version.pod_scope_id = $1
    `, [podScopeId]);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    const factsVersion = toNumber(row.facts_version);
    const exactStatsVersion = toNumber(row.exact_stats_version);
    return {
      podScopeId,
      factsVersion,
      exactStatsVersion,
      ...(row.planner_stats_version === null
        ? {}
        : { plannerStatsVersion: toNumber(row.planner_stats_version) }),
      plannerDirty: row.planner_dirty,
      hasUnscopedFacts: row.has_unscoped_facts,
      quadCount: toNumber(row.quad_count),
      graphCount: toNumber(row.graph_count),
      predicateCount: toNumber(row.predicate_count),
      subjectCount: toNumber(row.subject_count),
      objectCount: toNumber(row.object_count),
      sourceCount: toNumber(row.source_count),
      exact: factsVersion === exactStatsVersion && !row.has_unscoped_facts,
    };
  }

  public async dimension(
    podScopeId: string,
    kind: RdfStatisticsDimensionKind,
    key: number,
  ): Promise<RdfStatisticsDimensionSnapshot | undefined> {
    const rows = await this.executor.query<DimensionStatisticsRow>(`
      SELECT dimension.quad_count, dimension.distinct_left, dimension.distinct_right
      FROM xpod_rdf.rdf_stats_dimension dimension
      JOIN xpod_rdf.rdf_stats_versions version USING (pod_scope_id)
      WHERE dimension.pod_scope_id = $1
        AND dimension.dimension_kind = $2
        AND dimension.dimension_key = $3
        AND version.exact_stats_version = version.facts_version
        AND NOT version.has_unscoped_facts
    `, [podScopeId, kind, key]);
    const row = rows[0];
    return row
      ? {
          quadCount: toNumber(row.quad_count),
          distinctLeft: toNumber(row.distinct_left),
          distinctRight: toNumber(row.distinct_right),
        }
      : undefined;
  }

  public async pair(
    podScopeId: string,
    kind: RdfStatisticsPairKind,
    leftKey: number,
    rightKey: number,
  ): Promise<RdfStatisticsPairSnapshot | undefined> {
    const rows = await this.executor.query<PairStatisticsRow>(`
      SELECT pair.quad_count
      FROM xpod_rdf.rdf_stats_pair pair
      JOIN xpod_rdf.rdf_stats_versions version USING (pod_scope_id)
      WHERE pair.pod_scope_id = $1
        AND pair.pair_kind = $2
        AND pair.left_key = $3
        AND pair.right_key = $4
        AND version.exact_stats_version = version.facts_version
        AND NOT version.has_unscoped_facts
    `, [podScopeId, kind.toLowerCase(), leftKey, rightKey]);
    const row = rows[0];
    return row ? { quadCount: toNumber(row.quad_count) } : undefined;
  }
}

function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}
