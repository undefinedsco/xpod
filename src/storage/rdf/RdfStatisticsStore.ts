export type RdfStatisticsDimensionKind =
  | 'graph'
  | 'predicate'
  | 'subject'
  | 'object'
  | 'source';

export type RdfStatisticsPairKind = 'SP' | 'SO' | 'PS' | 'PO' | 'OS' | 'OP' | 'GP';

export interface RdfStatisticsPodSnapshot {
  podScopeId: string;
  factsVersion: number;
  exactStatsVersion: number;
  plannerStatsVersion?: number;
  plannerDirty: boolean;
  hasUnscopedFacts: boolean;
  quadCount: number;
  graphCount: number;
  predicateCount: number;
  subjectCount: number;
  objectCount: number;
  sourceCount: number;
  exact: boolean;
}

export interface RdfStatisticsDimensionSnapshot {
  quadCount: number;
  distinctLeft: number;
  distinctRight: number;
}

export interface RdfStatisticsPairSnapshot {
  quadCount: number;
}

export interface RdfStatisticsStore {
  podScopeForGraph(graphId: number): Promise<string | undefined>;
  podSnapshot(podScopeId: string): Promise<RdfStatisticsPodSnapshot | undefined>;
  dimension(
    podScopeId: string,
    kind: RdfStatisticsDimensionKind,
    key: number,
  ): Promise<RdfStatisticsDimensionSnapshot | undefined>;
  pair(
    podScopeId: string,
    kind: RdfStatisticsPairKind,
    leftKey: number,
    rightKey: number,
  ): Promise<RdfStatisticsPairSnapshot | undefined>;
}
