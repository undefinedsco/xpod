import { DataFactory, termToId } from 'n3';
import type { Term } from '@rdfjs/types';
import type { QuintPattern, TermMatch } from '../quint/types';
import { isTerm } from '../quint/types';
import { RdfQuadIndex } from './RdfQuadIndex';
import { Rdf3xTripleIndex } from './Rdf3xTripleIndex';
import type { RdfTextIndex } from './RdfTextIndex';
import type { RdfVectorIndex } from './RdfVectorIndex';
import { isFiniteNumericLexical, isRdfNumericTerm, rdfNumericValue } from './RdfTermSemantics';
import type {
  RdfBindExpression,
  RdfBindingRow,
  RdfLocalQuery,
  RdfLocalQueryMetrics,
  RdfLocalQueryResult,
  RdfQueryBind,
  RdfQueryAggregate,
  RdfQueryFilter,
  RdfQueryFilterValue,
  RdfOptionalQueryGroup,
  RdfQueryPattern,
  RdfQueryPatternKey,
  RdfQueryTermPattern,
  RdfQuadTupleConstraintSource,
  RdfValuesBindingSource,
  RdfTextSearchPattern,
  RdfTextSearchOptions,
  RdfTextSearchResult,
  RdfUnionQueryBranch,
  RdfVectorSearchPattern,
  RdfVectorSearchOptions,
  RdfVectorSearchResult,
  RdfMinusQueryGroup,
  RdfExistsQueryGroup,
  RdfQueryVariable,
  RdfQuadJoinGroupAggregateHaving,
  RdfQuadIndexScanResult,
  RdfQuadScanOptions,
  Rdf3xPatternKey,
  Rdf3xTriplePattern,
  Rdf3xTripleScanOptions,
  Rdf3xTripleScanResult,
} from './types';

const TERM_KEYS: RdfQueryPatternKey[] = ['graph', 'subject', 'predicate', 'object'];
const PLANNER_SAMPLE_BINDINGS = 16;
const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

interface SingleScanPushdown {
  options: RdfQuadScanOptions;
  orderPushed: boolean;
  paginationPushed: boolean;
}

type CompiledPattern = QuintPattern & {
  pushedDownFilters: number;
  pushedDownFilterIndexes: number[];
};

type CompiledJoinPattern = { pattern: CompiledPattern; variables: Partial<Record<RdfQueryPatternKey, string>> };

interface RequiredBgpPushdown {
  patterns: CompiledJoinPattern[];
  values?: RdfValuesBindingSource[];
  reorderPlan?: string;
  orderPushed: boolean;
  paginationPushed: boolean;
  distinctPushed: boolean;
  project?: string[];
  pushedDownFilters: number;
}

interface GroupAggregatePushdown {
  patterns: CompiledJoinPattern[];
  reorderPlan?: string;
  having?: RdfQuadJoinGroupAggregateHaving[];
  pushedDownFilters: number;
  pushedDownHaving: number;
  orderPushed: boolean;
  paginationPushed: boolean;
  countOnly: boolean;
}

interface JoinCountPushdown {
  patterns: CompiledJoinPattern[];
  reorderPlan?: string;
  pushedDownFilters: number;
}

interface JoinBasicAggregatePushdown {
  patterns: CompiledJoinPattern[];
  reorderPlan?: string;
  pushedDownFilters: number;
}

interface PatternRequiredSource {
  kind: 'pattern';
  pattern: RdfQueryPattern;
  originalIndex: number;
  tupleValues?: RdfValuesBindingSource;
}

interface TextRequiredSource {
  kind: 'text';
  pattern: RdfTextSearchPattern;
  originalIndex: number;
  results?: RdfTextSearchResult[];
}

interface VectorRequiredSource {
  kind: 'vector';
  pattern: RdfVectorSearchPattern;
  originalIndex: number;
  results?: RdfVectorSearchResult[];
}

interface ValuesRequiredSource {
  kind: 'values';
  source: RdfValuesBindingSource;
  originalIndex: number;
}

type RequiredSource = PatternRequiredSource | TextRequiredSource | VectorRequiredSource | ValuesRequiredSource;
type PatternScanBackend = 'index' | 'rdf3x' | 'mixed' | 'none';

interface PatternJoinResult {
  bindings: RdfBindingRow[];
  scanBackend: PatternScanBackend;
}

export class RdfLocalQueryEngine {
  public constructor(
    private readonly index: RdfQuadIndex,
    private readonly textIndex?: RdfTextIndex,
    private readonly vectorIndex?: RdfVectorIndex,
    private readonly rdf3xPrimaryIndex?: Rdf3xTripleIndex,
  ) {}

  public query(query: RdfLocalQuery): RdfLocalQueryResult {
    const start = Date.now();
    const metrics: RdfLocalQueryMetrics = {
      engine: 'solid-rdf',
      plan: [],
      scannedRows: 0,
      joinedRows: 0,
      returnedRows: 0,
      durationMs: 0,
      indexChoices: [],
      cardinalityEstimates: 0,
      distinctCardinalityEstimates: 0,
      searchCardinalityEstimates: 0,
      filtersApplied: 0,
      filtersPushedDown: 0,
    };

    const hasNonPatternSource = (query.values?.length ?? 0) > 0
      || (query.textSearch?.length ?? 0) > 0
      || (query.vectorSearch?.length ?? 0) > 0;
    const requiredPatterns = query.patterns.length > 0
      ? query.patterns
      : query.unions?.length || hasNonPatternSource
      ? []
      : [{}];
    let bindings: RdfBindingRow[] = [{}];
    const requiredFilters = query.filters ?? [];
    const aggregates = queryAggregates(query);
    const singleScanPushdown = this.singleScanPushdown(query, requiredPatterns, requiredFilters);
    const countPushdown = this.countPushdown(query, requiredPatterns, requiredFilters);
    const groupAggregatePushdown = this.groupAggregatePushdown(query, requiredPatterns, requiredFilters, aggregates);
    const joinCountPushdown = this.joinCountPushdown(query, requiredPatterns, requiredFilters, aggregates);
    const joinBasicAggregatePushdown = this.joinBasicAggregatePushdown(query, requiredPatterns, requiredFilters, aggregates);
    let groupedAggregatePushed = false;

    if (countPushdown) {
      const useRdf3xPrimary = this.canUseRdf3xPrimaryScan(countPushdown.pattern);
      let rdf3xCount: ReturnType<Rdf3xTripleIndex['countDistinct']> | undefined;
      if (useRdf3xPrimary) {
        const rdf3xPattern = toRdf3xTriplePattern(countPushdown.pattern);
        if (countPushdown.distinctKey) {
          rdf3xCount = this.rdf3xPrimaryIndex!.countDistinct(
            rdf3xPattern,
            countPushdown.distinctKey as Rdf3xPatternKey,
          );
        } else {
          const rdf3xCountScan = this.rdf3xPrimaryIndex!.scan(rdf3xPattern, { limit: 0 });
          rdf3xCount = {
            count: rdf3xCountScan.metrics.matchedRows,
            metrics: rdf3xCountScan.metrics,
          };
        }
      }
      const countEstimate = !useRdf3xPrimary && countPushdown.distinctKey
        ? this.index.countDistinct(countPushdown.pattern, countPushdown.distinctKey)
        : undefined;
      const count = rdf3xCount?.count ?? countEstimate?.rows ?? this.index.count(countPushdown.pattern);
      const result = countLiteral(count);
      metrics.scannedRows = count;
      metrics.joinedRows = count;
      metrics.returnedRows = 1;
      metrics.durationMs = Date.now() - start;
      metrics.indexChoices.push(useRdf3xPrimary ? rdf3xCount!.metrics.indexChoice : 'count');
      metrics.filtersPushedDown += countPushdown.pushedDownFilters;
      if (rdf3xCount) {
        metrics.plan.push(...storagePlanMarkers(rdf3xCount.metrics.queryPlan));
        metrics.plan.push(`${countPushdown.distinctKey ? 'Rdf3xPrimaryCountDistinct' : 'Rdf3xPrimaryCount'}(${describePattern(requiredPatterns[0])})`);
        metrics.plan.push(countPushdown.distinctKey ? 'Aggregate(count-distinct-rdf3x-primary)' : 'Aggregate(count-rdf3x-primary)');
      } else {
        metrics.plan.push(`IndexCount(${describePattern(requiredPatterns[0])})`);
        metrics.plan.push(countPushdown.distinctKey ? 'Aggregate(count-distinct-index)' : 'Aggregate(count-index)');
      }
      return {
        bindings: [{ [countPushdown.as]: result }],
        count,
        metrics,
      };
    }

    if (joinCountPushdown) {
      const useRdf3xPrimary = this.canUseRdf3xPrimaryJoin(joinCountPushdown.patterns);
      const scan = useRdf3xPrimary
        ? this.rdf3xPrimaryIndex!.countJoinPatterns(joinCountPushdown.patterns, {
          aggregates,
        })
        : this.index.countJoinPatterns(joinCountPushdown.patterns, {
        aggregates,
      });
      const firstAggregate = aggregates[0];
      const firstCount = firstAggregate ? Number(scan.bindings[0]?.[firstAggregate.as]?.value ?? 0) : 0;
      metrics.scannedRows = scan.metrics.matchedRows;
      metrics.joinedRows = scan.metrics.matchedRows;
      metrics.returnedRows = scan.bindings.length;
      metrics.durationMs = Date.now() - start;
      metrics.indexChoices.push(scan.metrics.indexChoice);
      metrics.filtersPushedDown += joinCountPushdown.pushedDownFilters;
      if (!useRdf3xPrimary && joinCountPushdown.reorderPlan) {
        metrics.plan.push(joinCountPushdown.reorderPlan);
      }
      metrics.plan.push(...storagePlanMarkers(scan.metrics.queryPlan));
      metrics.plan.push(`${useRdf3xPrimary ? 'Rdf3xPrimaryJoinCount' : 'IndexJoinCount'}(${joinCountPushdown.patterns.map((source) => describePatternSource(source)).join('|')})`);
      metrics.plan.push(aggregatePlan(aggregates, false));
      metrics.plan.push(aggregates.some((aggregate) => aggregate.distinct)
        ? 'Aggregate(join-count-distinct-index)'
        : 'Aggregate(join-count-index)');
      return {
        bindings: scan.bindings,
        count: firstCount,
        metrics,
      };
    }

    if (joinBasicAggregatePushdown) {
      const useRdf3xPrimary = this.canUseRdf3xPrimaryJoin(joinBasicAggregatePushdown.patterns);
      const scan = useRdf3xPrimary
        ? this.rdf3xPrimaryIndex!.aggregateJoinPatterns(joinBasicAggregatePushdown.patterns, {
          aggregates,
        })
        : this.index.aggregateJoinPatterns(joinBasicAggregatePushdown.patterns, {
        aggregates,
      });
      metrics.scannedRows = scan.metrics.matchedRows;
      metrics.joinedRows = scan.metrics.matchedRows;
      metrics.returnedRows = scan.bindings.length;
      metrics.durationMs = Date.now() - start;
      metrics.indexChoices.push(scan.metrics.indexChoice);
      metrics.filtersPushedDown += joinBasicAggregatePushdown.pushedDownFilters;
      if (!useRdf3xPrimary && joinBasicAggregatePushdown.reorderPlan) {
        metrics.plan.push(joinBasicAggregatePushdown.reorderPlan);
      }
      metrics.plan.push(...storagePlanMarkers(scan.metrics.queryPlan));
      metrics.plan.push(`${useRdf3xPrimary ? 'Rdf3xPrimaryJoinAggregate' : 'IndexJoinAggregate'}(${joinBasicAggregatePushdown.patterns.map((source) => describePatternSource(source)).join('|')})`);
      metrics.plan.push(aggregatePlan(aggregates, false));
      metrics.plan.push(aggregates.length > 1
        ? 'Aggregate(join-basic-multi-index)'
        : 'Aggregate(join-basic-index)');
      return {
        bindings: scan.bindings,
        metrics,
      };
    }

    const remainingSources = buildRequiredSources(requiredPatterns, query);
    const requiredBgpPushdown = this.requiredBgpPushdown(query, requiredPatterns, requiredFilters);
    if (groupAggregatePushdown) {
      const rdf3xGroupAggregatePatterns = groupAggregatePushdown.countOnly
        ? groupAggregatePushdown.patterns
        : stripRdf3xNumericAggregateGuards(groupAggregatePushdown.patterns, aggregates);
      const useRdf3xPrimary = this.canUseRdf3xPrimaryJoin(rdf3xGroupAggregatePatterns);
      const groupOptions = {
        groupBy: query.groupBy ?? [],
        aggregates,
        ...(groupAggregatePushdown.having ? { having: groupAggregatePushdown.having } : {}),
        ...(groupAggregatePushdown.orderPushed ? { orderBy: query.orderBy } : {}),
        ...(groupAggregatePushdown.paginationPushed && query.limit !== undefined ? { limit: Math.max(0, query.limit) } : {}),
        ...(groupAggregatePushdown.paginationPushed && query.offset !== undefined ? { offset: Math.max(0, query.offset) } : {}),
      };
      const scan = groupAggregatePushdown.countOnly
        ? useRdf3xPrimary
          ? this.rdf3xPrimaryIndex!.groupCountJoinPatterns(rdf3xGroupAggregatePatterns, groupOptions)
          : this.index.groupCountJoinPatterns(groupAggregatePushdown.patterns, groupOptions)
        : useRdf3xPrimary
          ? this.rdf3xPrimaryIndex!.groupAggregateJoinPatterns(rdf3xGroupAggregatePatterns, groupOptions)
          : this.index.groupAggregateJoinPatterns(groupAggregatePushdown.patterns, groupOptions);
      const groupPlanPrefix = useRdf3xPrimary
        ? groupAggregatePushdown.countOnly ? 'Rdf3xPrimaryGroupCount' : 'Rdf3xPrimaryGroupAggregate'
        : groupAggregatePushdown.countOnly ? 'IndexGroupCount' : 'IndexGroupAggregate';
      bindings = scan.bindings;
      metrics.scannedRows += scan.metrics.matchedRows;
      metrics.joinedRows = scan.metrics.matchedRows;
      metrics.indexChoices.push(scan.metrics.indexChoice);
      metrics.filtersPushedDown += groupAggregatePushdown.pushedDownFilters;
      metrics.filtersPushedDown += groupAggregatePushdown.pushedDownHaving;
      if (!useRdf3xPrimary && groupAggregatePushdown.reorderPlan) {
        metrics.plan.push(groupAggregatePushdown.reorderPlan);
      }
      metrics.plan.push(...storagePlanMarkers(scan.metrics.queryPlan));
      metrics.plan.push(`${groupPlanPrefix}(${(query.groupBy ?? []).map((variableName) => `?${variableName}`).join(',')})`);
      if (groupAggregatePushdown.pushedDownHaving > 0) {
        metrics.plan.push(`${groupPlanPrefix}Having(${(query.having ?? []).map(describeFilter).join(',')})`);
      }
      if (groupAggregatePushdown.orderPushed) {
        metrics.plan.push(`${groupPlanPrefix}Order(${describeQueryOrder(query.orderBy ?? [])})`);
      }
      if (groupAggregatePushdown.paginationPushed) {
        metrics.plan.push(`${groupPlanPrefix}Limit`);
      }
      metrics.plan.push(aggregatePlan(aggregates, true));
      metrics.plan.push(groupAggregatePushdown.countOnly
        ? 'Aggregate(group-count-index)'
        : aggregates.length > 1
          ? 'Aggregate(group-basic-multi-index)'
          : 'Aggregate(group-basic-index)');
      remainingSources.splice(0, remainingSources.length);
      groupedAggregatePushed = true;
    } else if (requiredBgpPushdown) {
      const useRdf3xPrimary = this.canUseRdf3xPrimaryJoin(requiredBgpPushdown.patterns);
      const scanOptions = {
        ...(requiredBgpPushdown.project ? { project: requiredBgpPushdown.project } : {}),
        ...(requiredBgpPushdown.distinctPushed ? { distinct: true } : {}),
        ...(requiredBgpPushdown.values ? { values: requiredBgpPushdown.values } : {}),
        ...(requiredBgpPushdown.orderPushed ? { orderBy: query.orderBy } : {}),
        ...(requiredBgpPushdown.paginationPushed && query.limit !== undefined ? { limit: Math.max(0, query.limit) } : {}),
        ...(requiredBgpPushdown.paginationPushed && query.offset !== undefined ? { offset: Math.max(0, query.offset) } : {}),
        ...(requiredBgpPushdown.paginationPushed ? { countMatchedRows: false } : {}),
      };
      const scan = useRdf3xPrimary
        ? this.rdf3xPrimaryIndex!.joinPatterns(requiredBgpPushdown.patterns, scanOptions)
        : this.index.joinPatterns(requiredBgpPushdown.patterns, scanOptions);
      bindings = scan.bindings;
      metrics.scannedRows += scan.metrics.matchedRows;
      metrics.indexChoices.push(scan.metrics.indexChoice);
      metrics.filtersPushedDown += requiredBgpPushdown.pushedDownFilters;
      if (!useRdf3xPrimary && requiredBgpPushdown.reorderPlan) {
        metrics.plan.push(requiredBgpPushdown.reorderPlan);
      }
      metrics.plan.push(...storagePlanMarkers(scan.metrics.queryPlan));
      metrics.plan.push(`${useRdf3xPrimary ? 'Rdf3xPrimaryJoin' : 'IndexJoin'}(${requiredBgpPushdown.patterns.map((source) => describePatternSource(source)).join('|')})`);
      if (requiredBgpPushdown.orderPushed) {
        metrics.plan.push(`${useRdf3xPrimary ? 'Rdf3xPrimaryJoinOrder' : 'IndexJoinOrder'}(${describeQueryOrder(query.orderBy ?? [])})`);
      }
      if (requiredBgpPushdown.distinctPushed) {
        metrics.plan.push(`${useRdf3xPrimary ? 'Rdf3xPrimaryJoinDistinct' : 'IndexJoinDistinct'}(${(requiredBgpPushdown.project ?? []).map((variableName) => `?${variableName}`).join(',')})`);
      }
      if (requiredBgpPushdown.paginationPushed) {
        metrics.plan.push(useRdf3xPrimary ? 'Rdf3xPrimaryJoinLimit' : 'IndexJoinLimit');
      }
      remainingSources.splice(0, remainingSources.length);
    }

    while (remainingSources.length > 0) {
      const sourceIndex = this.chooseRequiredSourceIndex(remainingSources, bindings, requiredFilters, metrics);
      const [source] = remainingSources.splice(sourceIndex, 1);
      bindings = this.joinRequiredSource(
        bindings,
        source,
        requiredFilters,
        metrics,
        singleScanPushdown,
      );
      if (bindings.length === 0) {
        break;
      }
    }

    if ((query.binds?.length ?? 0) > 0) {
      bindings = this.applyBinds(bindings, query.binds ?? []);
      metrics.plan.push(`Bind(${(query.binds ?? []).map(describeBind).join(',')})`);
    }

    for (const rawOptionalGroup of query.optional ?? []) {
      const optionalGroup = normalizeOptionalGroup(rawOptionalGroup);
      bindings = this.joinOptionalGroup(bindings, optionalGroup, metrics);
      metrics.plan.push(`OptionalJoin(${optionalGroup.patterns.map(describePattern).join(',')})`);
    }

    for (const unionGroup of query.unions ?? []) {
      bindings = this.joinUnionGroup(bindings, unionGroup.branches, requiredFilters, metrics);
      metrics.plan.push(`Union(${unionGroup.branches.map((branch) => branch.patterns.map(describePattern).join(',')).join('|')})`);
      if (bindings.length === 0) {
        break;
      }
    }

    for (const minusGroup of query.minus ?? []) {
      bindings = this.applyMinusGroup(bindings, minusGroup, metrics);
      metrics.plan.push(`Minus(${minusGroup.patterns.map(describePattern).join(',')})`);
      if (bindings.length === 0) {
        break;
      }
    }

    for (const existsGroup of query.exists ?? []) {
      bindings = this.applyExistsGroup(bindings, existsGroup, metrics);
      metrics.plan.push(`Exists(${existsGroup.patterns.map(describePattern).join(',')})`);
      if (bindings.length === 0) {
        break;
      }
    }

    const postRequiredFilters = this.requiredFiltersNeedingPostApply(
      query,
      requiredPatterns,
      requiredFilters,
      requiredBgpPushdown,
    );
    if (postRequiredFilters.length > 0 && !groupedAggregatePushed) {
      bindings = bindings.filter((binding) => this.matchesFilters(binding, postRequiredFilters));
      metrics.filtersApplied += postRequiredFilters.length;
      metrics.plan.push(`Filter(${postRequiredFilters.map(describeFilter).join(',')})`);
    }

    if (groupedAggregatePushed && groupAggregatePushdown) {
      if ((query.having?.length ?? 0) > groupAggregatePushdown.pushedDownHaving) {
        bindings = bindings.filter((binding) => this.matchesFilters(binding, query.having ?? []));
        metrics.filtersApplied += query.having?.length ?? 0;
        metrics.plan.push(`Having(${(query.having ?? []).map(describeFilter).join(',')})`);
      }
    } else if (aggregates.length > 0 && (query.groupBy?.length ?? 0) > 0) {
      const joinedRows = bindings.length;
      bindings = this.groupAggregateBindings(bindings, query.groupBy ?? [], aggregates);
      metrics.joinedRows = joinedRows;
      metrics.plan.push(aggregatePlan(aggregates, true));
      if ((query.having?.length ?? 0) > 0) {
        bindings = bindings.filter((binding) => this.matchesFilters(binding, query.having ?? []));
        metrics.filtersApplied += query.having?.length ?? 0;
        metrics.plan.push(`Having(${(query.having ?? []).map(describeFilter).join(',')})`);
      }
    } else if (aggregates.length > 0) {
      const { binding: aggregateBinding, firstCount } = this.aggregateBindings(bindings, aggregates);
      const having = query.having ?? [];
      if (having.length > 0 && !this.matchesFilters(aggregateBinding, having)) {
        metrics.joinedRows = bindings.length;
        metrics.returnedRows = 0;
        metrics.durationMs = Date.now() - start;
        metrics.filtersApplied += having.length;
        metrics.plan.push(aggregatePlan(aggregates, false));
        metrics.plan.push(`Having(${having.map(describeFilter).join(',')})`);
        return {
          bindings: [],
          count: firstCount,
          metrics,
        };
      }
      metrics.joinedRows = bindings.length;
      metrics.returnedRows = 1;
      metrics.durationMs = Date.now() - start;
      metrics.plan.push(aggregatePlan(aggregates, false));
      if (having.length > 0) {
        metrics.filtersApplied += having.length;
        metrics.plan.push(`Having(${having.map(describeFilter).join(',')})`);
      }
      return {
        bindings: [aggregateBinding],
        count: firstCount,
        metrics,
      };
    }

    const joinedRows = metrics.joinedRows > 0
      ? metrics.joinedRows
      : singleScanPushdown?.paginationPushed
        || requiredBgpPushdown?.paginationPushed
      ? metrics.scannedRows
      : bindings.length;

    if (
      query.orderBy
      && query.orderBy.length > 0
      && !singleScanPushdown?.orderPushed
      && !requiredBgpPushdown?.orderPushed
      && !groupAggregatePushdown?.orderPushed
    ) {
      bindings = [...bindings].sort((left, right) => compareBindings(left, right, query.orderBy ?? []));
      metrics.plan.push('Sort');
    }

    let projected = query.select && query.select.length > 0
      ? bindings.map((binding) => projectBinding(binding, query.select ?? []))
      : bindings;

    if (query.distinct && !requiredBgpPushdown?.distinctPushed) {
      projected = distinctBindings(projected);
      metrics.plan.push('Distinct');
    }

    if (
      (query.offset !== undefined || query.limit !== undefined)
      && !singleScanPushdown?.paginationPushed
      && !requiredBgpPushdown?.paginationPushed
      && !groupAggregatePushdown?.paginationPushed
    ) {
      const startOffset = Math.max(0, query.offset ?? 0);
      const endOffset = query.limit === undefined
        ? undefined
        : startOffset + Math.max(0, query.limit);
      projected = projected.slice(startOffset, endOffset);
      metrics.plan.push('Limit');
    }

    metrics.joinedRows = joinedRows;
    metrics.returnedRows = projected.length;
    metrics.durationMs = Date.now() - start;
    return {
      bindings: projected,
      metrics,
    };
  }

  private chooseRequiredSourceIndex(
    sources: RequiredSource[],
    bindings: RdfBindingRow[],
    filters: RdfQueryFilter[],
    metrics: RdfLocalQueryMetrics,
  ): number {
    const boundVariables = this.boundVariables(bindings);
    const hasBoundVariables = boundVariables.size > 0;
    const sampleBinding = bindings[0] ?? {};
    const choices = sources.map((source, index) => {
      const sourceVariables = variablesInRequiredSource(source);
      const connected = sourceVariables.length === 0
        || sourceVariables.some((variableName) => boundVariables.has(variableName));
      return {
        index,
        disconnectedPenalty: hasBoundVariables && !connected ? 1 : 0,
        estimatedRows: this.estimateSourceRows(source, bindings, filters, metrics),
        rank: this.sourceRank(source, sampleBinding),
      };
    });

    choices.sort((left, right) => (
      left.disconnectedPenalty - right.disconnectedPenalty
        || left.estimatedRows - right.estimatedRows
        || left.rank - right.rank
        || left.index - right.index
    ));
    return choices[0]?.index ?? 0;
  }

  private estimatePatternRows(
    pattern: RdfQueryPattern,
    bindings: RdfBindingRow[],
    filters: RdfQueryFilter[],
    metrics: RdfLocalQueryMetrics,
  ): number {
    const sample = (bindings.length > 0 ? bindings : [{}]).slice(0, PLANNER_SAMPLE_BINDINGS);
    const fanoutEstimate = this.estimatePatternRowsByDistinctFanout(pattern, sample, filters, metrics);
    if (fanoutEstimate !== undefined) {
      if (bindings.length > sample.length && sample.length > 0) {
        return Math.ceil(fanoutEstimate * (bindings.length / sample.length));
      }
      return fanoutEstimate;
    }

    const estimates = new Map<string, number>();
    for (const binding of sample) {
      const compiled = this.compilePattern(pattern, binding, filters);
      if (!compiled) {
        continue;
      }
      metrics.cardinalityEstimates = (metrics.cardinalityEstimates ?? 0) + 1;
      const key = compiledPatternKey(compiled);
      if (!estimates.has(key)) {
        estimates.set(key, this.index.estimateCardinality(compiled).rows);
        metrics.distinctCardinalityEstimates = (metrics.distinctCardinalityEstimates ?? 0) + 1;
      }
    }
    const rows = sample.reduce((sum, binding) => {
      const compiled = this.compilePattern(pattern, binding, filters);
      return compiled ? sum + (estimates.get(compiledPatternKey(compiled)) ?? 0) : sum;
    }, 0);
    if (bindings.length > sample.length && sample.length > 0) {
      return Math.ceil(rows * (bindings.length / sample.length));
    }
    return rows;
  }

  private estimatePatternRowsByDistinctFanout(
    pattern: RdfQueryPattern,
    sample: RdfBindingRow[],
    filters: RdfQueryFilter[],
    metrics: RdfLocalQueryMetrics,
  ): number | undefined {
    if (sample.length < 2) {
      return undefined;
    }
    const boundSlots = this.boundPatternSlots(pattern, sample);
    if (boundSlots.length === 0) {
      return undefined;
    }
    const boundVariables = new Set(boundSlots.map((slot) => slot.variable));
    if (filters.some((filter) => boundVariables.has(filter.variable))) {
      return undefined;
    }

    const generalized = this.compilePattern(pattern, {}, filters);
    if (!generalized) {
      return undefined;
    }

    const total = this.index.estimateCardinality(generalized).rows;
    const distinct = this.index.countDistinctTuple(generalized, boundSlots.map((slot) => slot.key)).rows;
    metrics.cardinalityEstimates = (metrics.cardinalityEstimates ?? 0) + sample.length;
    metrics.distinctCardinalityEstimates = (metrics.distinctCardinalityEstimates ?? 0) + 2;
    if (distinct === 0 || total === 0) {
      return 0;
    }
    return Math.ceil((total / distinct) * sample.length);
  }

  private boundPatternSlots(
    pattern: RdfQueryPattern,
    sample: RdfBindingRow[],
  ): Array<{ key: RdfQueryPatternKey; variable: string }> {
    return TERM_KEYS
      .map((key) => ({ key, value: pattern[key] }))
      .filter((slot): slot is { key: RdfQueryPatternKey; value: RdfQueryVariable } => {
        if (!isVariable(slot.value)) {
          return false;
        }
        const variableName = slot.value.variable;
        return sample.every((binding) => Boolean(binding[variableName]));
      })
      .map((slot) => ({ key: slot.key, variable: slot.value.variable }));
  }

  private estimateSourceRows(
    source: RequiredSource,
    bindings: RdfBindingRow[],
    filters: RdfQueryFilter[],
    metrics: RdfLocalQueryMetrics,
  ): number {
    if (source.kind === 'pattern') {
      if (source.tupleValues) {
        return this.estimateTuplePatternRows(source, bindings, filters, metrics);
      }
      return this.estimatePatternRows(source.pattern, bindings, filters, metrics);
    }
    if (source.kind === 'values') {
      return source.source.rows.length * Math.max(1, bindings.length);
    }

    const sample = (bindings.length > 0 ? bindings : [{}]).slice(0, PLANNER_SAMPLE_BINDINGS);
    if (!this.searchSourceHasBoundVariables(source, sample)) {
      metrics.searchCardinalityEstimates = (metrics.searchCardinalityEstimates ?? 0) + 1;
      const estimate = source.kind === 'text'
        ? this.estimateTextSearchRows(source)
        : this.estimateVectorSearchRows(source);
      return estimate * Math.max(1, bindings.length);
    }

    const sourceVariable = source.pattern.source;
    const boundSourceEstimate = sourceVariable && this.canUseBoundSourceSearch(sample, source, sourceVariable)
      ? this.estimateSearchRowsByBoundSource(source, sample, metrics)
      : undefined;
    if (boundSourceEstimate !== undefined) {
      if (bindings.length > sample.length && sample.length > 0) {
        return Math.ceil(boundSourceEstimate * (bindings.length / sample.length));
      }
      return boundSourceEstimate;
    }

    const results = source.kind === 'text'
      ? this.textSearchResults(source)
      : this.vectorSearchResults(source);
    let rows = 0;

    for (const binding of sample) {
      for (const result of results) {
        const next = source.kind === 'text'
          ? bindTextSearchResult(binding, source.pattern, result as RdfTextSearchResult)
          : bindVectorSearchResult(binding, source.pattern, result as RdfVectorSearchResult);
        if (next) {
          rows++;
        }
      }
    }

    if (bindings.length > sample.length && sample.length > 0) {
      return Math.ceil(rows * (bindings.length / sample.length));
    }
    return rows;
  }

  private estimateTuplePatternRows(
    source: PatternRequiredSource,
    bindings: RdfBindingRow[],
    filters: RdfQueryFilter[],
    metrics: RdfLocalQueryMetrics,
  ): number {
    const sample = (bindings.length > 0 ? bindings : [{}]).slice(0, PLANNER_SAMPLE_BINDINGS);
    const estimates = new Map<string, number>();
    let rows = 0;

    for (const binding of sample) {
      for (const row of source.tupleValues?.rows ?? []) {
        const tupleBinding = mergeTupleValuesBinding(binding, source.tupleValues?.variables ?? [], row);
        if (!tupleBinding) {
          continue;
        }
        const compiled = this.compilePattern(source.pattern, tupleBinding, filters);
        if (!compiled) {
          continue;
        }
        metrics.cardinalityEstimates = (metrics.cardinalityEstimates ?? 0) + 1;
        const key = compiledPatternKey(compiled);
        if (!estimates.has(key)) {
          estimates.set(key, this.index.estimateCardinality(compiled).rows);
          metrics.distinctCardinalityEstimates = (metrics.distinctCardinalityEstimates ?? 0) + 1;
        }
        rows += estimates.get(key) ?? 0;
      }
    }

    if (bindings.length > sample.length && sample.length > 0) {
      return Math.ceil(rows * (bindings.length / sample.length));
    }
    return rows;
  }

  private searchSourceHasBoundVariables(
    source: TextRequiredSource | VectorRequiredSource,
    sample: RdfBindingRow[],
  ): boolean {
    const variables = variablesInRequiredSource(source);
    return variables.some((variableName) => sample.some((binding) => Boolean(binding[variableName])));
  }

  private estimateSearchRowsByBoundSource(
    source: TextRequiredSource | VectorRequiredSource,
    sample: RdfBindingRow[],
    metrics: RdfLocalQueryMetrics,
  ): number | undefined {
    const sourceVariable = source.pattern.source;
    if (!sourceVariable) {
      return undefined;
    }

    const estimates = new Map<string, number>();
    let rows = 0;
    let sawBoundSource = false;
    for (const binding of sample) {
      const term = binding[sourceVariable];
      if (!term) {
        return undefined;
      }

      sawBoundSource = true;
      if (term.termType !== 'NamedNode') {
        continue;
      }

      if (!estimates.has(term.value)) {
        metrics.searchCardinalityEstimates = (metrics.searchCardinalityEstimates ?? 0) + 1;
        estimates.set(term.value, source.kind === 'text'
          ? this.estimateTextSearchRows(source, term.value)
          : this.estimateVectorSearchRows(source, term.value));
      }
      rows += estimates.get(term.value) ?? 0;
    }

    return sawBoundSource ? rows : undefined;
  }

  private estimateTextSearchRows(source: TextRequiredSource, exactSource?: string): number {
    if (!this.textIndex) {
      throw new Error('RdfLocalQuery textSearch requires a configured RdfTextIndex');
    }
    const options = this.textSearchOptions(source.pattern, exactSource);
    return options ? this.textIndex.estimateSearchCardinality(options).rows : 0;
  }

  private estimateVectorSearchRows(source: VectorRequiredSource, exactSource?: string): number {
    if (!this.vectorIndex) {
      throw new Error('RdfLocalQuery vectorSearch requires a configured RdfVectorIndex');
    }
    const options = this.vectorSearchOptions(source.pattern, exactSource);
    return options ? this.vectorIndex.estimateSearchCardinality(options).rows : 0;
  }

  private boundVariables(bindings: RdfBindingRow[]): Set<string> {
    const names = new Set<string>();
    for (const binding of bindings.slice(0, PLANNER_SAMPLE_BINDINGS)) {
      for (const name of Object.keys(binding)) {
        names.add(name);
      }
    }
    return names;
  }

  private patternRank(pattern: RdfQueryPattern, binding: RdfBindingRow): number {
    let rank = 0;
    for (const key of TERM_KEYS) {
      const value = pattern[key];
      if (!value) continue;
      if (isVariable(value)) {
        if (binding[value.variable]) {
          rank += key === 'graph' ? 0 : 1;
        } else {
          rank += 8;
        }
      } else {
        rank += key === 'graph' ? 0 : 1;
      }
    }
    return rank;
  }

  private sourceRank(source: RequiredSource, binding: RdfBindingRow): number {
    if (source.kind === 'pattern') {
      return this.patternRank(source.pattern, binding);
    }
    if (source.kind === 'values') {
      return 0;
    }

    const variables = variablesInRequiredSource(source);
    if (variables.some((variableName) => binding[variableName])) {
      return 0;
    }
    return source.kind === 'text' ? 4 : 5;
  }

  private joinRequiredSource(
    input: RdfBindingRow[],
    source: RequiredSource,
    filters: RdfQueryFilter[],
    metrics: RdfLocalQueryMetrics,
    singleScanPushdown?: SingleScanPushdown,
  ): RdfBindingRow[] {
    switch (source.kind) {
      case 'pattern': {
        const result = this.joinPattern(
          input,
          source,
          filters,
          metrics,
          false,
          singleScanPushdown?.options,
        );
        const scanPlan = requiredSourceScanPlan(result.scanBackend);
        metrics.plan.push(`${scanPlan}(${describePattern(source.pattern)})`);
        if (singleScanPushdown?.orderPushed) {
          metrics.plan.push(`${scanPlanOrder(scanPlan)}(${describeScanOrder(singleScanPushdown.options)})`);
        }
        if (singleScanPushdown?.paginationPushed) {
          metrics.plan.push(scanPlanLimit(scanPlan));
        }
        return result.bindings;
      }
      case 'text': {
        const bindings = this.joinTextSearch(input, source, metrics);
        metrics.plan.push(`TextSearch(${describeTextSearch(source.pattern)})`);
        return bindings;
      }
      case 'vector': {
        const bindings = this.joinVectorSearch(input, source, metrics);
        metrics.plan.push(`VectorSearch(${describeVectorSearch(source.pattern)})`);
        return bindings;
      }
      case 'values': {
        const bindings = joinValuesSource(input, source.source);
        metrics.scannedRows += source.source.rows.length;
        metrics.plan.push(`Values(${source.source.variables.map((variableName) => `?${variableName}`).join(',')})`);
        return bindings;
      }
      default: {
        const exhaustive: never = source;
        throw new Error(`Unsupported RDF required source: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private joinOptionalGroup(
    input: RdfBindingRow[],
    optionalGroup: RdfOptionalQueryGroup,
    metrics: RdfLocalQueryMetrics,
  ): RdfBindingRow[] {
    const optionalFilters = optionalGroup.filters ?? [];
    if (optionalFilters.length > 0) {
      metrics.plan.push(`OptionalFilter(${optionalFilters.map(describeFilter).join(',')})`);
    }
    return input.flatMap((binding) => {
      let matches: RdfBindingRow[] = [binding];
      for (const source of optionalGroup.values ?? []) {
        matches = joinValuesSource(matches, source);
        metrics.scannedRows += source.rows.length;
        metrics.plan.push(`OptionalValues(${source.variables.map((variableName) => `?${variableName}`).join(',')})`);
        if (matches.length === 0) {
          return [binding];
        }
      }
      const grouped = (optionalGroup.values?.length ?? 0) === 0
        ? this.joinPatternGroupRdf3x(matches, optionalGroup.patterns, optionalFilters, metrics, true)
        : undefined;
      if (grouped) {
        matches = grouped.bindings;
      } else {
        for (const pattern of optionalGroup.patterns) {
          matches = this.joinPattern(matches, { kind: 'pattern', pattern, originalIndex: -1 }, optionalFilters, metrics, true).bindings;
          if (matches.length === 0) {
            return [binding];
          }
        }
      }
      for (const unionGroup of optionalGroup.unions ?? []) {
        matches = this.joinUnionGroup(matches, unionGroup.branches, optionalFilters, metrics);
        metrics.plan.push(`OptionalUnion(${unionGroup.branches.map((branch) => branch.patterns.map(describePattern).join(',')).join('|')})`);
        if (matches.length === 0) {
          return [binding];
        }
      }
      for (const rawNestedOptionalGroup of optionalGroup.optional ?? []) {
        const nestedOptionalGroup = normalizeOptionalGroup(rawNestedOptionalGroup);
        matches = this.joinOptionalGroup(matches, nestedOptionalGroup, metrics);
        metrics.plan.push(`OptionalNestedJoin(${nestedOptionalGroup.patterns.map(describePattern).join(',')})`);
        if (matches.length === 0) {
          return [binding];
        }
      }
      for (const minusGroup of optionalGroup.minus ?? []) {
        matches = this.applyMinusGroup(matches, minusGroup, metrics);
        metrics.plan.push(`OptionalMinus(${minusGroup.patterns.map(describePattern).join(',')})`);
        if (matches.length === 0) {
          return [binding];
        }
      }
      for (const existsGroup of optionalGroup.exists ?? []) {
        matches = this.applyExistsGroup(matches, existsGroup, metrics);
        metrics.plan.push(`OptionalExists(${existsGroup.patterns.map(describePattern).join(',')})`);
        if (matches.length === 0) {
          return [binding];
        }
      }
      if ((optionalGroup.binds?.length ?? 0) > 0) {
        matches = this.applyBinds(matches, optionalGroup.binds ?? []);
        metrics.plan.push(`OptionalBind(${(optionalGroup.binds ?? []).map(describeBind).join(',')})`);
      }
      if (optionalFilters.length > 0) {
        matches = matches.filter((match) => this.matchesFilters(match, optionalFilters));
        metrics.filtersApplied += optionalFilters.length;
        if (matches.length === 0) {
          return [binding];
        }
      }
      return matches;
    });
  }

  private joinUnionGroup(
    input: RdfBindingRow[],
    branches: RdfUnionQueryBranch[],
    outerFilters: RdfQueryFilter[],
    metrics: RdfLocalQueryMetrics,
  ): RdfBindingRow[] {
    const output: RdfBindingRow[] = [];
    for (const binding of input) {
      for (const branch of branches) {
        let matches: RdfBindingRow[] = [binding];
        const branchFilters = [...outerFilters, ...(branch.filters ?? [])];
        for (const source of branch.values ?? []) {
          matches = joinValuesSource(matches, source);
          metrics.scannedRows += source.rows.length;
          metrics.plan.push(`UnionValues(${source.variables.map((variableName) => `?${variableName}`).join(',')})`);
          if (matches.length === 0) {
            break;
          }
        }
        if (matches.length === 0) {
          continue;
        }
        const grouped = (branch.values?.length ?? 0) === 0
          ? this.joinPatternGroupRdf3x(matches, branch.patterns, branchFilters, metrics, false)
          : undefined;
        if (grouped) {
          matches = grouped.bindings;
        } else {
          for (const pattern of branch.patterns) {
            matches = this.joinPattern(matches, { kind: 'pattern', pattern, originalIndex: -1 }, branchFilters, metrics, false).bindings;
            if (matches.length === 0) {
              break;
            }
          }
        }
        if (matches.length === 0) {
          continue;
        }
        if ((branch.binds?.length ?? 0) > 0) {
          matches = this.applyBinds(matches, branch.binds ?? []);
          metrics.plan.push(`UnionBind(${(branch.binds ?? []).map(describeBind).join(',')})`);
        }
        if (matches.length === 0) {
          continue;
        }
        for (const rawOptionalGroup of branch.optional ?? []) {
          const optionalGroup = normalizeOptionalGroup(rawOptionalGroup);
          matches = this.joinOptionalGroup(matches, optionalGroup, metrics);
          metrics.plan.push(`UnionOptionalJoin(${optionalGroup.patterns.map(describePattern).join(',')})`);
          if (matches.length === 0) {
            break;
          }
        }
        if (matches.length === 0) {
          continue;
        }
        if (branch.filters?.length) {
          matches = matches.filter((match) => this.matchesFilters(match, branch.filters ?? []));
          metrics.filtersApplied += branch.filters.length;
          metrics.plan.push(`UnionFilter(${branch.filters.map(describeFilter).join(',')})`);
        }
        output.push(...matches);
      }
    }
    return output;
  }

  private applyDependentValues(
    input: RdfBindingRow[],
    sources: RdfValuesBindingSource[] | undefined,
    metrics: RdfLocalQueryMetrics,
    label: 'Minus' | 'Exists',
  ): RdfBindingRow[] {
    let matches = input;
    for (const source of sources ?? []) {
      matches = joinValuesSource(matches, source);
      metrics.scannedRows += source.rows.length;
      metrics.plan.push(`${label}Values(${source.variables.map((variableName) => `?${variableName}`).join(',')})`);
      if (matches.length === 0) {
        break;
      }
    }
    return matches;
  }

  private applyMinusGroup(
    input: RdfBindingRow[],
    minusGroup: RdfMinusQueryGroup,
    metrics: RdfLocalQueryMetrics,
  ): RdfBindingRow[] {
    const filters = minusGroup.filters ?? [];
    const output: RdfBindingRow[] = [];
    for (const binding of input) {
      let matches: RdfBindingRow[] = [binding];
      matches = this.applyDependentValues(matches, minusGroup.values, metrics, 'Minus');
      const grouped = (minusGroup.values?.length ?? 0) === 0
        ? this.joinPatternGroupRdf3x(matches, minusGroup.patterns, filters, metrics, false)
        : undefined;
      if (grouped) {
        matches = grouped.bindings;
      } else {
        for (const pattern of minusGroup.patterns) {
          matches = this.joinPattern(matches, { kind: 'pattern', pattern, originalIndex: -1 }, filters, metrics, false).bindings;
          if (matches.length === 0) {
            break;
          }
        }
      }
      if (matches.length > 0) {
        for (const unionGroup of minusGroup.unions ?? []) {
          matches = this.joinUnionGroup(matches, unionGroup.branches, filters, metrics);
          metrics.plan.push(`MinusUnion(${unionGroup.branches.map((branch) => branch.patterns.map(describePattern).join(',')).join('|')})`);
          if (matches.length === 0) {
            break;
          }
        }
      }
      for (const rawOptionalGroup of minusGroup.optional ?? []) {
        const optionalGroup = normalizeOptionalGroup(rawOptionalGroup);
        matches = this.joinOptionalGroup(matches, optionalGroup, metrics);
        metrics.plan.push(`MinusOptionalJoin(${optionalGroup.patterns.map(describePattern).join(',')})`);
      }
      if ((minusGroup.binds?.length ?? 0) > 0) {
        matches = this.applyBinds(matches, minusGroup.binds ?? []);
        metrics.plan.push(`MinusBind(${(minusGroup.binds ?? []).map(describeBind).join(',')})`);
      }
      if (filters.length > 0) {
        matches = matches.filter((match) => this.matchesFilters(match, filters));
        metrics.filtersApplied += filters.length;
        metrics.plan.push(`MinusFilter(${filters.map(describeFilter).join(',')})`);
      }
      if (matches.length === 0) {
        output.push(binding);
      }
    }
    return output;
  }

  private applyExistsGroup(
    input: RdfBindingRow[],
    existsGroup: RdfExistsQueryGroup,
    metrics: RdfLocalQueryMetrics,
  ): RdfBindingRow[] {
    const filters = existsGroup.filters ?? [];
    const output: RdfBindingRow[] = [];
    for (const binding of input) {
      let matches: RdfBindingRow[] = [binding];
      matches = this.applyDependentValues(matches, existsGroup.values, metrics, 'Exists');
      const grouped = (existsGroup.values?.length ?? 0) === 0
        ? this.joinPatternGroupRdf3x(matches, existsGroup.patterns, filters, metrics, false)
        : undefined;
      if (grouped) {
        matches = grouped.bindings;
      } else {
        for (const pattern of existsGroup.patterns) {
          matches = this.joinPattern(matches, { kind: 'pattern', pattern, originalIndex: -1 }, filters, metrics, false).bindings;
          if (matches.length === 0) {
            break;
          }
        }
      }
      if (matches.length > 0) {
        for (const unionGroup of existsGroup.unions ?? []) {
          matches = this.joinUnionGroup(matches, unionGroup.branches, filters, metrics);
          metrics.plan.push(`ExistsUnion(${unionGroup.branches.map((branch) => branch.patterns.map(describePattern).join(',')).join('|')})`);
          if (matches.length === 0) {
            break;
          }
        }
      }
      for (const rawOptionalGroup of existsGroup.optional ?? []) {
        const optionalGroup = normalizeOptionalGroup(rawOptionalGroup);
        matches = this.joinOptionalGroup(matches, optionalGroup, metrics);
        metrics.plan.push(`ExistsOptionalJoin(${optionalGroup.patterns.map(describePattern).join(',')})`);
      }
      if ((existsGroup.binds?.length ?? 0) > 0) {
        matches = this.applyBinds(matches, existsGroup.binds ?? []);
        metrics.plan.push(`ExistsBind(${(existsGroup.binds ?? []).map(describeBind).join(',')})`);
      }
      if (filters.length > 0) {
        matches = matches.filter((match) => this.matchesFilters(match, filters));
        metrics.filtersApplied += filters.length;
        metrics.plan.push(`ExistsFilter(${filters.map(describeFilter).join(',')})`);
      }
      if (matches.length > 0) {
        output.push(binding);
      }
    }
    return output;
  }

  private joinPatternGroupRdf3x(
    input: RdfBindingRow[],
    patterns: RdfQueryPattern[],
    filters: RdfQueryFilter[],
    metrics: RdfLocalQueryMetrics,
    optional: boolean,
  ): PatternJoinResult | undefined {
    if (!this.rdf3xPrimaryIndex || patterns.length < 2) {
      return undefined;
    }

    const compiledByBinding = input.map((binding) => {
      const compiled = patterns.map((pattern) => this.compileJoinPatternForBinding(pattern, binding, filters));
      return {
        binding,
        patterns: compiled,
      };
    });
    if (compiledByBinding.some((entry) => (
      entry.patterns.some((pattern) => !pattern)
        || !this.canUseRdf3xPrimaryJoin(entry.patterns as CompiledJoinPattern[])
    ))) {
      return undefined;
    }

    const output: RdfBindingRow[] = [];
    for (const entry of compiledByBinding) {
      const compiled = entry.patterns as CompiledJoinPattern[];
      const scan = this.rdf3xPrimaryIndex.joinPatterns(compiled);
      metrics.scannedRows += scan.metrics.matchedRows;
      metrics.indexChoices.push(scan.metrics.indexChoice);
      metrics.filtersPushedDown += uniqueNumbers(compiled.flatMap((pattern) => pattern.pattern.pushedDownFilterIndexes)).length;
      metrics.plan.push(...storagePlanMarkers(scan.metrics.queryPlan));
      const remainingFilters = filtersWithoutIndexes(
        filters,
        uniqueNumbers(compiled.flatMap((pattern) => pattern.pattern.pushedDownFilterIndexes)),
      );
      const before = output.length;
      for (const row of scan.bindings) {
        const next = mergeBindingRows(entry.binding, row);
        if (next && this.matchesNewlyBoundFilters(next, entry.binding, remainingFilters)) {
          output.push(next);
        }
      }
      if (optional && output.length === before) {
        output.push(entry.binding);
      }
    }

    return {
      bindings: output,
      scanBackend: 'rdf3x',
    };
  }

  private compileJoinPatternForBinding(
    pattern: RdfQueryPattern,
    binding: RdfBindingRow,
    filters: RdfQueryFilter[],
  ): CompiledJoinPattern | undefined {
    const variables: Partial<Record<RdfQueryPatternKey, string>> = {};
    for (const key of TERM_KEYS) {
      const value = pattern[key];
      if (isVariable(value) && !binding[value.variable]) {
        variables[key] = value.variable;
      }
    }

    const compiled = this.compilePattern(pattern, binding, filters);
    return compiled ? { pattern: compiled, variables } : undefined;
  }

  private joinPattern(
    input: RdfBindingRow[],
    source: PatternRequiredSource,
    filters: RdfQueryFilter[],
    metrics: RdfLocalQueryMetrics,
    optional: boolean,
    scanOptions?: RdfQuadScanOptions,
  ): PatternJoinResult {
    const output: RdfBindingRow[] = [];
    const backends = new Set<Exclude<PatternScanBackend, 'mixed' | 'none'>>();
    const { pattern } = source;

    for (const binding of input) {
      const compiled = this.compilePattern(pattern, binding, filters);
      if (!compiled) {
        if (optional) {
          output.push(binding);
        }
        continue;
      }
      const tupleValues = this.tupleValuesForBinding(source, binding);
      const scan = this.scanCompiledPattern(compiled, tupleValues, scanOptions);
      backends.add(scan.metrics.engine === 'solid-rdf3x' ? 'rdf3x' : 'index');
      metrics.scannedRows += scan.metrics.matchedRows;
      metrics.indexChoices.push(scan.metrics.indexChoice);
      metrics.filtersPushedDown += compiled.pushedDownFilters;
      metrics.plan.push(...storagePlanMarkers(scan.metrics.queryPlan));

      for (const quad of scan.quads) {
        const next = this.bindQuad(pattern, binding, quad);
        const remainingFilters = filtersWithoutIndexes(filters, compiled.pushedDownFilterIndexes);
        if (next && this.matchesNewlyBoundFilters(next, binding, remainingFilters)) {
          output.push(next);
        }
      }
    }

    return {
      bindings: output,
      scanBackend: backends.size === 0
        ? 'none'
        : backends.size === 1
          ? [...backends][0]
          : 'mixed',
    };
  }

  private scanCompiledPattern(
    compiled: CompiledPattern,
    tupleValues: RdfQuadTupleConstraintSource | undefined,
    scanOptions?: RdfQuadScanOptions,
  ): RdfQuadIndexScanResult | Rdf3xTripleScanResult {
    if (this.canUseRdf3xPrimaryScan(compiled, scanOptions)) {
      const rdf3xPattern = toRdf3xTriplePattern(compiled);
      return tupleValues
        ? this.rdf3xPrimaryIndex!.scanWithTupleConstraints(rdf3xPattern, tupleValues, toRdf3xScanOptions(scanOptions))
        : this.rdf3xPrimaryIndex!.scan(rdf3xPattern, toRdf3xScanOptions(scanOptions));
    }
    return tupleValues
      ? this.index.scanWithTupleConstraints(compiled, tupleValues, scanOptions)
      : this.index.scan(compiled, scanOptions);
  }

  private canUseRdf3xPrimaryScan(
    pattern: QuintPattern,
    scanOptions?: RdfQuadScanOptions,
  ): boolean {
    return Boolean(this.rdf3xPrimaryIndex)
      && isRdf3xCompatiblePattern(pattern);
  }

  private requiredBgpPushdown(
    query: RdfLocalQuery,
    requiredPatterns: RdfQueryPattern[],
    filters: RdfQueryFilter[],
  ): RequiredBgpPushdown | undefined {
    if (
      requiredPatterns.length < 1
      || (query.textSearch?.length ?? 0) > 0
      || (query.vectorSearch?.length ?? 0) > 0
      || (query.unions?.length ?? 0) > 0
      || (query.minus?.length ?? 0) > 0
      || (query.exists?.length ?? 0) > 0
      || (query.optional?.length ?? 0) > 0
      || (query.binds?.length ?? 0) > 0
      || queryAggregates(query).length > 0
    ) {
      return undefined;
    }
    if (requiredPatterns.length === 1 && !query.distinct) {
      return undefined;
    }

    if (!this.canPushRequiredBgpFilters(requiredPatterns, filters)) {
      return undefined;
    }
    const values = query.values?.length
      ? this.requiredBgpValuesPushdown(query.values, requiredPatterns)
      : undefined;
    if ((query.values?.length ?? 0) > 0 && !values) {
      return undefined;
    }

    const distinctProject = query.distinct
      ? this.requiredBgpDistinctProject(query, requiredPatterns, filters)
      : undefined;
    if (query.distinct && !distinctProject) {
      return undefined;
    }

    const orderPushed = (query.orderBy?.length ?? 0) > 0;
    if (orderPushed && !this.canPushRequiredBgpOrder(requiredPatterns, query.orderBy ?? [])) {
      return undefined;
    }

    const sharedVariables = variablesSharedAcrossPatterns(requiredPatterns);
    if (requiredPatterns.length > 1 && sharedVariables.size === 0) {
      return undefined;
    }

    const compiled = requiredPatterns.map((pattern) => this.compileJoinPattern(pattern, filters));
    if (compiled.some((entry) => !entry)) {
      return undefined;
    }
    if (values && !this.canUseRdf3xPrimaryJoin(compiled as CompiledJoinPattern[])) {
      return undefined;
    }
    const reordered = this.reorderJoinPatterns(requiredPatterns, compiled as CompiledJoinPattern[], filters);
    return {
      patterns: reordered.patterns,
      ...(values ? { values } : {}),
      ...(reordered.reorderPlan ? { reorderPlan: reordered.reorderPlan } : {}),
      orderPushed,
      paginationPushed: query.limit !== undefined || query.offset !== undefined,
      distinctPushed: Boolean(distinctProject),
      ...(distinctProject ? { project: distinctProject } : {}),
      pushedDownFilters: filters.length,
    };
  }

  private requiredBgpValuesPushdown(
    values: RdfValuesBindingSource[],
    requiredPatterns: RdfQueryPattern[],
  ): RdfValuesBindingSource[] | undefined {
    const visibleVariables = new Set(requiredPatterns.flatMap((pattern) => variablesInPattern(pattern)));
    for (const source of values) {
      if (source.variables.length === 0 || new Set(source.variables).size !== source.variables.length) {
        return undefined;
      }
      if (source.variables.some((variableName) => !visibleVariables.has(variableName))) {
        return undefined;
      }
      if (source.rows.some((row) => source.variables.some((variableName) => !row[variableName]))) {
        return undefined;
      }
    }
    return values;
  }

  private requiredBgpDistinctProject(
    query: RdfLocalQuery,
    requiredPatterns: RdfQueryPattern[],
    filters: RdfQueryFilter[],
  ): string[] | undefined {
    const visibleVariables = new Set(requiredPatterns.flatMap((pattern) => variablesInPattern(pattern)));
    const projectedVariables = uniqueStrings(
      query.select && query.select.length > 0
        ? query.select
        : [...visibleVariables],
    );
    if (projectedVariables.some((variableName) => !visibleVariables.has(variableName))) {
      return undefined;
    }

    const requiredForRecheck = new Set(filters.flatMap((filter) => filterVariables(filter)));
    for (const order of query.orderBy ?? []) {
      requiredForRecheck.add(order.variable);
    }
    if ([...requiredForRecheck].some((variableName) => !projectedVariables.includes(variableName))) {
      return undefined;
    }
    return projectedVariables;
  }

  private canPushRequiredBgpFilters(
    requiredPatterns: RdfQueryPattern[],
    filters: RdfQueryFilter[],
  ): boolean {
    const variables = new Set(requiredPatterns.flatMap((pattern) => variablesInPattern(pattern)));
    return filters.every((filter) => (
      !filter.variable2
      && variables.has(filter.variable)
      && isPushdownFilter(filter)
      && this.compilePushdownFilter(filter.variable, [filter]) !== null
    ));
  }

  private canPushRequiredBgpOrder(
    requiredPatterns: RdfQueryPattern[],
    orderBy: NonNullable<RdfLocalQuery['orderBy']>,
  ): boolean {
    if (orderBy.length === 0) {
      return true;
    }
    const variables = new Set(requiredPatterns.flatMap((pattern) => variablesInPattern(pattern)));
    return orderBy.every((entry) => variables.has(entry.variable));
  }

  private reorderJoinPatterns(
    requiredPatterns: RdfQueryPattern[],
    compiledPatterns: CompiledJoinPattern[],
    filters: RdfQueryFilter[],
  ): { patterns: CompiledJoinPattern[]; reorderPlan?: string } {
    if (compiledPatterns.length < 2) {
      return { patterns: compiledPatterns };
    }

    const candidates = requiredPatterns.map((pattern, index) => {
      const compiled = this.compilePattern(pattern, {}, filters);
      return {
        index,
        variables: new Set(variablesInPattern(pattern)),
        estimatedRows: compiled ? this.index.estimateCardinality(compiled).rows : Number.MAX_SAFE_INTEGER,
      };
    });
    const remaining = [...candidates];
    const selected: typeof candidates = [];
    const selectedVariables = new Set<string>();

    while (remaining.length > 0) {
      const hasSelectedVariables = selectedVariables.size > 0;
      remaining.sort((left, right) => {
        const leftConnected = !hasSelectedVariables || hasSharedVariable(left.variables, selectedVariables);
        const rightConnected = !hasSelectedVariables || hasSharedVariable(right.variables, selectedVariables);
        return Number(rightConnected) - Number(leftConnected)
          || left.estimatedRows - right.estimatedRows
          || left.index - right.index;
      });
      const [next] = remaining.splice(0, 1);
      selected.push(next);
      for (const variableName of next.variables) {
        selectedVariables.add(variableName);
      }
    }

    const order = selected.map((entry) => entry.index);
    if (order.every((index, position) => index === position)) {
      return { patterns: compiledPatterns };
    }

    return {
      patterns: order.map((index) => compiledPatterns[index]),
      reorderPlan: `JoinReorder(${order.join('>')})`,
    };
  }

  private compileJoinPattern(
    pattern: RdfQueryPattern,
    filters: RdfQueryFilter[],
  ): CompiledJoinPattern | undefined {
    const variables: Partial<Record<RdfQueryPatternKey, string>> = {};
    for (const key of TERM_KEYS) {
      const value = pattern[key];
      if (isVariable(value)) {
        variables[key] = value.variable;
      }
    }

    const compiled = this.compilePattern(pattern, {}, filters);
    return compiled ? { pattern: compiled, variables } : undefined;
  }

  private canUseRdf3xPrimaryJoin(patterns: CompiledJoinPattern[]): boolean {
    return Boolean(this.rdf3xPrimaryIndex)
      && patterns.length > 0
      && patterns.every((entry) => isRdf3xCompatiblePattern(entry.pattern));
  }

  private tupleValuesForBinding(
    source: PatternRequiredSource,
    binding: RdfBindingRow,
  ): RdfQuadTupleConstraintSource | undefined {
    if (!source.tupleValues) {
      return undefined;
    }
    const rows = source.tupleValues.rows.filter((row) => (
      source.tupleValues?.variables.every((variableName) => {
        const existing = binding[variableName];
        const value = row[variableName];
        return !existing || !value || sameTerm(existing, value);
      })
    ));
    return tupleConstraintSourceForPattern({ ...source.tupleValues, rows }, source.pattern);
  }

  private joinTextSearch(
    input: RdfBindingRow[],
    source: TextRequiredSource,
    metrics: RdfLocalQueryMetrics,
  ): RdfBindingRow[] {
    metrics.indexChoices.push('text-chunk');
    const sourceVariable = source.pattern.source;
    if (sourceVariable && this.canUseBoundSourceSearch(input, source, sourceVariable)) {
      return this.joinTextSearchByBoundSource(input, source, sourceVariable, metrics);
    }

    const results = this.textSearchResults(source);
    metrics.scannedRows += results.length;

    const output: RdfBindingRow[] = [];
    for (const binding of input) {
      for (const result of results) {
        const next = bindTextSearchResult(binding, source.pattern, result);
        if (next) {
          output.push(next);
        }
      }
    }
    return output;
  }

  private joinVectorSearch(
    input: RdfBindingRow[],
    source: VectorRequiredSource,
    metrics: RdfLocalQueryMetrics,
  ): RdfBindingRow[] {
    metrics.indexChoices.push('vector-chunk');
    const sourceVariable = source.pattern.source;
    if (sourceVariable && this.canUseBoundSourceSearch(input, source, sourceVariable)) {
      return this.joinVectorSearchByBoundSource(input, source, sourceVariable, metrics);
    }

    const results = this.vectorSearchResults(source);
    metrics.scannedRows += results.length;

    const output: RdfBindingRow[] = [];
    for (const binding of input) {
      for (const result of results) {
        const next = bindVectorSearchResult(binding, source.pattern, result);
        if (next) {
          output.push(next);
        }
      }
    }
    return output;
  }

  private joinTextSearchByBoundSource(
    input: RdfBindingRow[],
    source: TextRequiredSource,
    sourceVariable: string,
    metrics: RdfLocalQueryMetrics,
  ): RdfBindingRow[] {
    const cache = new Map<string, RdfTextSearchResult[]>();
    const countedSources = new Set<string>();
    let globalResults: RdfTextSearchResult[] | undefined;
    let countedGlobal = false;
    const output: RdfBindingRow[] = [];

    for (const binding of input) {
      const term = binding[sourceVariable];
      let results: RdfTextSearchResult[];
      if (!term) {
        globalResults ??= this.textSearchResults(source);
        results = globalResults;
        if (!countedGlobal) {
          metrics.scannedRows += results.length;
          countedGlobal = true;
        }
      } else if (term.termType !== 'NamedNode') {
        continue;
      } else {
        if (!cache.has(term.value)) {
          cache.set(term.value, this.textSearchResults(source, term.value));
        }
        results = cache.get(term.value) ?? [];
        if (!countedSources.has(term.value)) {
          metrics.scannedRows += results.length;
          countedSources.add(term.value);
        }
      }

      for (const result of results) {
        const next = bindTextSearchResult(binding, source.pattern, result);
        if (next) {
          output.push(next);
        }
      }
    }

    return output;
  }

  private joinVectorSearchByBoundSource(
    input: RdfBindingRow[],
    source: VectorRequiredSource,
    sourceVariable: string,
    metrics: RdfLocalQueryMetrics,
  ): RdfBindingRow[] {
    const cache = new Map<string, RdfVectorSearchResult[]>();
    const countedSources = new Set<string>();
    let globalResults: RdfVectorSearchResult[] | undefined;
    let countedGlobal = false;
    const output: RdfBindingRow[] = [];

    for (const binding of input) {
      const term = binding[sourceVariable];
      let results: RdfVectorSearchResult[];
      if (!term) {
        globalResults ??= this.vectorSearchResults(source);
        results = globalResults;
        if (!countedGlobal) {
          metrics.scannedRows += results.length;
          countedGlobal = true;
        }
      } else if (term.termType !== 'NamedNode') {
        continue;
      } else {
        if (!cache.has(term.value)) {
          cache.set(term.value, this.vectorSearchResults(source, term.value));
        }
        results = cache.get(term.value) ?? [];
        if (!countedSources.has(term.value)) {
          metrics.scannedRows += results.length;
          countedSources.add(term.value);
        }
      }

      for (const result of results) {
        const next = bindVectorSearchResult(binding, source.pattern, result);
        if (next) {
          output.push(next);
        }
      }
    }

    return output;
  }

  private canUseBoundSourceSearch(
    input: RdfBindingRow[],
    source: TextRequiredSource | VectorRequiredSource,
    sourceVariable: string,
  ): boolean {
    if (hasSearchWindow(source)) {
      return false;
    }

    const boundSources = new Set<string>();
    let sawBound = false;

    for (const binding of input) {
      const term = binding[sourceVariable];
      if (!term) {
        continue;
      }

      sawBound = true;
      if (term.termType !== 'NamedNode') {
        continue;
      }

      boundSources.add(term.value);
    }

    return sawBound && boundSources.size > 0;
  }

  private textSearchResults(source: TextRequiredSource, exactSource?: string): RdfTextSearchResult[] {
    if (exactSource === undefined && source.results) {
      return source.results;
    }
    if (!this.textIndex) {
      throw new Error('RdfLocalQuery textSearch requires a configured RdfTextIndex');
    }

    const options = this.textSearchOptions(source.pattern, exactSource);
    const results = options ? this.textIndex.search(options) : [];
    if (exactSource === undefined) {
      source.results = results;
    }
    return results;
  }

  private vectorSearchResults(source: VectorRequiredSource, exactSource?: string): RdfVectorSearchResult[] {
    if (exactSource === undefined && source.results) {
      return source.results;
    }
    if (!this.vectorIndex) {
      throw new Error('RdfLocalQuery vectorSearch requires a configured RdfVectorIndex');
    }

    const options = this.vectorSearchOptions(source.pattern, exactSource);
    const results = options ? this.vectorIndex.search(options) : [];
    if (exactSource === undefined) {
      source.results = results;
    }
    return results;
  }

  private textSearchOptions(pattern: RdfTextSearchPattern, exactSource?: string): RdfTextSearchOptions {
    return {
      query: pattern.query,
      source: exactSource,
      workspace: pattern.scope?.workspace,
      sourcePrefix: pattern.scope?.sourcePrefix,
      limit: pattern.limit,
      offset: pattern.offset,
      orderBy: pattern.orderBy,
    };
  }

  private vectorSearchOptions(pattern: RdfVectorSearchPattern, exactSource?: string): RdfVectorSearchOptions {
    return {
      embedding: pattern.embedding,
      metric: pattern.metric,
      model: pattern.vectorModel,
      source: exactSource,
      workspace: pattern.scope?.workspace,
      sourcePrefix: pattern.scope?.sourcePrefix,
      limit: pattern.limit,
      offset: pattern.offset,
      threshold: pattern.threshold,
      orderBy: pattern.orderBy,
    };
  }

  private applyBinds(input: RdfBindingRow[], binds: RdfQueryBind[]): RdfBindingRow[] {
    let output = input;
    for (const bind of binds) {
      output = output.flatMap((binding) => {
        if (binding[bind.variable]) {
          return [];
        }
        const value = this.evaluateBindExpression(bind.expression, binding);
        return value ? [{ ...binding, [bind.variable]: value }] : [binding];
      });
    }
    return output;
  }

  private evaluateBindExpression(expression: RdfBindExpression, binding: RdfBindingRow): Term | undefined {
    switch (expression.type) {
      case 'term':
        return expression.term;
      case 'variable':
        return binding[expression.variable];
      case 'stringValue': {
        const value = binding[expression.variable];
        return value ? DataFactory.literal(value.value) as Term : undefined;
      }
      case 'stringLength': {
        const value = binding[expression.variable];
        return value ? countLiteral(value.value.length) : undefined;
      }
      case 'lowerCase': {
        const value = this.evaluateBindExpression(expression.expression, binding);
        return value ? DataFactory.literal(value.value.toLocaleLowerCase('en-US')) as Term : undefined;
      }
      case 'upperCase': {
        const value = this.evaluateBindExpression(expression.expression, binding);
        return value ? DataFactory.literal(value.value.toLocaleUpperCase('en-US')) as Term : undefined;
      }
      case 'substring': {
        const value = this.evaluateBindExpression(expression.expression, binding);
        const startTerm = this.evaluateBindExpression(expression.start, binding);
        const startValue = startTerm ? finiteBindNumber(startTerm) : undefined;
        const lengthTerm = expression.length ? this.evaluateBindExpression(expression.length, binding) : undefined;
        const lengthValue = lengthTerm ? finiteBindNumber(lengthTerm) : undefined;
        if (!value || startValue === undefined || (expression.length && lengthValue === undefined)) {
          return undefined;
        }
        const start = Math.max(0, Math.round(startValue) - 1);
        const length = lengthValue === undefined ? undefined : Math.max(0, Math.round(lengthValue));
        return DataFactory.literal(value.value.slice(start, length === undefined ? undefined : start + length)) as Term;
      }
      case 'concat': {
        const values = expression.expressions.map((item) => this.evaluateBindExpression(item, binding));
        return values.every((value): value is Term => Boolean(value))
          ? DataFactory.literal(values.map((value) => value.value).join('')) as Term
          : undefined;
      }
      case 'iri': {
        const value = this.evaluateBindExpression(expression.expression, binding);
        if (!value) {
          return undefined;
        }
        try {
          return DataFactory.namedNode(new URL(value.value, expression.base).href) as Term;
        } catch {
          return undefined;
        }
      }
      default: {
        const exhaustive: never = expression;
        throw new Error(`Unsupported RDF local BIND expression: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private singleScanPushdown(
    query: RdfLocalQuery,
    requiredPatterns: RdfQueryPattern[],
    filters: RdfQueryFilter[],
  ): SingleScanPushdown | undefined {
    if (
      requiredPatterns.length !== 1
      || (query.values?.length ?? 0) > 0
      || (query.textSearch?.length ?? 0) > 0
      || (query.vectorSearch?.length ?? 0) > 0
      || (query.unions?.length ?? 0) > 0
      || (query.minus?.length ?? 0) > 0
      || (query.exists?.length ?? 0) > 0
      || (query.optional?.length ?? 0) > 0
      || queryAggregates(query).length > 0
    ) {
      return undefined;
    }

    const pattern = requiredPatterns[0];
    const order = this.scanOrderForPattern(pattern, query.orderBy ?? []);
    const orderRequested = (query.orderBy?.length ?? 0) > 0;
    const orderPushed = Boolean(order);
    const paginationRequested = query.limit !== undefined || query.offset !== undefined;
    const paginationPushed = paginationRequested
      && !query.distinct
      && (!orderRequested || orderPushed)
      && !patternHasRepeatedVariables(pattern)
      && this.canPushAllFiltersForPattern(pattern, filters);

    if (!orderPushed && !paginationPushed) {
      return undefined;
    }

    return {
      options: {
        ...(order ?? {}),
        ...(paginationPushed && query.limit !== undefined ? { limit: Math.max(0, query.limit) } : {}),
        ...(paginationPushed && query.offset !== undefined ? { offset: Math.max(0, query.offset) } : {}),
      },
      orderPushed,
      paginationPushed,
    };
  }

  private countPushdown(
    query: RdfLocalQuery,
    requiredPatterns: RdfQueryPattern[],
    filters: RdfQueryFilter[],
  ): { as: string; pattern: QuintPattern; distinctKey?: RdfQueryPatternKey; pushedDownFilters: number } | undefined {
    const aggregates = queryAggregates(query);
    if (
      aggregates.length !== 1
      || aggregates[0].type !== 'count'
      || (query.having?.length ?? 0) > 0
      || requiredPatterns.length !== 1
      || (query.values?.length ?? 0) > 0
      || (query.textSearch?.length ?? 0) > 0
      || (query.vectorSearch?.length ?? 0) > 0
      || (query.unions?.length ?? 0) > 0
      || (query.minus?.length ?? 0) > 0
      || (query.exists?.length ?? 0) > 0
      || (query.optional?.length ?? 0) > 0
      || (query.groupBy?.length ?? 0) > 0
      || query.orderBy?.length
      || query.limit !== undefined
      || query.offset !== undefined
    ) {
      return undefined;
    }

    const pattern = requiredPatterns[0];
    if (patternHasRepeatedVariables(pattern)) {
      return undefined;
    }
    const aggregate = aggregates[0];
    if (aggregate.variable && !variablesInPattern(pattern).includes(aggregate.variable)) {
      return undefined;
    }
    const distinctKey = aggregate.distinct
      ? this.distinctCountKey(pattern, aggregate.variable)
      : undefined;
    if (aggregate.distinct && !distinctKey) {
      return undefined;
    }
    if (!this.canPushAllFiltersForPattern(pattern, filters)) {
      return undefined;
    }

    const compiled = this.compilePattern(pattern, {}, filters);
    return compiled
      ? {
          as: aggregate.as,
          pattern: compiled,
          distinctKey,
          pushedDownFilters: compiled.pushedDownFilters,
        }
      : undefined;
  }

  private joinCountPushdown(
    query: RdfLocalQuery,
    requiredPatterns: RdfQueryPattern[],
    filters: RdfQueryFilter[],
    aggregates: RdfQueryAggregate[],
  ): JoinCountPushdown | undefined {
    if (
      aggregates.length === 0
      || requiredPatterns.length < 2
      || (query.having?.length ?? 0) > 0
      || (query.groupBy?.length ?? 0) > 0
      || (query.values?.length ?? 0) > 0
      || (query.textSearch?.length ?? 0) > 0
      || (query.vectorSearch?.length ?? 0) > 0
      || (query.unions?.length ?? 0) > 0
      || (query.minus?.length ?? 0) > 0
      || (query.exists?.length ?? 0) > 0
      || (query.optional?.length ?? 0) > 0
      || (query.binds?.length ?? 0) > 0
      || query.orderBy?.length
      || query.limit !== undefined
      || query.offset !== undefined
      || query.distinct
    ) {
      return undefined;
    }
    if (aggregates.some((aggregate) => aggregate.type !== 'count')) {
      return undefined;
    }
    if (!this.canPushRequiredBgpFilters(requiredPatterns, filters)) {
      return undefined;
    }

    const visibleVariables = new Set(requiredPatterns.flatMap((pattern) => variablesInPattern(pattern)));
    if (aggregates.some((aggregate) => aggregate.variable && !visibleVariables.has(aggregate.variable))) {
      return undefined;
    }
    const sharedVariables = variablesSharedAcrossPatterns(requiredPatterns);
    if (sharedVariables.size === 0) {
      return undefined;
    }

    const compiled = requiredPatterns.map((pattern) => this.compileJoinPattern(pattern, filters));
    if (compiled.some((entry) => !entry)) {
      return undefined;
    }
    const reordered = this.reorderJoinPatterns(requiredPatterns, compiled as CompiledJoinPattern[], filters);
    return {
      patterns: reordered.patterns,
      ...(reordered.reorderPlan ? { reorderPlan: reordered.reorderPlan } : {}),
      pushedDownFilters: filters.length,
    };
  }

  private joinBasicAggregatePushdown(
    query: RdfLocalQuery,
    requiredPatterns: RdfQueryPattern[],
    filters: RdfQueryFilter[],
    aggregates: RdfQueryAggregate[],
  ): JoinBasicAggregatePushdown | undefined {
    if (
      aggregates.length === 0
      || !aggregates.some((aggregate) => aggregate.type !== 'count')
      || requiredPatterns.length === 0
      || (query.having?.length ?? 0) > 0
      || (query.groupBy?.length ?? 0) > 0
      || (query.values?.length ?? 0) > 0
      || (query.textSearch?.length ?? 0) > 0
      || (query.vectorSearch?.length ?? 0) > 0
      || (query.unions?.length ?? 0) > 0
      || (query.minus?.length ?? 0) > 0
      || (query.exists?.length ?? 0) > 0
      || (query.optional?.length ?? 0) > 0
      || (query.binds?.length ?? 0) > 0
      || query.orderBy?.length
      || query.limit !== undefined
      || query.offset !== undefined
      || query.distinct
    ) {
      return undefined;
    }

    if (aggregates.some((aggregate) => aggregate.distinct || aggregate.type !== 'count' && !aggregate.variable)) {
      return undefined;
    }
    const visibleVariables = new Set(requiredPatterns.flatMap((pattern) => variablesInPattern(pattern)));
    if (aggregates.some((aggregate) => aggregate.variable && !visibleVariables.has(aggregate.variable))) {
      return undefined;
    }
    const numericAggregateVariables = new Set(aggregates
      .filter((aggregate) => aggregate.type !== 'count')
      .map((aggregate) => aggregate.variable)
      .filter((variableName): variableName is string => Boolean(variableName)));
    if (!this.canPushAggregateFilters(requiredPatterns, filters, numericAggregateVariables)) {
      return undefined;
    }
    const sharedVariables = variablesSharedAcrossPatterns(requiredPatterns);
    if (requiredPatterns.length > 1 && sharedVariables.size === 0) {
      return undefined;
    }

    const compiled = requiredPatterns.map((pattern) => this.compileJoinPattern(pattern, filters));
    if (compiled.some((entry) => !entry)) {
      return undefined;
    }
    const reordered = this.reorderJoinPatterns(requiredPatterns, compiled as CompiledJoinPattern[], filters);
    return {
      patterns: reordered.patterns,
      ...(reordered.reorderPlan ? { reorderPlan: reordered.reorderPlan } : {}),
      pushedDownFilters: filters.length,
    };
  }

  private canPushAggregateFilters(
    requiredPatterns: RdfQueryPattern[],
    filters: RdfQueryFilter[],
    numericAggregateVariables: Set<string>,
  ): boolean {
    const variables = new Set(requiredPatterns.flatMap((pattern) => variablesInPattern(pattern)));
    return filters.every((filter) => {
      if (!variables.has(filter.variable) || filter.variable2) {
        return false;
      }
      if (isNumericGuardFilter(filter) && numericAggregateVariables.has(filter.variable)) {
        return true;
      }
      return isPushdownFilter(filter) && this.compilePushdownFilter(filter.variable, [filter]) !== null;
    });
  }

  private hasNumericAggregateGuards(
    filters: RdfQueryFilter[],
    numericAggregateVariables: Set<string>,
  ): boolean {
    return [...numericAggregateVariables].every((variableName) => (
      filters.some((filter) => isNumericGuardFilter(filter) && filter.variable === variableName)
    ));
  }

  private groupAggregatePushdown(
    query: RdfLocalQuery,
    requiredPatterns: RdfQueryPattern[],
    filters: RdfQueryFilter[],
    aggregates: RdfQueryAggregate[],
  ): GroupAggregatePushdown | undefined {
    if (
      aggregates.length === 0
      || (query.groupBy?.length ?? 0) === 0
      || (query.values?.length ?? 0) > 0
      || (query.textSearch?.length ?? 0) > 0
      || (query.vectorSearch?.length ?? 0) > 0
      || (query.unions?.length ?? 0) > 0
      || (query.minus?.length ?? 0) > 0
      || (query.exists?.length ?? 0) > 0
      || (query.optional?.length ?? 0) > 0
      || (query.binds?.length ?? 0) > 0
      || query.distinct
    ) {
      return undefined;
    }
    if (aggregates.some((aggregate) => (
      aggregate.type !== 'count'
        && (!aggregate.variable || aggregate.distinct)
    ))) {
      return undefined;
    }
    const numericAggregateVariables = new Set(aggregates
      .filter((aggregate) => aggregate.type !== 'count')
      .map((aggregate) => aggregate.variable)
      .filter((variableName): variableName is string => Boolean(variableName)));
    if (
      !this.hasNumericAggregateGuards(filters, numericAggregateVariables)
      || !this.canPushAggregateFilters(requiredPatterns, filters, numericAggregateVariables)
    ) {
      return undefined;
    }

    const visibleVariables = new Set(requiredPatterns.flatMap((pattern) => variablesInPattern(pattern)));
    if ((query.groupBy ?? []).some((variableName) => !visibleVariables.has(variableName))) {
      return undefined;
    }
    if (aggregates.some((aggregate) => aggregate.variable && !visibleVariables.has(aggregate.variable))) {
      return undefined;
    }
    const countOnly = numericAggregateVariables.size === 0;
    const aggregateVariables = new Set(aggregates.map((aggregate) => aggregate.as));
    if ((query.orderBy ?? []).some((entry) => (
      !(query.groupBy ?? []).includes(entry.variable) && !aggregateVariables.has(entry.variable)
    ))) {
      return undefined;
    }
    const orderPushed = (query.orderBy?.length ?? 0) > 0;
    const havingPushdown = this.groupAggregateHavingPushdown(query.having ?? [], aggregateVariables);
    const havingPushed = (query.having?.length ?? 0) === 0 || havingPushdown !== undefined;
    const paginationPushed = (query.limit !== undefined || query.offset !== undefined) && havingPushed;

    const sharedVariables = variablesSharedAcrossPatterns(requiredPatterns);
    if (requiredPatterns.length > 1 && sharedVariables.size === 0) {
      return undefined;
    }

    const compiled = requiredPatterns.map((pattern) => this.compileJoinPattern(pattern, filters));
    if (compiled.some((entry) => !entry)) {
      return undefined;
    }
    const reordered = this.reorderJoinPatterns(requiredPatterns, compiled as CompiledJoinPattern[], filters);
    return {
      patterns: reordered.patterns,
      ...(reordered.reorderPlan ? { reorderPlan: reordered.reorderPlan } : {}),
      ...(havingPushdown && havingPushdown.length > 0 ? { having: havingPushdown } : {}),
      pushedDownFilters: filters.length,
      pushedDownHaving: havingPushdown?.length ?? 0,
      orderPushed,
      paginationPushed,
      countOnly,
    };
  }

  private groupAggregateHavingPushdown(
    having: RdfQueryFilter[],
    aggregateVariables: Set<string>,
  ): RdfQuadJoinGroupAggregateHaving[] | undefined {
    const compiled: RdfQuadJoinGroupAggregateHaving[] = [];
    for (const filter of having) {
      if (
        !aggregateVariables.has(filter.variable)
        || filter.operand
        || filter.variable2
        || filter.value === undefined
        || !isGroupAggregateHavingOperator(filter.operator)
      ) {
        return undefined;
      }
      const value = filterValueToNumber(filter.value);
      if (value === undefined) {
        return undefined;
      }
      compiled.push({
        aggregate: filter.variable,
        operator: filter.operator,
        value,
      });
    }
    return compiled;
  }

  private distinctCountKey(pattern: RdfQueryPattern, variableName?: string): RdfQueryPatternKey | undefined {
    if (!variableName) {
      return undefined;
    }
    const keys = TERM_KEYS.filter((key) => {
      const value = pattern[key];
      return isVariable(value) && value.variable === variableName;
    });
    return keys.length === 1 ? keys[0] : undefined;
  }

  private scanOrderForPattern(
    pattern: RdfQueryPattern,
    orderBy: NonNullable<RdfLocalQuery['orderBy']>,
  ): Pick<RdfQuadScanOptions, 'order' | 'orderDirections' | 'reverse'> | undefined {
    if (orderBy.length === 0) {
      return undefined;
    }

    const order = orderBy.map((entry) => termKeyForVariable(pattern, entry.variable));
    if (order.some((key) => key === undefined)) {
      return undefined;
    }

    const orderDirections = orderBy.map((entry) => entry.direction ?? 'asc');
    const firstDirection = orderDirections[0];
    const sameDirection = orderDirections.every((direction) => direction === firstDirection);

    return {
      order: order as RdfQueryPatternKey[],
      ...(sameDirection
        ? { reverse: firstDirection === 'desc' || undefined }
        : { orderDirections }),
    };
  }

  private canPushAllFiltersForPattern(pattern: RdfQueryPattern, filters: RdfQueryFilter[]): boolean {
    const variables = new Set(variablesInPattern(pattern));
    return filters.every((filter) => (
      variables.has(filter.variable)
        && isPushdownFilter(filter)
        && this.compilePushdownFilter(filter.variable, [filter]) !== null
    ));
  }

  private requiredFiltersNeedingPostApply(
    query: RdfLocalQuery,
    requiredPatterns: RdfQueryPattern[],
    filters: RdfQueryFilter[],
    requiredBgpPushdown?: RequiredBgpPushdown,
  ): RdfQueryFilter[] {
    if (filters.length === 0) {
      return filters;
    }
    if (requiredBgpPushdown) {
      return [];
    }
    if (!this.canElideRequiredPatternFilterRechecks(query, requiredPatterns)) {
      return filters;
    }

    const requiredVariables = new Set(requiredPatterns.flatMap((pattern) => variablesInPattern(pattern)));
    return filters.filter((filter) => !(
      requiredVariables.has(filter.variable)
      && this.compilePushdownFilter(filter.variable, [filter]) !== null
    ));
  }

  private canElideRequiredPatternFilterRechecks(
    query: RdfLocalQuery,
    requiredPatterns: RdfQueryPattern[],
  ): boolean {
    return requiredPatterns.length > 0
      && (query.values?.length ?? 0) === 0
      && (query.textSearch?.length ?? 0) === 0
      && (query.vectorSearch?.length ?? 0) === 0
      && (query.unions?.length ?? 0) === 0
      && (query.minus?.length ?? 0) === 0
      && (query.exists?.length ?? 0) === 0
      && (query.optional?.length ?? 0) === 0
      && (query.binds?.length ?? 0) === 0
      && queryAggregates(query).length === 0;
  }

  private compilePattern(
    pattern: RdfQueryPattern,
    binding: RdfBindingRow,
    filters: RdfQueryFilter[],
  ): CompiledPattern | null {
    const compiled: QuintPattern = {};
    const pushedDownFilterIndexes = new Set<number>();
    for (const key of TERM_KEYS) {
      const value = pattern[key];
      if (!value) continue;
      if (isVariable(value)) {
        const bound = binding[value.variable];
        if (bound) {
          compiled[key] = bound;
        } else {
          const pushdown = this.compilePushdownFilterWithIndexes(value.variable, filters);
          if (pushdown) {
            compiled[key] = pushdown.pattern;
            pushdown.filterIndexes.forEach((index) => pushedDownFilterIndexes.add(index));
          }
        }
      } else {
        compiled[key] = value;
      }
    }
    return isConsistentPattern(compiled)
      ? {
          ...compiled,
          pushedDownFilters: pushedDownFilterIndexes.size,
          pushedDownFilterIndexes: [...pushedDownFilterIndexes],
        }
      : null;
  }

  private bindQuad(pattern: RdfQueryPattern, binding: RdfBindingRow, quad: any): RdfBindingRow | null {
    const next = { ...binding };
    for (const key of TERM_KEYS) {
      const value = pattern[key];
      if (!isVariable(value)) continue;
      const term = quad[key] as Term;
      const existing = next[value.variable];
      if (existing && !sameTerm(existing, term)) {
        return null;
      }
      next[value.variable] = term;
    }
    return next;
  }

  private countBindings(bindings: RdfBindingRow[], variable?: string, distinct?: boolean): number {
    if (!distinct) {
      return variable ? bindings.filter((binding) => binding[variable]).length : bindings.length;
    }
    if (!variable) {
      return new Set(bindings.map((binding) => bindingKey(binding))).size;
    }
    return new Set(
      bindings
        .map((binding) => binding[variable])
        .filter((term): term is Term => Boolean(term))
        .map((term) => termToId(term as any)),
    ).size;
  }

  private aggregateBindings(
    bindings: RdfBindingRow[],
    aggregates: RdfQueryAggregate[],
  ): { binding: RdfBindingRow; firstCount: number } {
    const binding: RdfBindingRow = {};
    let firstCount = 0;
    aggregates.forEach((aggregate, index) => {
      const count = aggregate.type === 'count'
        ? this.countBindings(bindings, aggregate.variable, aggregate.distinct)
        : 0;
      if (index === 0) {
        firstCount = count;
      }
      const term = this.aggregateLiteral(bindings, aggregate);
      if (term) {
        binding[aggregate.as] = term;
      }
    });
    return { binding, firstCount };
  }

  private groupAggregateBindings(
    bindings: RdfBindingRow[],
    groupBy: string[],
    aggregates: RdfQueryAggregate[],
  ): RdfBindingRow[] {
    const groups = new Map<string, RdfBindingRow[]>();
    for (const binding of bindings) {
      const groupKey = groupBy.map((variableName) => {
        const term = binding[variableName];
        return term ? termToId(term as any) : '__UNBOUND__';
      }).join('\u001f');
      const existing = groups.get(groupKey);
      if (existing) {
        existing.push(binding);
      } else {
        groups.set(groupKey, [binding]);
      }
    }

    return [...groups.values()].map((groupBindings) => {
      const first = groupBindings[0];
      const grouped: RdfBindingRow = {};
      for (const variableName of groupBy) {
        if (first[variableName]) {
          grouped[variableName] = first[variableName];
        }
      }
      for (const aggregate of aggregates) {
        const term = this.aggregateLiteral(groupBindings, aggregate);
        if (term) {
          grouped[aggregate.as] = term;
        }
      }
      return grouped;
    });
  }

  private aggregateLiteral(bindings: RdfBindingRow[], aggregate: RdfQueryAggregate): Term | undefined {
    if (aggregate.type === 'count') {
      return countLiteral(this.countBindings(bindings, aggregate.variable, aggregate.distinct));
    }
    const values = this.numericAggregateValues(bindings, aggregate.variable, aggregate.distinct);
    if (values.length === 0) {
      return aggregate.type === 'sum' ? decimalLiteral(0) : undefined;
    }
    switch (aggregate.type) {
      case 'sum':
        return decimalLiteral(values.reduce((total, value) => total + value, 0));
      case 'avg':
        return decimalLiteral(values.reduce((total, value) => total + value, 0) / values.length);
      case 'min':
        return decimalLiteral(Math.min(...values));
      case 'max':
        return decimalLiteral(Math.max(...values));
      default: {
        const exhaustive: never = aggregate.type;
        throw new Error(`Unsupported RDF local aggregate type: ${exhaustive}`);
      }
    }
  }

  private numericAggregateValues(bindings: RdfBindingRow[], variable?: string, distinct?: boolean): number[] {
    if (!variable) {
      return [];
    }
    const values: number[] = [];
    const seen = new Set<string>();
    for (const binding of bindings) {
      const term = binding[variable];
      if (!term || !isNumericTerm(term)) {
        continue;
      }
      if (distinct) {
        const key = termToId(term as any);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
      }
      values.push(rdfNumericValue(term.value));
    }
    return values;
  }

  private compilePushdownFilter(variableName: string, filters: RdfQueryFilter[]): QuintPattern[keyof QuintPattern] | null {
    return this.compilePushdownFilterWithIndexes(variableName, filters)?.pattern ?? null;
  }

  private compilePushdownFilterWithIndexes(
    variableName: string,
    filters: RdfQueryFilter[],
  ): { pattern: QuintPattern[keyof QuintPattern]; filterIndexes: number[] } | null {
    const pushable = filters
      .map((filter, index) => ({ filter, index }))
      .filter(({ filter }) => (
        filter.variable === variableName
          && isPushdownFilter(filter)
      ));
    if (pushable.length === 0) {
      return null;
    }
    const operators: Record<string, unknown> = {};
    const filterIndexes: number[] = [];
    for (const { filter, index } of pushable) {
      switch (filter.operator) {
      case '$eq':
      case '$ne':
        if (filter.value === undefined) return null;
        if (!isTerm(filter.value as any)) return null;
        operators[filter.operator] = filter.value;
        filterIndexes.push(index);
        break;
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte':
        if (filter.value === undefined) return null;
        operators[filter.operator] = filter.value;
        filterIndexes.push(index);
        break;
      case '$in':
      case '$notIn':
        if (!filter.values || filter.values.length === 0) return null;
        if (filter.values.some((value) => !isTerm(value as any))) return null;
        operators[filter.operator] = filter.values;
        filterIndexes.push(index);
        break;
      case '$sameTerm':
        if (filter.variable2 || filter.value === undefined) return null;
        if (!isTerm(filter.value as any)) return null;
        operators.$eq = filter.value;
        filterIndexes.push(index);
        break;
      case '$termType':
        if (typeof filter.value !== 'string') return null;
        if (!['iri', 'blank', 'literal', 'numeric'].includes(filter.value)) return null;
        operators.$termType = filter.value;
        filterIndexes.push(index);
        break;
      case '$lang':
        if (typeof filter.value !== 'string') return null;
        operators.$language = filter.value;
        filterIndexes.push(index);
        break;
      case '$notLang':
        if (typeof filter.value !== 'string') return null;
        operators.$notLanguage = filter.value;
        filterIndexes.push(index);
        break;
      case '$langMatches':
        if (typeof filter.value !== 'string') return null;
        operators.$langMatches = filter.value;
        filterIndexes.push(index);
        break;
      case '$datatype':
        if (filter.value === undefined || !isTerm(filter.value as any)) return null;
        if ((filter.value as Term).termType !== 'NamedNode') return null;
        operators.$datatype = filter.value;
        filterIndexes.push(index);
        break;
      case '$notDatatype':
        if (filter.value === undefined || !isTerm(filter.value as any)) return null;
        if ((filter.value as Term).termType !== 'NamedNode') return null;
        operators.$notDatatype = filter.value;
        filterIndexes.push(index);
        break;
      case '$startsWith':
        if (typeof filter.value !== 'string') return null;
        operators.$startsWith = filter.value;
        filterIndexes.push(index);
        break;
      case '$contains':
      case '$endsWith':
        if (typeof filter.value !== 'string') return null;
        operators[filter.operator] = filter.value;
        filterIndexes.push(index);
        break;
      case '$regex':
        if (typeof filter.value !== 'string') return null;
        if (filter.flags) return null;
        operators.$regex = filter.value;
        filterIndexes.push(index);
        break;
      default:
        return null;
      }
    }
    return Object.keys(operators).length > 0
      ? { pattern: operators as any, filterIndexes }
      : null;
  }

  private matchesNewlyBoundFilters(
    binding: RdfBindingRow,
    previousBinding: RdfBindingRow,
    filters: RdfQueryFilter[],
  ): boolean {
    const newlyBound = filters.filter((filter) => {
      const variables = filterVariables(filter);
      return variables.every((variableName) => binding[variableName])
        && variables.some((variableName) => !previousBinding[variableName]);
    });
    return this.matchesFilters(binding, newlyBound);
  }

  private matchesFilters(binding: RdfBindingRow, filters: RdfQueryFilter[]): boolean {
    return filters.every((filter) => this.matchesFilter(binding, filter));
  }

  private matchesFilter(binding: RdfBindingRow, filter: RdfQueryFilter): boolean {
    const value = binding[filter.variable];
    if (filter.operator === '$bound') {
      return Boolean(filter.value) ? Boolean(value) : !value;
    }
    if (!value) {
      return false;
    }
    const comparisonValue = filterOperandValue(value, filter.operand);

    switch (filter.operator) {
      case '$eq':
        if (filter.variable2) return this.compareVariableFilter(binding, comparisonValue, filter, (comparison) => comparison === 0);
        return filter.value !== undefined && sameTermOrLexical(comparisonValue, filter.value);
      case '$ne':
        if (filter.variable2) return this.compareVariableFilter(binding, comparisonValue, filter, (comparison) => comparison !== 0);
        return filter.value === undefined || !sameTermOrLexical(comparisonValue, filter.value);
      case '$gt':
        if (filter.variable2) return this.compareVariableFilter(binding, comparisonValue, filter, (comparison) => comparison > 0);
        return compareTermsForFilter(comparisonValue, filter.value) > 0;
      case '$gte':
        if (filter.variable2) return this.compareVariableFilter(binding, comparisonValue, filter, (comparison) => comparison >= 0);
        return compareTermsForFilter(comparisonValue, filter.value) >= 0;
      case '$lt':
        if (filter.variable2) return this.compareVariableFilter(binding, comparisonValue, filter, (comparison) => comparison < 0);
        return compareTermsForFilter(comparisonValue, filter.value) < 0;
      case '$lte':
        if (filter.variable2) return this.compareVariableFilter(binding, comparisonValue, filter, (comparison) => comparison <= 0);
        return compareTermsForFilter(comparisonValue, filter.value) <= 0;
      case '$in':
        return (filter.values ?? []).some((candidate) => sameTermOrLexical(comparisonValue, candidate));
      case '$notIn':
        return !(filter.values ?? []).some((candidate) => sameTermOrLexical(comparisonValue, candidate));
      case '$startsWith': {
        const text = filterStringValue(value, comparisonValue);
        return typeof filter.value === 'string' && text.startsWith(filter.value);
      }
      case '$contains': {
        const text = filterStringValue(value, comparisonValue);
        return typeof filter.value === 'string' && text.includes(filter.value);
      }
      case '$endsWith': {
        const text = filterStringValue(value, comparisonValue);
        return typeof filter.value === 'string' && text.endsWith(filter.value);
      }
      case '$regex': {
        const text = filterStringValue(value, comparisonValue);
        return typeof filter.value === 'string' && new RegExp(filter.value, filter.flags).test(text);
      }
      case '$termType':
        return typeof filter.value === 'string' && matchesTermType(value, filter.value);
      case '$sameTerm': {
        const right = filter.variable2 ? binding[filter.variable2] : filter.value;
        return Boolean(right && isTerm(right as any) && sameTerm(value, right as Term));
      }
      case '$lang':
        return typeof filter.value === 'string'
          && value.termType === 'Literal'
          && value.language === filter.value;
      case '$notLang':
        return typeof filter.value === 'string'
          && value.termType === 'Literal'
          && value.language !== filter.value;
      case '$langMatches':
        return typeof filter.value === 'string'
          && value.termType === 'Literal'
          && langMatches(value.language, filter.value);
      case '$datatype':
        return filter.value !== undefined
          && value.termType === 'Literal'
          && sameTermOrLexical(value.datatype, filter.value);
      case '$notDatatype':
        return filter.value !== undefined
          && value.termType === 'Literal'
          && !sameTermOrLexical(value.datatype, filter.value);
      default: {
        const exhaustive: never = filter.operator;
        throw new Error(`Unsupported RDF local query filter operator: ${exhaustive}`);
      }
    }
  }

  private compareVariableFilter(
    binding: RdfBindingRow,
    comparisonValue: Term | number | string,
    filter: RdfQueryFilter,
    predicate: (comparison: number) => boolean,
  ): boolean {
    if (!filter.variable2) {
      return false;
    }
    const right = binding[filter.variable2];
    if (!right) {
      return false;
    }
    const rightValue = filterOperandValue(right, filter.operand);
    return predicate(compareFilterValues(comparisonValue, rightValue));
  }
}

export function variable(variableName: string): RdfQueryVariable {
  return { variable: variableName };
}

function isVariable(value: RdfQueryTermPattern | undefined): value is RdfQueryVariable {
  return Boolean(value && typeof value === 'object' && 'variable' in value);
}

function variablesInPattern(pattern: RdfQueryPattern): string[] {
  return TERM_KEYS
    .map((key) => pattern[key])
    .filter(isVariable)
    .map((value) => value.variable);
}

function patternHasRepeatedVariables(pattern: RdfQueryPattern): boolean {
  const seen = new Set<string>();
  for (const variableName of variablesInPattern(pattern)) {
    if (seen.has(variableName)) {
      return true;
    }
    seen.add(variableName);
  }
  return false;
}

function variablesSharedAcrossPatterns(patterns: RdfQueryPattern[]): Set<string> {
  const counts = new Map<string, number>();
  for (const pattern of patterns) {
    for (const variableName of new Set(variablesInPattern(pattern))) {
      counts.set(variableName, (counts.get(variableName) ?? 0) + 1);
    }
  }
  return new Set([...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([variableName]) => variableName));
}

function hasSharedVariable(left: Set<string>, right: Set<string>): boolean {
  for (const variableName of left) {
    if (right.has(variableName)) {
      return true;
    }
  }
  return false;
}

function filterVariables(filter: RdfQueryFilter): string[] {
  return filter.variable2
    ? [filter.variable, filter.variable2]
    : [filter.variable];
}

function buildRequiredSources(patterns: RdfQueryPattern[], query: RdfLocalQuery): RequiredSource[] {
  const patternSources = patterns.map((pattern, originalIndex): PatternRequiredSource => ({
      kind: 'pattern',
      pattern,
      originalIndex,
    }));
  const remainingValues: RequiredSource[] = [];

  for (const [originalIndex, source] of (query.values ?? []).entries()) {
    const patternSource = patternSources.find((candidate) => (
      !candidate.tupleValues && canAttachTupleValuesToPattern(source, candidate.pattern)
    ));
    if (patternSource) {
      patternSource.tupleValues = source;
      continue;
    }
    remainingValues.push({
      kind: 'values',
      source,
      originalIndex,
    });
  }

  return [
    ...remainingValues,
    ...patternSources,
    ...(query.textSearch ?? []).map((pattern, originalIndex): RequiredSource => ({
      kind: 'text',
      pattern,
      originalIndex,
    })),
    ...(query.vectorSearch ?? []).map((pattern, originalIndex): RequiredSource => ({
      kind: 'vector',
      pattern,
      originalIndex,
    })),
  ];
}

function variablesInRequiredSource(source: RequiredSource): string[] {
  if (source.kind === 'pattern') {
    return uniqueStrings([
      ...variablesInPattern(source.pattern),
      ...(source.tupleValues?.variables ?? []),
    ]);
  }
  if (source.kind === 'values') {
    return source.source.variables;
  }

  return [
    source.pattern.source,
    source.pattern.chunk,
    source.pattern.content,
    source.pattern.heading,
    source.pattern.score,
    source.kind === 'vector' ? source.pattern.distance : undefined,
    source.pattern.workspace,
    source.pattern.localPath,
    source.pattern.contentType,
    source.pattern.ordinal,
    source.pattern.level,
    source.pattern.startOffset,
    source.pattern.endOffset,
    source.kind === 'vector' ? source.pattern.model : undefined,
  ].filter((value): value is string => Boolean(value));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function filtersWithoutIndexes(filters: RdfQueryFilter[], indexes: number[]): RdfQueryFilter[] {
  if (indexes.length === 0) {
    return filters;
  }
  const pushedDown = new Set(indexes);
  return filters.filter((_filter, index) => !pushedDown.has(index));
}

function joinValuesSource(input: RdfBindingRow[], source: RdfValuesBindingSource): RdfBindingRow[] {
  const output: RdfBindingRow[] = [];
  for (const binding of input) {
    for (const row of source.rows) {
      const next = mergeTupleValuesBinding(binding, source.variables, row);
      if (next) {
        output.push(next);
      }
    }
  }
  return output;
}

function mergeBindingRows(left: RdfBindingRow, right: RdfBindingRow): RdfBindingRow | null {
  const next = { ...left };
  for (const [variableName, term] of Object.entries(right)) {
    const existing = next[variableName];
    if (existing && !sameTerm(existing, term)) {
      return null;
    }
    next[variableName] = term;
  }
  return next;
}

function mergeTupleValuesBinding(
  binding: RdfBindingRow,
  variables: string[],
  row: RdfBindingRow,
): RdfBindingRow | null {
  const next = { ...binding };
  for (const variableName of variables) {
    const value = row[variableName];
    if (!value) {
      continue;
    }
    const existing = next[variableName];
    if (existing && !sameTerm(existing, value)) {
      return null;
    }
    next[variableName] = value;
  }
  return next;
}

function canAttachTupleValuesToPattern(source: RdfValuesBindingSource, pattern: RdfQueryPattern): boolean {
  if (source.variables.length < 2 || source.rows.length === 0) {
    return false;
  }
  const slots = new Set<RdfQueryPatternKey>();
  for (const variableName of source.variables) {
    if (source.rows.some((row) => !row[variableName])) {
      return false;
    }
    const variableSlots = TERM_KEYS.filter((key) => {
      const value = pattern[key];
      return isVariable(value) && value.variable === variableName;
    });
    if (variableSlots.length !== 1) {
      return false;
    }
    slots.add(variableSlots[0]);
  }
  return slots.size === source.variables.length
    && source.rows.every((row) => source.variables.every((variableName) => Boolean(row[variableName])));
}

function tupleConstraintSourceForPattern(
  source: RdfValuesBindingSource,
  pattern: RdfQueryPattern,
): RdfQuadTupleConstraintSource {
  const columns = source.variables.map((variableName) => {
    const key = termKeyForVariable(pattern, variableName);
    if (!key) {
      throw new Error(`Tuple VALUES variable is not bound by pattern: ${variableName}`);
    }
    return key;
  });

  return {
    columns,
    rows: source.rows.map((row) => {
      const constraint: RdfQuadTupleConstraintSource['rows'][number] = {};
      source.variables.forEach((variableName, index) => {
        constraint[columns[index]] = row[variableName];
      });
      return constraint;
    }),
  };
}

function normalizeOptionalGroup(group: RdfQueryPattern[] | RdfOptionalQueryGroup): RdfOptionalQueryGroup {
  return Array.isArray(group) ? { patterns: group } : group;
}

function compiledPatternKey(pattern: QuintPattern): string {
  return TERM_KEYS
    .map((key) => `${key}:${termMatchKey(pattern[key])}`)
    .join('|');
}

function termMatchKey(match: QuintPattern[keyof QuintPattern] | undefined): string {
  if (!match) {
    return '*';
  }
  if (isTerm(match as any)) {
    return termToId(match as any);
  }
  return JSON.stringify(match, (_key, value) => isTerm(value as any) ? termToId(value as any) : value);
}

function termKeyForVariable(pattern: RdfQueryPattern, variableName: string): RdfQueryPatternKey | undefined {
  return TERM_KEYS.find((key) => {
    const value = pattern[key];
    return isVariable(value) && value.variable === variableName;
  });
}

function isConsistentPattern(pattern: QuintPattern): boolean {
  for (const key of TERM_KEYS) {
    const value = pattern[key];
    if (!value || isTerm(value as TermMatch)) {
      continue;
    }
  }
  return true;
}

function sameTerm(left: Term, right: Term): boolean {
  return termToId(left as any) === termToId(right as any);
}

function filterOperandValue(value: Term, operand: RdfQueryFilter['operand']): Term | number | string {
  switch (operand) {
    case 'stringLength':
      return value.value.length;
    case 'stringValue':
      return value.value;
    case 'lowerStringValue':
      return value.value.toLowerCase();
    case 'upperStringValue':
      return value.value.toUpperCase();
    default:
      return value;
  }
}

function filterStringValue(value: Term, comparisonValue: Term | number | string): string {
  return typeof comparisonValue === 'string' ? comparisonValue : value.value;
}

function sameTermOrLexical(left: Term | number | string, right: RdfQueryFilterValue): boolean {
  if (typeof left === 'number') {
    if (isNumericFilterValue(right)) {
      return left === rdfNumericValue(isTerm(right as any) ? (right as Term).value : String(right));
    }
    return String(left) === String(right);
  }
  if (typeof left === 'string') {
    return left === (isTerm(right as any) ? (right as Term).value : String(right));
  }
  return isTerm(right as any) ? sameTerm(left, right as Term) : left.value === String(right);
}

function compareTermsForFilter(left: Term | number | string, right: RdfQueryFilterValue | undefined): number {
  if (right === undefined) {
    return 1;
  }
  return compareFilterValues(left, isTerm(right as any) ? right as Term : right);
}

function compareFilterValues(left: Term | number | string, right: Term | number | string | boolean): number {
  if (typeof left === 'number') {
    if (isNumericFilterValue(right)) {
      return left - rdfNumericValue(isTerm(right as any) ? (right as Term).value : String(right));
    }
    return String(left).localeCompare(String(right));
  }
  if (typeof left === 'string') {
    const rightValue = isTerm(right as any) ? (right as Term).value : String(right);
    return left.localeCompare(rightValue);
  }
  if (isNumericTerm(left) && isNumericFilterValue(right)) {
    return rdfNumericValue(left.value) - rdfNumericValue(isTerm(right as any) ? (right as Term).value : String(right));
  }
  const rightValue = isTerm(right as any) ? (right as Term).value : String(right);
  return left.value.localeCompare(rightValue);
}

function matchesTermType(term: Term, expected: string): boolean {
  switch (expected) {
    case 'iri':
      return term.termType === 'NamedNode';
    case 'blank':
      return term.termType === 'BlankNode';
    case 'literal':
      return term.termType === 'Literal';
    case 'numeric':
      return isNumericTerm(term);
    default:
      return false;
  }
}

function langMatches(languageTag: string, languageRange: string): boolean {
  if (!languageTag) {
    return false;
  }
  if (languageRange === '*') {
    return true;
  }

  const normalizedTag = languageTag.toLowerCase();
  const normalizedRange = languageRange.toLowerCase();
  return normalizedTag === normalizedRange
    || normalizedTag.startsWith(`${normalizedRange}-`);
}

function isNumericFilterValue(value: RdfQueryFilterValue): boolean {
  return isTerm(value as any)
    ? isNumericTerm(value as Term)
    : (typeof value === 'number' || (typeof value === 'string' && isFiniteNumericLexical(value)));
}

function isNumericTerm(term: Term): boolean {
  return isRdfNumericTerm(term);
}

function isPushdownFilter(filter: RdfQueryFilter): boolean {
  if (isNumericGuardFilter(filter)) {
    return true;
  }
  if (filter.operand === 'stringLength') {
    return false;
  }
  if (filter.operand === 'lowerStringValue' || filter.operand === 'upperStringValue') {
    return false;
  }
  if (filter.operand === 'stringValue') {
    return filter.operator === '$startsWith'
      || filter.operator === '$contains'
      || filter.operator === '$endsWith'
      || filter.operator === '$regex';
  }
  return filter.operator === '$eq'
    || filter.operator === '$ne'
    || filter.operator === '$gt'
    || filter.operator === '$gte'
    || filter.operator === '$lt'
    || filter.operator === '$lte'
    || filter.operator === '$in'
    || filter.operator === '$notIn'
    || filter.operator === '$startsWith'
    || filter.operator === '$contains'
    || filter.operator === '$endsWith'
    || filter.operator === '$regex'
    || filter.operator === '$sameTerm'
    || filter.operator === '$termType'
    || filter.operator === '$lang'
    || filter.operator === '$notLang'
    || filter.operator === '$langMatches'
    || filter.operator === '$datatype'
    || filter.operator === '$notDatatype';
}

function isNumericGuardFilter(filter: RdfQueryFilter): boolean {
  return filter.operator === '$termType'
    && filter.value === 'numeric'
    && !filter.variable2
    && !filter.operand;
}

function isGroupAggregateHavingOperator(
  operator: RdfQueryFilter['operator'],
): operator is RdfQuadJoinGroupAggregateHaving['operator'] {
  return operator === '$eq'
    || operator === '$ne'
    || operator === '$gt'
    || operator === '$gte'
    || operator === '$lt'
    || operator === '$lte';
}

function filterValueToNumber(value: RdfQueryFilterValue): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    return isFiniteNumericLexical(value) ? rdfNumericValue(value) : undefined;
  }
  if (isTerm(value as any) && isNumericTerm(value as Term)) {
    return rdfNumericValue((value as Term).value);
  }
  return undefined;
}

function projectBinding(binding: RdfBindingRow, select: string[]): RdfBindingRow {
  const projected: RdfBindingRow = {};
  for (const variableName of select) {
    const value = binding[variableName];
    if (value) {
      projected[variableName] = value;
    }
  }
  return projected;
}

function compareBindings(
  left: RdfBindingRow,
  right: RdfBindingRow,
  orderBy: NonNullable<RdfLocalQuery['orderBy']>,
): number {
  for (const order of orderBy) {
    const leftValue = left[order.variable] ? termToId(left[order.variable] as any) : '';
    const rightValue = right[order.variable] ? termToId(right[order.variable] as any) : '';
    const comparison = leftValue.localeCompare(rightValue);
    if (comparison !== 0) {
      return order.direction === 'desc' ? -comparison : comparison;
    }
  }
  return 0;
}

function bindingKey(binding: RdfBindingRow): string {
  return Object.keys(binding)
    .sort()
    .map((key) => `${key}=${termToId(binding[key] as any)}`)
    .join('\u001f');
}

function distinctBindings(bindings: RdfBindingRow[]): RdfBindingRow[] {
  const seen = new Set<string>();
  const unique: RdfBindingRow[] = [];
  for (const binding of bindings) {
    const key = bindingKey(binding);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(binding);
  }
  return unique;
}

function integerLiteral(value: number): Term {
  return DataFactory.literal(
    String(value),
    DataFactory.namedNode(XSD_INTEGER),
  ) as Term;
}

function countLiteral(count: number): Term {
  return integerLiteral(count);
}

function finiteBindNumber(term: Term): number | undefined {
  if (term.termType !== 'Literal') {
    return undefined;
  }
  const value = Number(term.value);
  return Number.isFinite(value) ? value : undefined;
}

function decimalLiteral(value: number): Term {
  return DataFactory.literal(
    String(value),
    DataFactory.namedNode(XSD_DECIMAL),
  ) as Term;
}

function describePattern(pattern: RdfQueryPattern): string {
  return TERM_KEYS
    .filter((key) => pattern[key])
    .map((key) => `${key}:${describePatternValue(pattern[key])}`)
    .join(',');
}

function describePatternSource(source: { pattern: QuintPattern; variables: Partial<Record<RdfQueryPatternKey, string>> }): string {
  return TERM_KEYS
    .map((key) => {
      const variableName = source.variables[key];
      if (variableName) {
        return `${key}:?${variableName}`;
      }
      const value = source.pattern[key];
      return value ? `${key}:${termMatchKey(value)}` : undefined;
    })
    .filter(Boolean)
    .join(',');
}

function describePatternValue(value: RdfQueryTermPattern | undefined): string {
  if (!value) return '*';
  if (isVariable(value)) return `?${value.variable}`;
  if (isTerm(value as TermMatch)) return termToId(value as any);
  return 'op';
}

function describeFilter(filter: RdfQueryFilter): string {
  return `?${filter.variable}${filter.operand ? `:${filter.operand}` : ''}${filter.operator}`;
}

function describeTextSearch(pattern: RdfTextSearchPattern): string {
  const bindings = [
    pattern.source ? `source:?${pattern.source}` : undefined,
    pattern.chunk ? `chunk:?${pattern.chunk}` : undefined,
    pattern.content ? `content:?${pattern.content}` : undefined,
    pattern.heading ? `heading:?${pattern.heading}` : undefined,
    pattern.score ? `score:?${pattern.score}` : undefined,
  ].filter(Boolean).join(',');
  const scope = pattern.scope?.workspace
    ? `workspace:${pattern.scope.workspace}`
    : pattern.scope?.sourcePrefix
    ? `prefix:${pattern.scope.sourcePrefix}`
    : '*';
  const window = describeSearchWindow(pattern.limit, pattern.offset);
  const order = describeSearchOrder(pattern.orderBy);
  return `${JSON.stringify(pattern.query)}@${scope}${bindings ? ` ${bindings}` : ''}${window}${order}`;
}

function describeVectorSearch(pattern: RdfVectorSearchPattern): string {
  const bindings = [
    pattern.source ? `source:?${pattern.source}` : undefined,
    pattern.chunk ? `chunk:?${pattern.chunk}` : undefined,
    pattern.content ? `content:?${pattern.content}` : undefined,
    pattern.heading ? `heading:?${pattern.heading}` : undefined,
    pattern.score ? `score:?${pattern.score}` : undefined,
    pattern.distance ? `distance:?${pattern.distance}` : undefined,
  ].filter(Boolean).join(',');
  const scope = pattern.scope?.workspace
    ? `workspace:${pattern.scope.workspace}`
    : pattern.scope?.sourcePrefix
    ? `prefix:${pattern.scope.sourcePrefix}`
    : '*';
  const metric = pattern.metric ?? 'cosine';
  const window = describeSearchWindow(pattern.limit, pattern.offset);
  const order = describeSearchOrder(pattern.orderBy);
  return `${metric}:${pattern.embedding.length}d@${scope}${bindings ? ` ${bindings}` : ''}${window}${order}`;
}

function describeSearchWindow(limit?: number, offset?: number): string {
  const parts = [
    limit !== undefined ? `limit:${Math.max(0, limit)}` : undefined,
    offset !== undefined ? `offset:${Math.max(0, offset)}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? ` ${parts.join(',')}` : '';
}

function hasSearchWindow(source: TextRequiredSource | VectorRequiredSource): boolean {
  return source.pattern.limit !== undefined || source.pattern.offset !== undefined;
}

function describeSearchOrder(orderBy: Array<{ field: string; direction?: 'asc' | 'desc' }> | undefined): string {
  if (!orderBy?.length) {
    return '';
  }
  return ` order:${orderBy.map((entry) => `${entry.field}:${entry.direction ?? 'asc'}`).join(',')}`;
}

function describeBind(bind: RdfQueryBind): string {
  return `?${bind.variable}:=${describeBindExpression(bind.expression)}`;
}

function describeBindExpression(expression: RdfBindExpression): string {
  switch (expression.type) {
    case 'term':
      if (expression.term.termType === 'Literal' && isFiniteNumericLexical(expression.term.value)) {
        return expression.term.value;
      }
      return termToId(expression.term as any);
    case 'variable':
      return `?${expression.variable}`;
    case 'stringValue':
      return `STR(?${expression.variable})`;
    case 'stringLength':
      return `STRLEN(?${expression.variable})`;
    case 'lowerCase':
      return `LCASE(${describeBindExpression(expression.expression)})`;
    case 'upperCase':
      return `UCASE(${describeBindExpression(expression.expression)})`;
    case 'substring':
      return `SUBSTR(${[
        describeBindExpression(expression.expression),
        describeBindExpression(expression.start),
        expression.length === undefined ? undefined : describeBindExpression(expression.length),
      ].filter(Boolean).join(',')})`;
    case 'concat':
      return `CONCAT(${expression.expressions.map(describeBindExpression).join(',')})`;
    case 'iri':
      return `IRI(${describeBindExpression(expression.expression)})`;
    default: {
      const exhaustive: never = expression;
      return JSON.stringify(exhaustive);
    }
  }
}

function describeScanOrder(options: RdfQuadScanOptions): string {
  const order = options.order ?? [];
  const directions = options.orderDirections ?? order.map(() => (options.reverse ? 'desc' : 'asc'));
  const firstDirection = directions[0] ?? 'asc';
  const sameDirection = directions.every((direction) => direction === firstDirection);
  if (sameDirection) {
    return `${firstDirection}:${order.join(',')}`;
  }
  return order.map((entry, index) => `${directions[index] ?? 'asc'}:${entry}`).join(',');
}

function describeQueryOrder(orderBy: NonNullable<RdfLocalQuery['orderBy']>): string {
  return orderBy.map((entry) => `${entry.direction ?? 'asc'}:${entry.variable}`).join(',');
}

function storagePlanMarkers(queryPlan: string[] | undefined): string[] {
  return (queryPlan ?? []).filter((entry) => (
    entry.startsWith('TextSearch(')
      || entry.startsWith('Rdf3x')
      || entry === 'GraphMembershipFilter'
      || entry === 'GraphPrefixMembershipFilter'
      || entry.startsWith('LexicalRange(')
      || entry.startsWith('NumericRange(')
      || entry.startsWith('PrefixRange(')
      || entry.startsWith('TermIn(')
      || entry.startsWith('TermNotIn(')
      || entry.startsWith('TermType(')
      || entry.startsWith('Language(')
      || entry.startsWith('Datatype(')
      || entry.startsWith('TupleValuesJoin(')
      || entry.startsWith('JoinBGP(')
      || entry.startsWith('JoinOrder(')
      || entry.startsWith('JoinDistinct(')
      || entry.startsWith('JoinLimit')
      || entry.startsWith('JoinGroupCountHaving(')
      || entry.startsWith('JoinGroupAggregateHaving(')
      || entry.startsWith('JoinGroupAggregateNumeric(')
  ));
}

function requiredSourceScanPlan(backend: PatternScanBackend): 'IndexScan' | 'Rdf3xPrimaryScan' | 'MixedScan' {
  switch (backend) {
    case 'rdf3x':
      return 'Rdf3xPrimaryScan';
    case 'mixed':
      return 'MixedScan';
    case 'index':
    case 'none':
      return 'IndexScan';
    default: {
      const exhaustive: never = backend;
      throw new Error(`Unsupported RDF required source scan backend: ${exhaustive}`);
    }
  }
}

function scanPlanOrder(plan: ReturnType<typeof requiredSourceScanPlan>): 'IndexOrder' | 'Rdf3xPrimaryOrder' | 'MixedOrder' {
  switch (plan) {
    case 'Rdf3xPrimaryScan':
      return 'Rdf3xPrimaryOrder';
    case 'MixedScan':
      return 'MixedOrder';
    case 'IndexScan':
      return 'IndexOrder';
    default: {
      const exhaustive: never = plan;
      throw new Error(`Unsupported RDF scan plan for order marker: ${exhaustive}`);
    }
  }
}

function scanPlanLimit(plan: ReturnType<typeof requiredSourceScanPlan>): 'IndexLimit' | 'Rdf3xPrimaryLimit' | 'MixedLimit' {
  switch (plan) {
    case 'Rdf3xPrimaryScan':
      return 'Rdf3xPrimaryLimit';
    case 'MixedScan':
      return 'MixedLimit';
    case 'IndexScan':
      return 'IndexLimit';
    default: {
      const exhaustive: never = plan;
      throw new Error(`Unsupported RDF scan plan for limit marker: ${exhaustive}`);
    }
  }
}

function toRdf3xScanOptions(options?: RdfQuadScanOptions): Rdf3xTripleScanOptions | undefined {
  if (!options) {
    return undefined;
  }
  return {
    ...(options.order ? { order: options.order } : {}),
    ...(options.orderDirections ? { orderDirections: options.orderDirections } : {}),
    ...(options.reverse ? { reverse: true } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
  };
}

function toRdf3xTriplePattern(pattern: QuintPattern): Rdf3xTriplePattern {
  const result: Rdf3xTriplePattern = {};
  for (const key of TERM_KEYS) {
    const value = pattern[key];
    if (!value) {
      continue;
    }
    if (isTerm(value as any)) {
      result[key] = value as Term;
      continue;
    }
    if (key === 'graph' && isGraphPrefixPattern(value)) {
      result.graph = value;
      continue;
    }
    if (key === 'object' && isRdf3xObjectRangePattern(value)) {
      result.object = value;
      continue;
    }
    throw new Error(`RDF-3X primary scan cannot compile unsupported ${key} pattern`);
  }
  return result;
}

function stripRdf3xNumericAggregateGuards(
  patterns: CompiledJoinPattern[],
  aggregates: RdfQueryAggregate[],
): CompiledJoinPattern[] {
  const numericVariables = new Set(aggregates
    .filter((aggregate) => aggregate.type !== 'count')
    .map((aggregate) => aggregate.variable)
    .filter((variableName): variableName is string => Boolean(variableName)));
  if (numericVariables.size === 0) {
    return patterns;
  }

  return patterns.map((entry) => {
    let changed = false;
    const pattern: CompiledPattern = {
      ...entry.pattern,
      pushedDownFilters: entry.pattern.pushedDownFilters,
      pushedDownFilterIndexes: [...entry.pattern.pushedDownFilterIndexes],
    };

    for (const key of TERM_KEYS) {
      const variableName = entry.variables[key];
      if (!variableName || !numericVariables.has(variableName)) {
        continue;
      }
      const value = pattern[key];
      if (!value || isTerm(value as any) || typeof value !== 'object') {
        continue;
      }
      if ((value as { $termType?: unknown }).$termType !== 'numeric') {
        continue;
      }

      const stripped = { ...(value as Record<string, unknown>) };
      delete stripped.$termType;
      if (Object.keys(stripped).length === 0) {
        delete pattern[key];
      } else {
        pattern[key] = stripped as TermMatch;
      }
      changed = true;
    }

    return changed ? { pattern, variables: entry.variables } : entry;
  });
}

function isRdf3xCompatiblePattern(pattern: QuintPattern): boolean {
  return TERM_KEYS.every((key) => {
    const value = pattern[key];
    if (!value || isTerm(value as any)) {
      return true;
    }
    if (key === 'graph' && isGraphPrefixPattern(value)) {
      return true;
    }
    if (key === 'object' && isRdf3xObjectRangePattern(value)) {
      return true;
    }
    return false;
  });
}

function isGraphPrefixPattern(value: unknown): value is { $startsWith: string } {
  return value !== null
    && typeof value === 'object'
    && Object.keys(value).length === 1
    && '$startsWith' in value
    && typeof (value as { $startsWith?: unknown }).$startsWith === 'string';
}

function isRdf3xObjectRangePattern(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || 'termType' in value) {
    return false;
  }
  const operators = ['$gt', '$gte', '$lt', '$lte'] as const;
  if (Object.keys(value).some((key) => !operators.includes(key as typeof operators[number]))) {
    return false;
  }
  let hasRange = false;
  for (const operator of operators) {
    const rangeValue = (value as Record<string, unknown>)[operator];
    if (rangeValue === undefined) {
      continue;
    }
    hasRange = true;
    if (!isRdf3xObjectRangeValue(rangeValue)) {
      return false;
    }
  }
  return hasRange;
}

function isRdf3xObjectRangeValue(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'string') {
    return true;
  }
  if (isTerm(value as any)) {
    return true;
  }
  return false;
}

function bindTextSearchResult(
  binding: RdfBindingRow,
  pattern: RdfTextSearchPattern,
  result: RdfTextSearchResult,
): RdfBindingRow | null {
  const next = { ...binding };
  const chunkResource = `${result.source}#chunk-${encodeURIComponent(result.chunkKey)}`;
  const candidates: Array<[string | undefined, Term | undefined]> = [
    [pattern.source, DataFactory.namedNode(result.source) as Term],
    [pattern.chunk, DataFactory.namedNode(chunkResource) as Term],
    [pattern.content, DataFactory.literal(result.content) as Term],
    [pattern.heading, result.heading ? DataFactory.literal(result.heading) as Term : undefined],
    [pattern.score, decimalLiteral(result.score)],
    [pattern.workspace, DataFactory.namedNode(result.workspace) as Term],
    [pattern.localPath, result.localPath ? DataFactory.literal(result.localPath) as Term : undefined],
    [pattern.contentType, result.contentType ? DataFactory.literal(result.contentType) as Term : undefined],
    [pattern.ordinal, integerLiteral(result.ordinal)],
    [pattern.level, integerLiteral(result.level)],
    [pattern.startOffset, integerLiteral(result.startOffset)],
    [pattern.endOffset, integerLiteral(result.endOffset)],
  ];

  for (const [variableName, term] of candidates) {
    if (!variableName || !term) {
      continue;
    }
    const existing = next[variableName];
    if (existing && !sameTerm(existing, term)) {
      return null;
    }
    next[variableName] = term;
  }
  return next;
}

function bindVectorSearchResult(
  binding: RdfBindingRow,
  pattern: RdfVectorSearchPattern,
  result: RdfVectorSearchResult,
): RdfBindingRow | null {
  const next = { ...binding };
  const chunkResource = `${result.source}#chunk-${encodeURIComponent(result.chunkKey)}`;
  const candidates: Array<[string | undefined, Term | undefined]> = [
    [pattern.source, DataFactory.namedNode(result.source) as Term],
    [pattern.chunk, DataFactory.namedNode(chunkResource) as Term],
    [pattern.content, DataFactory.literal(result.content) as Term],
    [pattern.heading, result.heading ? DataFactory.literal(result.heading) as Term : undefined],
    [pattern.score, decimalLiteral(result.score)],
    [pattern.distance, decimalLiteral(result.distance)],
    [pattern.workspace, DataFactory.namedNode(result.workspace) as Term],
    [pattern.localPath, result.localPath ? DataFactory.literal(result.localPath) as Term : undefined],
    [pattern.contentType, result.contentType ? DataFactory.literal(result.contentType) as Term : undefined],
    [pattern.ordinal, integerLiteral(result.ordinal)],
    [pattern.level, integerLiteral(result.level)],
    [pattern.startOffset, integerLiteral(result.startOffset)],
    [pattern.endOffset, integerLiteral(result.endOffset)],
    [pattern.model, result.model ? DataFactory.literal(result.model) as Term : undefined],
  ];

  for (const [variableName, term] of candidates) {
    if (!variableName || !term) {
      continue;
    }
    const existing = next[variableName];
    if (existing && !sameTerm(existing, term)) {
      return null;
    }
    next[variableName] = term;
  }
  return next;
}

function queryAggregates(query: RdfLocalQuery): RdfQueryAggregate[] {
  return query.aggregates ?? (query.aggregate ? [query.aggregate] : []);
}

function aggregatePlan(aggregates: RdfQueryAggregate[], grouped: boolean): string {
  if (aggregates.some((aggregate) => aggregate.type !== 'count')) {
    const prefix = grouped ? 'group-' : '';
    const suffix = aggregates.length > 1 ? '-multi' : '';
    return `Aggregate(${prefix}basic${suffix})`;
  }
  if (aggregates.length === 1) {
    const aggregate = aggregates[0];
    if (grouped) {
      return aggregate.distinct ? 'Aggregate(group-count-distinct)' : 'Aggregate(group-count)';
    }
    return aggregate.distinct ? 'Aggregate(count-distinct)' : 'Aggregate(count)';
  }
  if (grouped) {
    return aggregates.some((aggregate) => aggregate.distinct)
      ? 'Aggregate(group-count-multi-distinct)'
      : 'Aggregate(group-count-multi)';
  }
  return aggregates.some((aggregate) => aggregate.distinct)
    ? 'Aggregate(count-multi-distinct)'
    : 'Aggregate(count-multi)';
}
