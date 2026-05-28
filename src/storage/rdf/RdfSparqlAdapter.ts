import { DataFactory, termToId } from 'n3';
import { Parser, Wildcard } from 'sparqljs';
import type {
  AggregateExpression,
  BindPattern,
  BgpPattern,
  ConstructQuery,
  DescribeQuery,
  Expression,
  FilterPattern,
  FunctionCallExpression,
  GraphPattern,
  GraphQuads,
  Grouping,
  IriTerm,
  LiteralTerm,
  MinusPattern,
  OperationExpression,
  Ordering,
  Pattern,
  PropertyPath,
  SelectQuery,
  SparqlQuery,
  Term as SparqlTerm,
  Triple,
  Update,
  ValuePatternRow,
  ValuesPattern,
  Variable,
  VariableExpression,
  VariableTerm,
} from 'sparqljs';
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import type {
  RdfBindExpression,
  RdfLocalQuery,
  RdfBindingRow,
  RdfConstructTemplate,
  RdfQueryFilter,
  RdfQueryFilterOperator,
  RdfQueryFilterValue,
  RdfQueryAggregate,
  RdfQueryBind,
  RdfQueryPattern,
  RdfQueryTermPattern,
  RdfUnionQueryGroup,
  RdfValuesBindingSource,
  RdfUnionQueryBranch,
  RdfMinusQueryGroup,
  RdfExistsQueryGroup,
  RdfOptionalQueryGroup,
} from './types';
import { variable as rdfVar } from './RdfLocalQueryEngine';

const PATH_JOIN_VARIABLE_PREFIX = '__rdf_path';
const XPATH_FUNCTION_NS = 'http://www.w3.org/2005/xpath-functions#';

interface FixedPathSegment {
  predicates: IriTerm[];
  inverse: boolean;
}

interface FixedAlternativePath {
  predicates: IriTerm[];
  inverse: boolean;
}

interface RdfUpdateDatasetScope {
  hasUsing: boolean;
  defaultGraph?: RdfQueryTermPattern;
  namedGraph?: RdfQueryTermPattern;
}

interface RdfQueryDatasetScope {
  defaultGraph?: RdfQueryTermPattern;
  namedGraph?: RdfQueryTermPattern;
}

interface RdfQueryFromClause {
  default?: IriTerm[];
  named?: IriTerm[];
}

interface OptionalFrame {
  patterns: RdfQueryPattern[];
  filters: RdfQueryFilter[];
  binds: RdfQueryBind[];
  unions: RdfUnionQueryGroup[];
  values: RdfValuesBindingSource[];
  optional: RdfOptionalQueryGroup[];
  minus: RdfMinusQueryGroup[];
  exists: RdfExistsQueryGroup[];
}

interface RdfUpdateTemplateOptions {
  graphVariables?: ReadonlySet<string>;
}

interface RdfQueryGraphScope {
  patterns: RdfQueryPattern[];
  filters?: RdfQueryFilter[];
  optional?: RdfLocalQuery['optional'];
  unions?: RdfLocalQuery['unions'];
  minus?: RdfLocalQuery['minus'];
  exists?: RdfLocalQuery['exists'];
}

export interface RdfSparqlCompileResult {
  query: RdfLocalQuery;
  variables: string[];
  queryType: 'SELECT' | 'ASK' | 'CONSTRUCT' | 'DESCRIBE';
  constructTemplate?: RdfConstructTemplate[];
  describeTargets?: RdfQueryTermPattern[];
}

export interface RdfSparqlInsertOperation {
  type: 'insert';
  quads: Quad[];
}

export interface RdfSparqlDeleteOperation {
  type: 'delete';
  quads: Quad[];
}

export interface RdfSparqlDeleteWhereTemplate {
  graph: RdfQueryTermPattern;
  subject: RdfQueryTermPattern;
  predicate: RdfQueryTermPattern;
  object: RdfQueryTermPattern;
}

export type RdfSparqlUpdateTemplate = RdfSparqlDeleteWhereTemplate;

export interface RdfSparqlDeleteWhereOperation {
  type: 'deleteWhere';
  query: RdfLocalQuery;
  template: RdfSparqlUpdateTemplate[];
}

export interface RdfSparqlInsertDeleteWhereOperation {
  type: 'insertDeleteWhere';
  query: RdfLocalQuery;
  deletes: RdfSparqlUpdateTemplate[];
  inserts: RdfSparqlUpdateTemplate[];
}

export interface RdfSparqlInsertWhereOperation {
  type: 'insertWhere';
  query: RdfLocalQuery;
  inserts: RdfSparqlUpdateTemplate[];
}

export type RdfSparqlUpdateDeltaOperation =
  | RdfSparqlInsertOperation
  | RdfSparqlDeleteOperation
  | RdfSparqlDeleteWhereOperation
  | RdfSparqlInsertDeleteWhereOperation
  | RdfSparqlInsertWhereOperation;

export interface RdfSparqlUpdateDelta {
  operations: RdfSparqlUpdateDeltaOperation[];
  inserts: Quad[];
  deletes: Quad[];
}

export interface RdfSparqlUpdateCompileOptions {
  defaultGraph?: string | NamedNode;
}

export class UnsupportedSparqlQueryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSparqlQueryError';
  }
}

export class DisabledSparqlFeatureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DisabledSparqlFeatureError';
  }
}

export class RdfSparqlAdapter {
  public compile(query: string | SparqlQuery, basePath: string): RdfSparqlCompileResult {
    const parsed = typeof query === 'string'
      ? new Parser({ baseIRI: basePath }).parse(query)
      : query;

    if (parsed.type === 'update') {
      throw new UnsupportedSparqlQueryError('SPARQL UPDATE is handled by the compatibility engine');
    }
    const datasetScope = this.compileQueryDatasetScope(this.queryFromClause(parsed), basePath);
    const state = new CompileState(basePath);
    this.compilePatterns(parsed.where ?? [], datasetScope.defaultGraph, state, false, datasetScope.namedGraph);
    this.compileValuesRows(parsed.values ?? [], state);
    this.compileGroupBy((parsed as SelectQuery).group ?? [], state);
    if (parsed.queryType === 'SELECT') {
      state.query.orderBy = this.compileOrder((parsed as SelectQuery).order ?? [], state);
    }
    const variables = parsed.queryType === 'SELECT'
      ? this.compileSelectVariables(parsed, state)
      : [];
    if (parsed.queryType === 'SELECT') {
      state.query.having = this.compileHaving((parsed as SelectQuery).having ?? [], state);
    }
    state.assertBindVariablesSafe();
    state.assertValuesVariablesBoundByRequiredPatterns();
    state.assertDependentGroupsShareRequiredVariables();

    const constructTemplate = parsed.queryType === 'CONSTRUCT'
      ? this.compileConstructTemplate(parsed)
      : undefined;
    const describeTargets = parsed.queryType === 'DESCRIBE'
      ? this.compileDescribeTargets(parsed, state.query)
      : undefined;

    if (parsed.queryType === 'ASK') {
      state.query.limit = 1;
    } else if (parsed.queryType === 'SELECT') {
      state.query.select = variables.length > 0 ? variables : undefined;
      state.query.distinct = Boolean((parsed as SelectQuery).distinct);
      state.query.limit = parsed.limit;
      state.query.offset = parsed.offset;
    }

    return {
      query: state.query,
      variables,
      queryType: parsed.queryType,
      constructTemplate,
      describeTargets,
    };
  }

  public compileUpdateDelta(
    query: string | SparqlQuery,
    basePath: string,
    options: RdfSparqlUpdateCompileOptions = {},
  ): RdfSparqlUpdateDelta {
    const parsed = typeof query === 'string'
      ? new Parser({ baseIRI: basePath }).parse(query)
      : query;

    if (parsed.type !== 'update') {
      throw new UnsupportedSparqlQueryError('Only SPARQL UPDATE can compile into update delta');
    }

    const defaultGraph = this.compileUpdateDefaultGraph(options.defaultGraph, basePath);
    const operations: RdfSparqlUpdateDeltaOperation[] = [];
    for (const update of (parsed as Update).updates) {
      if (!('updateType' in update)) {
        throw new UnsupportedSparqlQueryError('SPARQL UPDATE management operations fallback to compatibility engine');
      }

      switch (update.updateType) {
        case 'insert':
          if (update.graph) {
            throw new UnsupportedSparqlQueryError('SPARQL UPDATE WITH/default graph scope fallback to compatibility engine');
          }
          operations.push({
            type: 'insert',
            quads: this.compileUpdateGraphQuads(update.insert, basePath, defaultGraph),
          });
          break;
        case 'delete':
          if (update.graph) {
            throw new UnsupportedSparqlQueryError('SPARQL UPDATE WITH/default graph scope fallback to compatibility engine');
          }
          operations.push({
            type: 'delete',
            quads: this.compileUpdateGraphQuads(update.delete, basePath, defaultGraph),
          });
          break;
        case 'deletewhere':
          if (update.graph) {
            throw new UnsupportedSparqlQueryError('SPARQL UPDATE WITH/default graph scope fallback to compatibility engine');
          }
          operations.push(this.compileDeleteWhere(update.delete, basePath, defaultGraph));
          break;
        case 'insertdelete':
          operations.push(this.compileInsertDeleteWhere(update, basePath, defaultGraph));
          break;
        default:
          throw new UnsupportedSparqlQueryError('Unsupported SPARQL UPDATE operation fallback to compatibility engine');
      }
    }

    const inserts = operations
      .filter((operation) => operation.type === 'insert')
      .flatMap((operation) => operation.quads);
    const deletes = operations
      .filter((operation) => operation.type === 'delete')
      .flatMap((operation) => operation.quads);
    const deleteWhereCount = operations
      .reduce((sum, operation) => {
        if (operation.type === 'deleteWhere') {
          return sum + operation.template.length;
        }
        if (operation.type === 'insertDeleteWhere') {
          return sum + operation.deletes.length + operation.inserts.length;
        }
        if (operation.type === 'insertWhere') {
          return sum + operation.inserts.length;
        }
        return sum;
      }, 0);
    if (inserts.length + deletes.length + deleteWhereCount === 0) {
      throw new UnsupportedSparqlQueryError('SPARQL UPDATE without data quads fallback to compatibility engine');
    }

    return { operations, inserts, deletes };
  }

  private compileDeleteWhere(
    items: Array<GraphQuads | BgpPattern>,
    basePath: string,
    defaultGraph?: NamedNode,
  ): RdfSparqlDeleteWhereOperation {
    const template = this.compileGraphQuadsTemplate(items, basePath, 'DELETE WHERE', defaultGraph);
    return {
      type: 'deleteWhere',
      query: this.queryFromUpdateTemplate(template, 'DELETE WHERE'),
      template,
    };
  }

  private compileInsertDeleteWhere(
    update: Extract<Update['updates'][number], { updateType: 'insertdelete' }>,
    basePath: string,
    defaultGraph?: NamedNode,
  ): RdfSparqlInsertDeleteWhereOperation | RdfSparqlInsertWhereOperation | RdfSparqlDeleteWhereOperation {
    const hasInsertTemplate = (update.insert?.length ?? 0) > 0;
    const hasDeleteTemplate = (update.delete?.length ?? 0) > 0;
    if (!hasInsertTemplate && !hasDeleteTemplate) {
      throw new UnsupportedSparqlQueryError('DELETE/INSERT WHERE without DELETE or INSERT template fallback to compatibility engine');
    }
    const label = hasInsertTemplate && hasDeleteTemplate
      ? 'DELETE/INSERT WHERE'
      : hasInsertTemplate
      ? 'INSERT WHERE'
      : 'DELETE WHERE';
    const withGraph = this.compileWithGraph(update.graph, basePath, label) ?? defaultGraph;
    const using = this.compileUsingDatasetScope(update.using, basePath, label);
    const queryDefaultGraph = using.hasUsing
      ? using.defaultGraph ?? this.impossibleGraph(basePath)
      : withGraph;
    const queryNamedGraph = using.hasUsing
      ? using.namedGraph ?? this.impossibleGraph(basePath)
      : undefined;
    const query = this.queryFromUpdateWhere(update.where ?? [], basePath, label, {
      defaultGraph: queryDefaultGraph,
      namedGraph: queryNamedGraph,
    });
    const graphVariables = this.safeUpdateTemplateGraphVariables(query);
    const inserts = hasInsertTemplate
      ? this.compileGraphQuadsTemplate(update.insert ?? [], basePath, 'INSERT template', withGraph, { graphVariables })
      : [];
    if (hasInsertTemplate && inserts.length === 0) {
      throw new UnsupportedSparqlQueryError(`${label} without INSERT template fallback to compatibility engine`);
    }
    const deletes = hasDeleteTemplate
      ? this.compileGraphQuadsTemplate(update.delete ?? [], basePath, 'DELETE template', withGraph, { graphVariables })
      : [];
    if (hasDeleteTemplate && deletes.length === 0) {
      throw new UnsupportedSparqlQueryError(`${label} without DELETE template fallback to compatibility engine`);
    }
    if (hasInsertTemplate && !hasDeleteTemplate) {
      return {
        type: 'insertWhere',
        query,
        inserts,
      };
    }
    if (!hasInsertTemplate) {
      return {
        type: 'deleteWhere',
        query,
        template: deletes,
      };
    }
    return {
      type: 'insertDeleteWhere',
      query,
      deletes,
      inserts,
    };
  }

  private compileUsingDatasetScope(
    using: Extract<Update['updates'][number], { updateType: 'insertdelete' }>['using'],
    basePath: string,
    label: string,
  ): RdfUpdateDatasetScope {
    if (!using) {
      return { hasUsing: false };
    }

    const defaultGraphs = using.default ?? [];
    const namedGraphs = using.named ?? [];
    return {
      hasUsing: true,
      defaultGraph: this.compileUsingGraphs(defaultGraphs, basePath, label, 'USING'),
      namedGraph: this.compileUsingGraphs(namedGraphs, basePath, label, 'USING NAMED'),
    };
  }

  private compileUsingGraphs(
    graphs: IriTerm[],
    basePath: string,
    label: string,
    clause: string,
  ): RdfQueryTermPattern | undefined {
    if (graphs.length === 0) {
      return undefined;
    }
    const compiledGraphs: Term[] = graphs.map((graph) => {
      const compiled = this.compileGraphTerm(graph, basePath);
      if (compiled === null || isCompiledVariable(compiled)) {
        throw new UnsupportedSparqlQueryError(`${label} ${clause} graph outside basePath fallback to compatibility engine`);
      }
      return compiled as Term;
    });
    if (compiledGraphs.length === 1) {
      return compiledGraphs[0];
    }
    return { $in: uniqueTerms(compiledGraphs) };
  }

  private compileQueryDatasetScope(
    from: RdfQueryFromClause | undefined,
    basePath: string,
  ): RdfQueryDatasetScope {
    if (!from) {
      return {
        defaultGraph: this.compileImplicitQueryDefaultGraph(basePath),
      };
    }

    const defaultGraphs = from.default ?? [];
    const namedGraphs = from.named ?? [];
    return {
      defaultGraph: defaultGraphs.length > 0
        ? this.compileQueryDatasetGraphs(defaultGraphs, basePath, 'FROM')
        : namedGraphs.length > 0
        ? this.impossibleGraph(basePath)
        : this.compileImplicitQueryDefaultGraph(basePath),
      namedGraph: namedGraphs.length > 0
        ? this.compileQueryDatasetGraphs(namedGraphs, basePath, 'FROM NAMED')
        : undefined,
    };
  }

  private compileImplicitQueryDefaultGraph(basePath: string): RdfQueryTermPattern {
    return implicitQueryDefaultGraph(basePath);
  }

  private compileQueryDatasetGraphs(
    graphs: IriTerm[],
    basePath: string,
    clause: string,
  ): RdfQueryTermPattern {
    const compiledGraphs: Term[] = graphs.map((graph) => {
      const compiled = this.compileGraphTerm(graph, basePath);
      if (compiled === null || isCompiledVariable(compiled)) {
        throw new DisabledSparqlFeatureError(`SPARQL ${clause} outside the server-owned Pod is disabled`);
      }
      return compiled as Term;
    });
    if (compiledGraphs.length === 1) {
      return compiledGraphs[0];
    }
    return { $in: uniqueTerms(compiledGraphs) };
  }

  private queryFromClause(query: SparqlQuery): RdfQueryFromClause | undefined {
    if (!('from' in query)) {
      return undefined;
    }
    return query.from;
  }

  private compileWithGraph(
    graph: IriTerm | undefined,
    basePath: string,
    label: string,
  ): RdfQueryTermPattern | undefined {
    if (!graph) {
      return undefined;
    }
    const compiled = this.compileGraphTerm(graph, basePath);
    if (compiled === null || isCompiledVariable(compiled)) {
      throw new UnsupportedSparqlQueryError(`${label} WITH graph outside basePath fallback to compatibility engine`);
    }
    return compiled;
  }

  private impossibleGraph(basePath: string): Term {
    return DataFactory.namedNode(`${basePath}__outside_graph_scope__`) as unknown as Term;
  }

  private queryFromUpdateWhere(
    patterns: Pattern[] | Array<GraphQuads | BgpPattern>,
    basePath: string,
    label: string,
    dataset: { defaultGraph?: RdfQueryTermPattern; namedGraph?: RdfQueryTermPattern } = {},
  ): RdfLocalQuery {
    if (patterns.length === 0) {
      throw new UnsupportedSparqlQueryError(`${label} without WHERE patterns fallback to compatibility engine`);
    }
    const state = new CompileState(basePath);
    this.assertScopedUpdateWherePatterns(patterns as Pattern[], basePath, label, Boolean(dataset.defaultGraph), dataset.namedGraph);
    this.compilePatterns(patterns as Pattern[], dataset.defaultGraph, state, false, dataset.namedGraph);
    state.assertBindVariablesSafe();
    state.assertValuesVariablesBoundByRequiredPatterns();
    state.assertDependentGroupsShareRequiredVariables();
    this.assertFiniteUpdateGraphVariables(state.query, basePath, label);
    if (state.query.patterns.length === 0 && (state.query.unions?.length ?? 0) === 0) {
      throw new UnsupportedSparqlQueryError(`${label} without required graph BGP patterns fallback to compatibility engine`);
    }
    return state.query;
  }

  private queryFromUpdateTemplate(template: RdfSparqlUpdateTemplate[], label: string): RdfLocalQuery {
    if (template.length === 0) {
      throw new UnsupportedSparqlQueryError(`${label} without WHERE patterns fallback to compatibility engine`);
    }
    return {
      patterns: template.map((pattern) => ({
        graph: pattern.graph,
        subject: pattern.subject,
        predicate: pattern.predicate,
        object: pattern.object,
      })),
      optional: [],
      filters: [],
    };
  }

  private compileGraphQuadsTemplate(
    items: Array<GraphQuads | BgpPattern>,
    basePath: string,
    label: string,
    defaultGraph?: RdfQueryTermPattern,
    options: RdfUpdateTemplateOptions = {},
  ): RdfSparqlUpdateTemplate[] {
    const template: RdfSparqlUpdateTemplate[] = [];
    for (const item of items) {
      let graph = defaultGraph;
      if (item.type === 'graph') {
        if (item.name.termType === 'Variable') {
          if (!options.graphVariables?.has(item.name.value)) {
            throw new UnsupportedSparqlQueryError(`${label} GRAPH variables fallback to compatibility engine`);
          }
          graph = rdfVar(item.name.value);
        } else if (item.name.termType !== 'NamedNode') {
          throw new UnsupportedSparqlQueryError(`${label} GRAPH variables fallback to compatibility engine`);
        } else {
          graph = this.compileGraphTerm(item.name, basePath) ?? undefined;
        }
      } else if (!graph) {
        throw new UnsupportedSparqlQueryError(`${label} default graph fallback to compatibility engine`);
      }
      if (!graph || graph === null) {
        throw new UnsupportedSparqlQueryError(`${label} graph outside basePath fallback to compatibility engine`);
      }
      const state = new CompileState(basePath);
      for (const triple of this.updateTemplateTriples(item)) {
        if (!isSimpleTerm(triple.predicate)) {
          throw new UnsupportedSparqlQueryError(`${label} property path templates fallback to compatibility engine`);
        }
        const patterns = this.compileTriple(triple, graph, state);
        if (patterns.length !== 1) {
          throw new UnsupportedSparqlQueryError(`${label} property path templates fallback to compatibility engine`);
        }
        const pattern = patterns[0];
        this.assertSafeUpdateTemplatePattern(pattern, label);
        template.push({
          graph,
          subject: pattern.subject as RdfQueryTermPattern,
          predicate: pattern.predicate as RdfQueryTermPattern,
          object: pattern.object as RdfQueryTermPattern,
        });
      }
    }
    return template;
  }

  private safeUpdateTemplateGraphVariables(query: RdfLocalQuery): ReadonlySet<string> {
    const graphVariables = new Set<string>();
    this.collectQueryGraphVariables(query, graphVariables);
    if (graphVariables.size === 0) {
      return graphVariables;
    }

    const constrainedVariables = new Set<string>();
    this.collectFiniteGraphFilterVariables(query, graphVariables, constrainedVariables);
    return constrainedVariables;
  }

  private collectQueryGraphVariables(
    query: RdfQueryGraphScope,
    graphVariables: Set<string>,
  ): void {
    for (const pattern of query.patterns) {
      if (pattern.graph && isCompiledVariable(pattern.graph)) {
        graphVariables.add(pattern.graph.variable);
      }
    }
    for (const optional of query.optional ?? []) {
      this.collectQueryGraphVariables(Array.isArray(optional) ? { patterns: optional } : optional, graphVariables);
    }
    for (const union of query.unions ?? []) {
      for (const branch of union.branches) {
        this.collectQueryGraphVariables(branch, graphVariables);
      }
    }
    for (const minus of query.minus ?? []) {
      this.collectQueryGraphVariables(minus, graphVariables);
    }
    for (const exists of query.exists ?? []) {
      this.collectQueryGraphVariables(exists, graphVariables);
    }
  }

  private collectFiniteGraphFilterVariables(
    query: RdfQueryGraphScope,
    graphVariables: Set<string>,
    constrainedVariables: Set<string>,
  ): void {
    for (const filter of query.filters ?? []) {
      if (!graphVariables.has(filter.variable)) {
        continue;
      }
      const values = filter.values ?? (filter.value ? [filter.value] : []);
      if (
        (filter.operator === '$eq' || filter.operator === '$sameTerm' || filter.operator === '$in')
          && values.length > 0
          && values.every((value) => this.isNamedNodeFilterValue(value))
      ) {
        constrainedVariables.add(filter.variable);
      }
    }
    for (const optional of query.optional ?? []) {
      this.collectFiniteGraphFilterVariables(Array.isArray(optional) ? { patterns: optional } : optional, graphVariables, constrainedVariables);
    }
    for (const union of query.unions ?? []) {
      for (const branch of union.branches) {
        this.collectFiniteGraphFilterVariables(branch, graphVariables, constrainedVariables);
      }
    }
    for (const minus of query.minus ?? []) {
      this.collectFiniteGraphFilterVariables(minus, graphVariables, constrainedVariables);
    }
    for (const exists of query.exists ?? []) {
      this.collectFiniteGraphFilterVariables(exists, graphVariables, constrainedVariables);
    }
  }

  private isNamedNodeFilterValue(value: unknown): boolean {
    return Boolean(value && typeof value === 'object' && 'termType' in value && (value as Term).termType === 'NamedNode');
  }

  private updateTemplateTriples(item: GraphQuads | BgpPattern): Triple[] {
    if ('triples' in item && Array.isArray(item.triples)) {
      return item.triples;
    }
    const patterns = (item as unknown as { patterns?: Pattern[] }).patterns ?? [];
    return patterns.flatMap((pattern): Triple[] =>
      pattern.type === 'bgp' ? pattern.triples : []);
  }

  private assertSafeUpdateTemplatePattern(pattern: RdfQueryPattern, label: string): void {
    const terms = [ pattern.subject, pattern.predicate, pattern.object ];
    if (terms.some((term) => term && 'termType' in term && term.termType === 'BlankNode')) {
      throw new UnsupportedSparqlQueryError(`${label} blank node templates fallback to compatibility engine`);
    }
  }

  private assertScopedUpdateWherePatterns(
    patterns: Pattern[],
    basePath: string,
    label: string,
    inGraph: boolean,
    namedGraph?: RdfQueryTermPattern,
  ): void {
    if (patterns.length === 0) {
      throw new UnsupportedSparqlQueryError(`${label} without WHERE patterns fallback to compatibility engine`);
    }
    for (const pattern of patterns) {
      switch (pattern.type) {
        case 'graph':
          if (pattern.name.termType === 'Variable') {
          } else if (pattern.name.termType !== 'NamedNode') {
            throw new UnsupportedSparqlQueryError(`${label} GRAPH variables fallback to compatibility engine`);
          } else if (!pattern.name.value.startsWith(basePath)) {
            throw new UnsupportedSparqlQueryError(`${label} graph outside basePath fallback to compatibility engine`);
          }
          this.assertScopedUpdateWherePatterns(pattern.patterns, basePath, label, true, namedGraph);
          break;
        case 'bgp':
          if (!inGraph) {
            throw new UnsupportedSparqlQueryError(`${label} default graph fallback to compatibility engine`);
          }
          break;
        case 'optional':
        case 'group':
          this.assertScopedUpdateWherePatterns(pattern.patterns, basePath, label, inGraph, namedGraph);
          break;
        case 'union':
          for (const branch of pattern.patterns) {
            this.assertScopedUpdateWherePatterns(this.unionBranchPatterns(branch), basePath, label, inGraph, namedGraph);
          }
          break;
        case 'filter':
        case 'values':
          break;
        default:
          if ('queryType' in pattern) {
            throw new UnsupportedSparqlQueryError(`${label} subqueries fallback to compatibility engine`);
          }
          break;
      }
    }
  }

  private assertFiniteUpdateGraphVariables(query: RdfQueryGraphScope, basePath: string, label: string): void {
    const unboundedVariables = new Set<string>();
    this.collectUnboundedUpdateGraphVariables(query, basePath, new Set(), unboundedVariables);
    if (unboundedVariables.size > 0) {
      throw new UnsupportedSparqlQueryError(`${label} GRAPH variables require finite named graph filters fallback to compatibility engine`);
    }
  }

  private collectUnboundedUpdateGraphVariables(
    query: RdfQueryGraphScope,
    basePath: string,
    inheritedFiniteVariables: ReadonlySet<string>,
    unboundedVariables: Set<string>,
  ): void {
    const finiteVariables = new Set(inheritedFiniteVariables);
    this.collectFiniteGraphFilterVariablesFromFilters(query.filters ?? [], finiteVariables, basePath);

    for (const pattern of query.patterns) {
      if (pattern.graph && isCompiledVariable(pattern.graph) && !finiteVariables.has(pattern.graph.variable)) {
        unboundedVariables.add(pattern.graph.variable);
      }
    }
    for (const optional of query.optional ?? []) {
      this.collectUnboundedUpdateGraphVariables(
        Array.isArray(optional) ? { patterns: optional } : optional,
        basePath,
        finiteVariables,
        unboundedVariables,
      );
    }
    for (const union of query.unions ?? []) {
      for (const branch of union.branches) {
        this.collectUnboundedUpdateGraphVariables(branch, basePath, finiteVariables, unboundedVariables);
      }
    }
    for (const minus of query.minus ?? []) {
      this.collectUnboundedUpdateGraphVariables(minus, basePath, finiteVariables, unboundedVariables);
    }
    for (const exists of query.exists ?? []) {
      this.collectUnboundedUpdateGraphVariables(exists, basePath, finiteVariables, unboundedVariables);
    }
  }

  private collectFiniteGraphFilterVariablesFromFilters(
    filters: readonly RdfQueryFilter[],
    finiteVariables: Set<string>,
    basePath: string,
  ): void {
    for (const filter of filters) {
      const values = filter.values ?? (filter.value ? [filter.value] : []);
      if (
        (filter.operator === '$eq' || filter.operator === '$sameTerm' || filter.operator === '$in')
          && values.length > 0
          && values.every((value) => this.isBasePathNamedNodeFilterValue(value, basePath))
      ) {
        finiteVariables.add(filter.variable);
      }
    }
  }

  private isBasePathNamedNodeFilterValue(value: unknown, basePath: string): boolean {
    return this.isNamedNodeFilterValue(value) && (value as Term).value.startsWith(basePath);
  }

  private compileUpdateGraphQuads(
    items: Array<GraphQuads | BgpPattern>,
    basePath: string,
    defaultGraph?: NamedNode,
  ): Quad[] {
    const quads: Quad[] = [];
    for (const item of items) {
      if (item.type !== 'graph') {
        if (!defaultGraph) {
          throw new UnsupportedSparqlQueryError('SPARQL UPDATE default graph fallback to compatibility engine');
        }
        for (const triple of item.triples) {
          quads.push(this.compileUpdateTriple(triple, defaultGraph));
        }
        continue;
      }
      if (item.name.termType !== 'NamedNode') {
        throw new UnsupportedSparqlQueryError('SPARQL UPDATE GRAPH variables fallback to compatibility engine');
      }
      if (!item.name.value.startsWith(basePath)) {
        throw new UnsupportedSparqlQueryError('SPARQL UPDATE graph outside basePath fallback to compatibility engine');
      }
      for (const triple of this.updateTemplateTriples(item)) {
        quads.push(this.compileUpdateTriple(triple, item.name));
      }
    }
    return quads;
  }

  private compileUpdateDefaultGraph(defaultGraph: string | NamedNode | undefined, basePath: string): NamedNode | undefined {
    if (!defaultGraph) {
      return undefined;
    }
    const graph = typeof defaultGraph === 'string'
      ? DataFactory.namedNode(defaultGraph)
      : defaultGraph;
    if (basePath && !graph.value.startsWith(basePath)) {
      throw new UnsupportedSparqlQueryError('SPARQL UPDATE default graph outside basePath fallback to compatibility engine');
    }
    return graph;
  }

  private compileUpdateTriple(triple: Triple, graph: NamedNode): Quad {
    const subject = this.compileUpdateNamedNode(triple.subject, 'subject');
    const predicate = this.compileUpdateNamedNode(triple.predicate, 'predicate');
    const object = this.compileUpdateObject(triple.object);
    return DataFactory.quad(subject as any, predicate as any, object as any, graph as any) as unknown as Quad;
  }

  private compileUpdateNamedNode(term: unknown, position: 'subject' | 'predicate'): NamedNode {
    if (isNamedNodeTerm(term)) {
      return term;
    }
    throw new UnsupportedSparqlQueryError(`SPARQL UPDATE ${position} must be a named node in embedded delta path`);
  }

  private compileUpdateObject(term: SparqlTerm): Term {
    if (isNamedNodeTerm(term) || isLiteralTerm(term as Expression)) {
      return term as unknown as Term;
    }
    throw new UnsupportedSparqlQueryError('SPARQL UPDATE object must be a named node or literal in embedded delta path');
  }

  private compilePatterns(
    patterns: Pattern[],
    graph: RdfQueryTermPattern | undefined,
    state: CompileState,
    optional: boolean,
    namedGraphScope?: RdfQueryTermPattern,
  ): void {
    for (const pattern of patterns) {
      switch (pattern.type) {
        case 'bgp':
          this.compileBgp(pattern, graph, state, optional);
          break;
        case 'graph':
          this.compileGraphPattern(pattern, state, optional, namedGraphScope);
          break;
        case 'optional':
          state.startOptional();
          this.compilePatterns(pattern.patterns, graph, state, true, namedGraphScope);
          state.finishOptional();
          break;
        case 'filter': {
          const expression = (pattern as FilterPattern).expression;
          const notExistsPatterns = this.notExistsPatterns(expression);
          if (notExistsPatterns) {
            if (optional) {
              state.addOptionalMinus(this.compileAntiJoinGroup(
                notExistsPatterns,
                graph,
                state.basePath,
                'FILTER NOT EXISTS',
                namedGraphScope,
              ));
              break;
            }
            state.addMinus(this.compileAntiJoinGroup(notExistsPatterns, graph, state.basePath, 'FILTER NOT EXISTS', namedGraphScope));
            break;
          }
          const existsPatterns = this.existsPatterns(expression);
          if (existsPatterns) {
            if (optional) {
              state.addOptionalExists(this.compileExistsGroup(
                existsPatterns,
                graph,
                state.basePath,
                'FILTER EXISTS',
                namedGraphScope,
              ));
              break;
            }
            state.addExists(this.compileExistsGroup(existsPatterns, graph, state.basePath, 'FILTER EXISTS', namedGraphScope));
            break;
          }
          if (optional) {
            state.addOptionalFilters(this.compileFilter(expression));
            break;
          }
          state.query.filters?.push(...this.compileFilter(expression));
          break;
        }
        case 'group':
          this.compilePatterns(pattern.patterns, graph, state, optional, namedGraphScope);
          break;
        case 'union':
          if (optional) {
            state.addOptionalUnion(this.compileUnionBranches(pattern.patterns, graph, state.basePath, namedGraphScope));
            break;
          }
          state.addUnion(this.compileUnionBranches(pattern.patterns, graph, state.basePath, namedGraphScope));
          break;
        case 'service':
          throw new DisabledSparqlFeatureError('SPARQL SERVICE federation is disabled for server-owned Pod queries');
        case 'bind':
          state.addBind(this.compileBind(pattern as BindPattern, state.basePath), optional);
          break;
        case 'minus':
          if (optional) {
            state.addOptionalMinus(this.compileMinusGroup(pattern as MinusPattern, graph, state.basePath, namedGraphScope));
            break;
          }
          state.addMinus(this.compileMinusGroup(pattern as MinusPattern, graph, state.basePath, namedGraphScope));
          break;
        case 'values':
          this.compileValuesRows((pattern as ValuesPattern).values, state, optional);
          break;
        default:
          if ('queryType' in pattern) {
            throw new UnsupportedSparqlQueryError('Subqueries fallback to compatibility engine');
          }
          throw new UnsupportedSparqlQueryError(`Unsupported SPARQL pattern: ${(pattern as { type?: string }).type ?? 'unknown'}`);
      }
    }
  }

  private compileUnionBranches(
    branches: Pattern[],
    graph: RdfQueryTermPattern | undefined,
    basePath: string,
    namedGraphScope?: RdfQueryTermPattern,
  ): RdfUnionQueryBranch[] {
    if (branches.length < 2) {
      throw new UnsupportedSparqlQueryError('UNION requires at least two branches locally');
    }
    const compiledBranches: RdfUnionQueryBranch[] = [];
    for (const branch of branches) {
      compiledBranches.push(...this.compileUnionBranch(branch, graph, basePath, namedGraphScope));
    }
    return compiledBranches;
  }

  private compileUnionBranch(
    branch: Pattern,
    graph: RdfQueryTermPattern | undefined,
    basePath: string,
    namedGraphScope?: RdfQueryTermPattern,
  ): RdfUnionQueryBranch[] {
    if (branch.type === 'union') {
      return branch.patterns.flatMap((nestedBranch) => (
        this.compileUnionBranch(nestedBranch, graph, basePath, namedGraphScope)
      ));
    }
    const branchState = new CompileState(basePath);
    this.compilePatterns(this.unionBranchPatterns(branch), graph, branchState, false, namedGraphScope);
    branchState.assertBindVariablesSafe();
    branchState.assertValuesVariablesBoundByRequiredPatterns();
    if (branchState.query.unions?.length) {
      throw new UnsupportedSparqlQueryError('Nested UNION fallback to compatibility engine');
    }
    if (branchState.query.patterns.length === 0) {
      throw new UnsupportedSparqlQueryError('UNION branch without required BGP fallback to compatibility engine');
    }
    return [{
      patterns: branchState.query.patterns,
      ...(branchState.query.values?.length ? { values: branchState.query.values } : {}),
      ...(branchState.query.optional?.length ? { optional: branchState.query.optional } : {}),
      ...(branchState.query.binds?.length ? { binds: branchState.query.binds } : {}),
      ...(branchState.query.filters?.length ? { filters: branchState.query.filters } : {}),
    }];
  }

  private compileMinusGroup(
    pattern: MinusPattern,
    graph: RdfQueryTermPattern | undefined,
    basePath: string,
    namedGraphScope?: RdfQueryTermPattern,
  ): RdfMinusQueryGroup {
    return this.compileAntiJoinGroup(pattern.patterns, graph, basePath, 'MINUS', namedGraphScope);
  }

  private compileAntiJoinGroup(
    patterns: Pattern[],
    graph: RdfQueryTermPattern | undefined,
    basePath: string,
    label: string,
    namedGraphScope?: RdfQueryTermPattern,
  ): RdfMinusQueryGroup {
    const minusState = new CompileState(basePath, true);
    this.compilePatterns(patterns, graph, minusState, false, namedGraphScope);
    minusState.assertBindVariablesSafe();
    minusState.assertValuesVariablesBoundByRequiredPatterns();
    if (minusState.query.minus?.length || minusState.query.exists?.length) {
      throw new UnsupportedSparqlQueryError(`Nested ${label} fallback to compatibility engine`);
    }
    if (minusState.query.patterns.length === 0 && (minusState.query.unions?.length ?? 0) === 0) {
      throw new UnsupportedSparqlQueryError(`${label} without required BGP fallback to compatibility engine`);
    }
    return {
      patterns: minusState.query.patterns,
      ...(minusState.query.values?.length ? { values: minusState.query.values } : {}),
      ...(minusState.query.unions?.length ? { unions: minusState.query.unions } : {}),
      ...(minusState.query.optional?.length ? { optional: minusState.query.optional } : {}),
      ...(minusState.query.binds?.length ? { binds: minusState.query.binds } : {}),
      ...(minusState.query.filters?.length ? { filters: minusState.query.filters } : {}),
    };
  }

  private compileExistsGroup(
    patterns: Pattern[],
    graph: RdfQueryTermPattern | undefined,
    basePath: string,
    label: string,
    namedGraphScope?: RdfQueryTermPattern,
  ): RdfExistsQueryGroup {
    const existsState = new CompileState(basePath, true);
    this.compilePatterns(patterns, graph, existsState, false, namedGraphScope);
    existsState.assertBindVariablesSafe();
    existsState.assertValuesVariablesBoundByRequiredPatterns();
    if (existsState.query.minus?.length || existsState.query.exists?.length) {
      throw new UnsupportedSparqlQueryError(`Nested ${label} fallback to compatibility engine`);
    }
    if (existsState.query.patterns.length === 0 && (existsState.query.unions?.length ?? 0) === 0) {
      throw new UnsupportedSparqlQueryError(`${label} without required BGP fallback to compatibility engine`);
    }
    return {
      patterns: existsState.query.patterns,
      ...(existsState.query.values?.length ? { values: existsState.query.values } : {}),
      ...(existsState.query.unions?.length ? { unions: existsState.query.unions } : {}),
      ...(existsState.query.optional?.length ? { optional: existsState.query.optional } : {}),
      ...(existsState.query.binds?.length ? { binds: existsState.query.binds } : {}),
      ...(existsState.query.filters?.length ? { filters: existsState.query.filters } : {}),
    };
  }

  private notExistsPatterns(expression: Expression): Pattern[] | null {
    if (!isOperationExpression(expression) || expression.operator.toLowerCase() !== 'notexists') {
      return null;
    }
    const pattern = expression.args[0];
    if (!pattern || !isPattern(pattern)) {
      throw new UnsupportedSparqlQueryError('FILTER NOT EXISTS without graph pattern fallback to compatibility engine');
    }
    return pattern.type === 'group'
      ? pattern.patterns
      : [pattern];
  }

  private existsPatterns(expression: Expression): Pattern[] | null {
    if (!isOperationExpression(expression) || expression.operator.toLowerCase() !== 'exists') {
      return null;
    }
    const pattern = expression.args[0];
    if (!pattern || !isPattern(pattern)) {
      throw new UnsupportedSparqlQueryError('FILTER EXISTS without graph pattern fallback to compatibility engine');
    }
    return pattern.type === 'group'
      ? pattern.patterns
      : [pattern];
  }

  private unionBranchPatterns(branch: Pattern): Pattern[] {
    return branch.type === 'group'
      ? branch.patterns
      : [branch];
  }

  private compileBgp(
    pattern: BgpPattern | GraphQuads,
    graph: RdfQueryTermPattern | undefined,
    state: CompileState,
    optional: boolean,
  ): void {
    for (const triple of pattern.triples) {
      for (const queryPattern of this.compileTriple(triple, graph, state)) {
        state.addPattern(queryPattern, optional);
      }
    }
  }

  private compileGraphPattern(
    pattern: GraphPattern,
    state: CompileState,
    optional: boolean,
    namedGraphScope?: RdfQueryTermPattern,
  ): void {
    const graph = this.compileScopedGraphTerm(pattern.name, state.basePath, namedGraphScope);
    if (graph === null) {
      state.addImpossibleGraphPattern(optional);
      return;
    }
    if (pattern.name.termType === 'Variable') {
      const graphScopeFilter: RdfQueryFilter = namedGraphScope
        ? {
          variable: pattern.name.value,
          operator: '$in',
          values: this.graphScopeFilterValues(namedGraphScope),
        }
        : {
          variable: pattern.name.value,
          operator: '$startsWith',
          value: state.basePath,
        };
      if (optional) {
        state.addOptionalFilters([graphScopeFilter]);
      } else {
        state.query.filters?.push(graphScopeFilter);
      }
    }
    this.compilePatterns(pattern.patterns, graph, state, optional, namedGraphScope);
  }

  private compileScopedGraphTerm(
    term: IriTerm | VariableTerm,
    basePath: string,
    namedGraphScope?: RdfQueryTermPattern,
  ): RdfQueryTermPattern | null {
    const graph = this.compileGraphTerm(term, basePath);
    if (!namedGraphScope) {
      return graph;
    }
    if (graph === null) {
      return null;
    }
    if (term.termType === 'Variable') {
      return graph;
    }
    return this.graphScopeContains(namedGraphScope, graph as Term) ? graph : null;
  }

  private graphScopeContains(scope: RdfQueryTermPattern, graph: Term): boolean {
    if (isCompiledVariable(scope)) {
      return false;
    }
    if (isRdfJsTerm(scope)) {
      return termToId(scope as any) === termToId(graph as any);
    }
    const values = (scope as { $in?: unknown }).$in;
    return Array.isArray(values) && values.some((value) => (
      value && typeof value === 'object' && 'termType' in value && termToId(value as any) === termToId(graph as any)
    ));
  }

  private graphScopeFilterValues(scope: RdfQueryTermPattern): Term[] {
    if (isCompiledVariable(scope)) {
      throw new UnsupportedSparqlQueryError('GRAPH variable dataset scope fallback to compatibility engine');
    }
    if (isRdfJsTerm(scope)) {
      return [scope as Term];
    }
    const values = (scope as { $in?: unknown }).$in;
    if (Array.isArray(values) && values.every((value) => value && typeof value === 'object' && 'termType' in value)) {
      return values as Term[];
    }
    throw new UnsupportedSparqlQueryError('GRAPH variable dataset scope fallback to compatibility engine');
  }

  private compileBind(pattern: BindPattern, basePath: string): { variable: string; expression: RdfBindExpression } {
    return {
      variable: pattern.variable.value,
      expression: this.compileBindExpression(pattern.expression, basePath),
    };
  }

  private compileBindExpression(expression: Expression, basePath: string): RdfBindExpression {
    return this.compileBindLikeExpression(expression, basePath, 'BIND');
  }

  private compileBindLikeExpression(expression: Expression, basePath: string, label: string): RdfBindExpression {
    const normalized = this.normalizeFunctionCallExpression(expression);
    if (isRdfTermExpression(normalized) && !isVariableTerm(normalized)) {
      return {
        type: 'term',
        term: normalized as unknown as Term,
      };
    }
    if (isVariableTerm(normalized)) {
      return {
        type: 'variable',
        variable: normalized.value,
      };
    }
    if (!isOperationExpression(normalized)) {
      throw new UnsupportedSparqlQueryError(`${label} expression fallback to compatibility engine`);
    }

    const operator = normalized.operator.toLowerCase();
    if (operator === 'str') {
      return {
        type: 'stringValue',
        variable: this.expressionVariable(this.expressionArg(normalized.args[0])),
      };
    }
    if (operator === 'strlen') {
      return {
        type: 'stringLength',
        variable: this.stringOperandVariable(this.expressionArg(normalized.args[0])).variable,
      };
    }
    if (operator === 'lcase' || operator === 'lower-case') {
      return {
        type: 'lowerCase',
        expression: this.compileBindExpression(this.expressionArg(normalized.args[0]), basePath),
      };
    }
    if (operator === 'ucase' || operator === 'upper-case') {
      return {
        type: 'upperCase',
        expression: this.compileBindExpression(this.expressionArg(normalized.args[0]), basePath),
      };
    }
    if (operator === 'coalesce') {
      return {
        type: 'coalesce',
        expressions: normalized.args.map((arg: Expression | Pattern) => (
          this.compileBindExpression(this.expressionArg(arg), basePath)
        )),
      };
    }
    if (operator === 'if') {
      return {
        type: 'if',
        condition: this.compileFilter(this.expressionArg(normalized.args[0])),
        then: this.compileBindExpression(this.expressionArg(normalized.args[1]), basePath),
        else: this.compileBindExpression(this.expressionArg(normalized.args[2]), basePath),
      };
    }
    if (operator === 'substr' || operator === 'substring') {
      return {
        type: 'substring',
        expression: this.compileBindExpression(this.expressionArg(normalized.args[0]), basePath),
        start: this.compileBindExpression(this.expressionArg(normalized.args[1]), basePath),
        ...(normalized.args[2] === undefined
          ? {}
          : { length: this.compileBindExpression(this.expressionArg(normalized.args[2]), basePath) }),
      };
    }
    if (operator === 'concat') {
      return {
        type: 'concat',
        expressions: normalized.args.map((arg: Expression | Pattern) => (
          this.compileBindExpression(this.expressionArg(arg), basePath)
        )),
      };
    }
    if (operator === 'iri' || operator === 'uri') {
      return {
        type: 'iri',
        expression: this.compileBindExpression(this.expressionArg(normalized.args[0]), basePath),
        base: basePath,
      };
    }
    if (operator === 'strdt') {
      return {
        type: 'strdt',
        lexical: this.compileBindExpression(this.expressionArg(normalized.args[0]), basePath),
        datatype: this.compileBindExpression(this.expressionArg(normalized.args[1]), basePath),
      };
    }
    if (operator === 'strlang') {
      return {
        type: 'strlang',
        lexical: this.compileBindExpression(this.expressionArg(normalized.args[0]), basePath),
        language: this.compileBindExpression(this.expressionArg(normalized.args[1]), basePath),
      };
    }

    throw new UnsupportedSparqlQueryError(`${label} ${operator} fallback to compatibility engine`);
  }

  private compileTriple(triple: Triple, graph: RdfQueryTermPattern | undefined, state: CompileState): RdfQueryPattern[] {
    const subject = this.compileTerm(triple.subject);
    const object = this.compileTerm(triple.object);
    const pathPatterns = this.compilePropertyPath(triple.predicate, subject, object, graph, state);
    if (pathPatterns) {
      return pathPatterns;
    }
    if (!isSimpleTerm(triple.predicate)) {
      throw new UnsupportedSparqlQueryError('Property paths fallback to compatibility engine');
    }
    return [{
      graph,
      subject,
      predicate: this.compileTerm(triple.predicate),
      object,
    }];
  }

  private compilePropertyPath(
    predicate: Triple['predicate'],
    subject: RdfQueryTermPattern,
    object: RdfQueryTermPattern,
    graph: RdfQueryTermPattern | undefined,
    state: CompileState,
  ): RdfQueryPattern[] | null {
    if (isSimpleTerm(predicate)) {
      return null;
    }
    const alternative = this.flattenFixedAlternativePath(predicate);
    if (alternative) {
      const predicateMatch = { $in: alternative.predicates.map((entry) => entry as unknown as Term) };
      return [
        alternative.inverse
          ? {
              graph,
              subject: object,
              predicate: predicateMatch,
              object: subject,
            }
          : {
              graph,
              subject,
              predicate: predicateMatch,
              object,
            },
      ];
    }
    const segments = this.flattenFixedLengthPath(predicate);
    if (!segments) {
      throw new UnsupportedSparqlQueryError('Property paths fallback to compatibility engine');
    }
    if (segments.length === 0) {
      throw new UnsupportedSparqlQueryError('Empty property paths fallback to compatibility engine');
    }

    const patterns: RdfQueryPattern[] = [];
    let currentSubject = subject;
    for (const [index, segment] of segments.entries()) {
      const isLast = index === segments.length - 1;
      const currentObject = isLast ? object : state.nextPathJoinVariable();
      const predicate = this.compilePathSegmentPredicate(segment);
      patterns.push(segment.inverse
        ? {
            graph,
            subject: currentObject,
            predicate,
            object: currentSubject,
          }
        : {
            graph,
            subject: currentSubject,
            predicate,
            object: currentObject,
          });
      currentSubject = currentObject;
    }
    return patterns;
  }

  private compilePathSegmentPredicate(segment: FixedPathSegment): RdfQueryTermPattern {
    return segment.predicates.length === 1
      ? segment.predicates[0] as unknown as Term
      : { $in: segment.predicates.map((entry) => entry as unknown as Term) };
  }

  private flattenFixedLengthPath(path: PropertyPath): FixedPathSegment[] | null {
    return this.flattenFixedLengthPathItem(path, false);
  }

  private flattenFixedAlternativePath(path: PropertyPath): FixedAlternativePath | null {
    return this.flattenFixedAlternativePathItem(path, false);
  }

  private flattenFixedAlternativePathItem(item: IriTerm | PropertyPath, inverse: boolean): FixedAlternativePath | null {
    if (isNamedNodeTerm(item)) {
      return null;
    }
    if (item.pathType === '^' && item.items.length === 1) {
      return this.flattenFixedAlternativePathItem(item.items[0], !inverse);
    }
    if (item.pathType !== '|') {
      return null;
    }

    const predicates: IriTerm[] = [];
    for (const nestedItem of item.items) {
      if (!isNamedNodeTerm(nestedItem)) {
        return null;
      }
      predicates.push(nestedItem as IriTerm);
    }
    return predicates.length > 0
      ? { predicates, inverse }
      : null;
  }

  private flattenFixedLengthPathItem(item: IriTerm | PropertyPath, inverse: boolean): FixedPathSegment[] | null {
    if (isNamedNodeTerm(item)) {
      return [{ predicates: [item as IriTerm], inverse }];
    }
    if (item.pathType === '^' && item.items.length === 1) {
      return this.flattenFixedLengthPathItem(item.items[0], !inverse);
    }
    if (item.pathType === '|') {
      const predicates: IriTerm[] = [];
      for (const nestedItem of item.items) {
        if (!isNamedNodeTerm(nestedItem)) {
          return null;
        }
        predicates.push(nestedItem as IriTerm);
      }
      return predicates.length > 0
        ? [{ predicates, inverse }]
        : null;
    }
    if (item.pathType !== '/') {
      return null;
    }

    const items = inverse ? [...item.items].reverse() : item.items;
    const segments: FixedPathSegment[] = [];
    for (const nestedItem of items) {
      const nested = this.flattenFixedLengthPathItem(nestedItem, inverse);
      if (!nested) {
        return null;
      }
      segments.push(...nested);
    }
    return segments;
  }

  private compileGraphTerm(term: IriTerm | VariableTerm, basePath: string): RdfQueryTermPattern | null {
    if (term.termType === 'Variable') {
      return rdfVar(term.value);
    }
    if (!term.value.startsWith(basePath)) {
      return null;
    }
    return term as unknown as Term;
  }

  private compileTerm(term: SparqlTerm): RdfQueryTermPattern {
    if (term.termType === 'Variable') {
      return rdfVar(term.value);
    }
    if (term.termType === 'Quad') {
      throw new UnsupportedSparqlQueryError('RDF-star terms fallback to compatibility engine');
    }
    return term as unknown as Term;
  }

  public materializeConstruct(template: RdfConstructTemplate[], rows: RdfBindingRow[], graph?: Term): Quad[] {
    return this.materializeTemplate(
      template.map((triple) => ({
        ...triple,
        graph: graph ?? DataFactory.defaultGraph(),
      })),
      rows,
    );
  }

  public materializeDeleteWhere(template: RdfSparqlUpdateTemplate[], rows: RdfBindingRow[]): Quad[] {
    return this.materializeTemplate(template, rows);
  }

  private materializeTemplate(template: RdfSparqlUpdateTemplate[], rows: RdfBindingRow[]): Quad[] {
    const quads: Quad[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      for (const triple of template) {
        const graph = this.resolveTemplateTerm(triple.graph, row);
        const subject = this.resolveTemplateTerm(triple.subject, row);
        const predicate = this.resolveTemplateTerm(triple.predicate, row);
        const object = this.resolveTemplateTerm(triple.object, row);
        if (!graph || !subject || !predicate || !object) {
          continue;
        }
        if (graph.termType !== 'NamedNode' && graph.termType !== 'DefaultGraph') {
          continue;
        }
        if (subject.termType !== 'NamedNode' && subject.termType !== 'BlankNode') {
          continue;
        }
        if (predicate.termType !== 'NamedNode') {
          continue;
        }
        if (object.termType === 'DefaultGraph') {
          continue;
        }
        const quad = DataFactory.quad(subject as any, predicate as any, object as any, graph as any) as unknown as Quad;
        const key = [quad.subject, quad.predicate, quad.object, quad.graph].map((term) => termToId(term as any)).join('\u001f');
        if (!seen.has(key)) {
          seen.add(key);
          quads.push(quad);
        }
      }
    }
    return quads;
  }

  private compileConstructTemplate(query: ConstructQuery): RdfConstructTemplate[] {
    if (!query.template || query.template.length === 0) {
      throw new UnsupportedSparqlQueryError('CONSTRUCT without template fallback to compatibility engine');
    }
    return query.template.map((triple) => {
      if (!isSimpleTerm(triple.predicate)) {
        throw new UnsupportedSparqlQueryError('CONSTRUCT property paths fallback to compatibility engine');
      }
      if (triple.predicate.termType !== 'NamedNode' && triple.predicate.termType !== 'Variable') {
        throw new UnsupportedSparqlQueryError('CONSTRUCT predicates must be IRIs or variables');
      }
      return {
        subject: this.compileTerm(triple.subject),
        predicate: this.compileTerm(triple.predicate),
        object: this.compileTerm(triple.object),
      };
    });
  }

  private compileDescribeTargets(query: DescribeQuery, localQuery: RdfLocalQuery): RdfQueryTermPattern[] {
    if (query.variables.length === 1 && query.variables[0] instanceof Wildcard) {
      const variables = visibleSelectVariables(query);
      if (variables.length === 0) {
        throw new UnsupportedSparqlQueryError('DESCRIBE wildcard without visible variables fallback to compatibility engine');
      }
      const unboundVariable = variables.find((variable) => !queryBindsVariableInRequiredShape(localQuery, variable));
      if (unboundVariable) {
        throw new UnsupportedSparqlQueryError('DESCRIBE wildcard variables must be bound by required embedded query patterns');
      }
      return variables.map((variable) => rdfVar(variable));
    }

    const targets = query.variables.map((target) => {
      if (target.termType === 'Variable') {
        if (!queryBindsVariableInRequiredShape(localQuery, target.value)) {
          throw new UnsupportedSparqlQueryError('DESCRIBE variables must be bound by required embedded query patterns');
        }
        return rdfVar(target.value);
      }
      if (target.termType === 'NamedNode') {
        return target as unknown as Term;
      }
      throw new UnsupportedSparqlQueryError('DESCRIBE targets must be IRIs or bound variables locally');
    });

    if (targets.length === 0) {
      throw new UnsupportedSparqlQueryError('DESCRIBE without targets fallback to compatibility engine');
    }
    return targets;
  }

  private resolveTemplateTerm(term: RdfQueryTermPattern, row: RdfBindingRow): Term | undefined {
    if (isCompiledVariable(term)) {
      return row[term.variable];
    }
    return term as Term;
  }

  private compileSelectVariables(query: SelectQuery, state: CompileState): string[] {
    const localQuery = state.query;
    if (query.variables.length === 1 && query.variables[0] instanceof Wildcard) {
      if ((localQuery.groupBy?.length ?? 0) > 0) {
        throw new UnsupportedSparqlQueryError('Wildcard grouped SELECT fallback to compatibility engine');
      }
      return visibleSelectVariables(query);
    }

    const variables: string[] = [];
    const visibleVariables = visibleSelectVariables(query);
    state.setVisibleSolutionVariables(visibleVariables);
    for (const variable of query.variables) {
      if (isSelectVariableTerm(variable)) {
        variables.push(variable.value);
        continue;
      }
      if (!isVariableExpression(variable)) {
        throw new UnsupportedSparqlQueryError('Wildcard mixed with explicit SELECT projections fallback to compatibility engine');
      }

      if (!isAggregateExpression(variable.expression)) {
        if ((localQuery.groupBy?.length ?? 0) > 0) {
          throw new UnsupportedSparqlQueryError('Grouped SELECT expression projection fallback to compatibility engine');
        }
        const alias = variable.variable.value;
        if (
          variables.includes(alias)
            || visibleVariables.includes(alias)
            || (localQuery.binds ?? []).some((bind) => bind.variable === alias)
        ) {
          throw new UnsupportedSparqlQueryError('SELECT expression alias is already bound locally');
        }
        state.addBind({
          variable: alias,
          expression: this.compileSelectProjectionExpression(variable.expression, state.basePath),
        }, false);
        variables.push(alias);
        continue;
      }

      const aggregate = variable.expression;
      const compiledAggregate = this.compileAggregateProjection(aggregate, variable.variable.value, state);
      localQuery.aggregates = [...(localQuery.aggregates ?? []), compiledAggregate];
      localQuery.aggregate ??= compiledAggregate;
      variables.push(variable.variable.value);
    }
    this.assertGroupProjection(query, localQuery, variables);
    return variables;
  }

  private compileAggregateProjection(
    aggregate: AggregateExpression,
    as: string,
    state: CompileState,
  ): RdfQueryAggregate {
    const type = this.aggregateType(aggregate.aggregation);
    const aggregateExpression = aggregate.expression;
    if (type !== 'count' && isWildcardTerm(aggregateExpression)) {
      throw new UnsupportedSparqlQueryError(`${type.toUpperCase()}(*) fallback to compatibility engine`);
    }
    const variable = isWildcardTerm(aggregateExpression)
      ? undefined
      : this.expressionVariable(aggregateExpression);
    if (type !== 'count') {
      this.assertNumericAggregateSafe(variable, state);
    }
    return {
      type,
      as,
      variable,
      distinct: aggregate.distinct,
      ...(type === 'count' && aggregate.distinct && !variable
        ? { distinctVariables: state.visibleSolutionVariables }
        : {}),
    };
  }

  private aggregateType(aggregation: string): RdfQueryAggregate['type'] {
    switch (aggregation.toLowerCase()) {
      case 'count':
      case 'sum':
      case 'avg':
      case 'min':
      case 'max':
        return aggregation.toLowerCase() as RdfQueryAggregate['type'];
      default:
        throw new UnsupportedSparqlQueryError(`Aggregate ${aggregation} fallback to compatibility engine`);
    }
  }

  private assertNumericAggregateSafe(variable: string | undefined, state: CompileState): void {
    if (!variable) {
      throw new UnsupportedSparqlQueryError('Numeric aggregate requires a variable locally');
    }
    if (!queryBindsVariableInRequiredShape(state.query, variable)) {
      throw new UnsupportedSparqlQueryError('Numeric aggregate variable must be bound by required embedded query patterns');
    }
    if (!hasNumericGuard(state.query.filters ?? [], variable)) {
      throw new UnsupportedSparqlQueryError('Numeric aggregate requires FILTER(isNumeric(?var)) locally');
    }
  }

  private compileSelectProjectionExpression(expression: Expression, basePath: string): RdfBindExpression {
    return this.compileBindLikeExpression(expression, basePath, 'SELECT projection');
  }

  private compileGroupBy(group: Grouping[], state: CompileState): string[] | undefined {
    if (group.length === 0) {
      return undefined;
    }
    const groupBy: string[] = [];
    group.forEach((entry, index) => {
      if (isVariableTerm(entry.expression)) {
        const groupVariable = entry.variable?.value ?? entry.expression.value;
        groupBy.push(groupVariable);
        if (entry.variable && entry.variable.value !== entry.expression.value) {
          state.addBind({
            variable: entry.variable.value,
            expression: {
              type: 'variable',
              variable: entry.expression.value,
            },
          }, false);
        }
        return;
      }

      const groupVariable = entry.variable?.value ?? state.nextGroupVariable(index);
      state.addBind({
        variable: groupVariable,
        expression: this.compileGroupByExpression(entry.expression, state.basePath),
      }, false);
      groupBy.push(groupVariable);
    });
    state.query.groupBy = groupBy;
    return groupBy;
  }

  private compileGroupByExpression(expression: Expression, basePath: string): RdfBindExpression {
    return this.compileBindLikeExpression(expression, basePath, 'GROUP BY');
  }

  private compileHaving(having: Expression[], state: CompileState): RdfQueryFilter[] | undefined {
    if (having.length === 0) {
      return undefined;
    }
    const localQuery = state.query;
    if ((localQuery.aggregates?.length ?? 0) === 0 && !localQuery.aggregate) {
      throw new UnsupportedSparqlQueryError('HAVING without aggregate fallback to compatibility engine');
    }

    const filters = having.flatMap((expression) => this.compileHavingFilter(expression, state));
    return filters.length > 0 ? filters : undefined;
  }

  private compileHavingFilter(expression: Expression, state: CompileState): RdfQueryFilter[] {
    const normalized = this.normalizeFunctionCallExpression(expression);
    if (!isOperationExpression(normalized)) {
      throw new UnsupportedSparqlQueryError('Only simple HAVING operations are supported locally');
    }
    const operator = normalized.operator.toLowerCase();
    if (operator === '&&') {
      return normalized.args.flatMap((arg: Expression | Pattern) => this.compileHavingFilter(this.expressionArg(arg), state));
    }
    const binary = this.binaryFilter(operator);
    if (!binary) {
      throw new UnsupportedSparqlQueryError(`HAVING ${operator} fallback to compatibility engine`);
    }

    return [this.compileHavingBinaryFilter(binary, normalized.args[0], normalized.args[1], state)];
  }

  private compileHavingBinaryFilter(
    operator: RdfQueryFilterOperator,
    left: Expression | Pattern | undefined,
    right: Expression | Pattern | undefined,
    state: CompileState,
  ): RdfQueryFilter {
    const leftExpression = this.expressionArg(left);
    const rightExpression = this.expressionArg(right);
    const leftAggregate = this.havingAggregateVariableOrUndefined(leftExpression, state);
    if (leftAggregate) {
      return {
        variable: leftAggregate,
        operator,
        value: this.filterValue(rightExpression),
      };
    }
    const rightAggregate = this.havingAggregateVariableOrUndefined(rightExpression, state);
    if (rightAggregate) {
      return {
        variable: rightAggregate,
        operator: this.reverseBinaryFilter(operator),
        value: this.filterValue(leftExpression),
      };
    }
    throw new UnsupportedSparqlQueryError('HAVING must compare one aggregate with one RDF term locally');
  }

  private havingAggregateVariableOrUndefined(expression: Expression, state: CompileState): string | undefined {
    const localQuery = state.query;
    const aggregates = localQuery.aggregates ?? (localQuery.aggregate ? [localQuery.aggregate] : []);
    if (aggregates.length === 0) {
      return undefined;
    }
    if (isVariableExpressionTerm(expression)) {
      return aggregates.some((aggregate) => aggregate.as === expression.value) ? expression.value : undefined;
    }
    if (!isAggregateExpression(expression)) {
      return undefined;
    }
    const type = this.aggregateType(expression.aggregation);
    const aggregateExpression = expression.expression;
    const variable = isWildcardTerm(aggregateExpression)
      ? undefined
      : this.expressionVariable(aggregateExpression);
    const matchingAggregate = aggregates.find((aggregate) => (
      type === aggregate.type
        && variable === aggregate.variable
        && expression.distinct === Boolean(aggregate.distinct)
    ));
    if (matchingAggregate) {
      return matchingAggregate.as;
    }
    if (type !== 'count') {
      this.assertNumericAggregateSafe(variable, state);
    }
    const hiddenAggregate: RdfQueryAggregate = {
      type,
      as: state.nextHavingAggregateVariable(),
      variable,
      distinct: expression.distinct,
      ...(type === 'count' && expression.distinct && !variable
        ? { distinctVariables: state.visibleSolutionVariables }
        : {}),
    };
    localQuery.aggregates = [...(localQuery.aggregates ?? []), hiddenAggregate];
    return hiddenAggregate.as;
  }

  private assertGroupProjection(query: SelectQuery, localQuery: RdfLocalQuery, variables: string[]): void {
    const groupBy = localQuery.groupBy ?? [];
    if (groupBy.length === 0) {
      return;
    }
    const aggregates = localQuery.aggregates ?? (localQuery.aggregate ? [localQuery.aggregate] : []);
    if (aggregates.length === 0) {
      throw new UnsupportedSparqlQueryError('GROUP BY without aggregate fallback to compatibility engine');
    }
    const groupableVariables = new Set([
      ...localQuery.patterns.flatMap((pattern) => variablesInPattern(pattern)),
      ...(localQuery.binds ?? []).map((bind) => bind.variable),
    ]);
    if (groupBy.some((variableName) => !groupableVariables.has(variableName))) {
      throw new UnsupportedSparqlQueryError('GROUP BY variables must come from required BGP patterns or local binds');
    }

    const groupVariables = new Set(groupBy);
    const aggregateVariables = new Set<string>();
    for (const variable of query.variables) {
      if (isSelectVariableTerm(variable)) {
        if (!groupVariables.has(variable.value)) {
          throw new UnsupportedSparqlQueryError('Grouped SELECT variables must be present in GROUP BY');
        }
        continue;
      }
      if (isVariableExpression(variable) && isAggregateExpression(variable.expression)) {
        aggregateVariables.add(variable.variable.value);
      }
    }
    const aggregateAliases = new Set(aggregates.map((aggregate) => aggregate.as));
    if (aggregateVariables.size !== aggregateAliases.size) {
      throw new UnsupportedSparqlQueryError('Grouped local queries require aggregate projections to be aggregate aliases');
    }
    if ([...aggregateVariables].some((variableName) => !aggregateAliases.has(variableName))) {
      throw new UnsupportedSparqlQueryError('Grouped local queries require aggregate projections to be aggregate aliases');
    }
    if (variables.some((variableName) => !groupVariables.has(variableName) && !aggregateAliases.has(variableName))) {
      throw new UnsupportedSparqlQueryError('Grouped SELECT projection fallback to compatibility engine');
    }
  }

  private compileOrder(order: Ordering[], state: CompileState): RdfLocalQuery['orderBy'] {
    if (order.length === 0) {
      return undefined;
    }
    return order.map((entry, index) => {
      if (isVariableTerm(entry.expression)) {
        return {
          variable: entry.expression.value,
          direction: entry.descending ? 'desc' : 'asc',
        };
      }
      const orderVariable = state.nextOrderVariable(index);
      state.addBind({
        variable: orderVariable,
        expression: this.compileOrderExpression(entry.expression, state.basePath),
      }, false);
      return {
        variable: orderVariable,
        direction: entry.descending ? 'desc' : 'asc',
      };
    });
  }

  private compileOrderExpression(expression: Expression, basePath: string): RdfBindExpression {
    return this.compileBindLikeExpression(expression, basePath, 'ORDER BY');
  }

  private compileFilter(expression: Expression): RdfQueryFilter[] {
    const normalizedExpression = this.normalizeFunctionCallExpression(expression);
    if (!isOperationExpression(expression)) {
      if (!normalizedExpression || !isOperationExpression(normalizedExpression)) {
        throw new UnsupportedSparqlQueryError('Only simple FILTER operations are supported locally');
      }
      expression = normalizedExpression;
    } else {
      expression = normalizedExpression as OperationExpression;
    }

    const operator = expression.operator.toLowerCase();
    if (operator === '&&') {
      return expression.args.flatMap((arg: Expression | Pattern) => this.compileFilter(this.expressionArg(arg)));
    }
    if (operator === '||') {
      return [this.compileOrFilter(expression)];
    }
    if (operator === 'bound') {
      return [{
        variable: this.expressionVariable(this.expressionArg(expression.args[0])),
        operator: '$bound',
        value: true,
      }];
    }
    const termTest = this.compileTermTestFilter(operator, expression);
    if (termTest) {
      return [termTest];
    }
    if (operator === '!' || operator === 'not') {
      return this.compileNegatedFilter(this.expressionArg(expression.args[0]));
    }
    if (operator === 'langmatches') {
      return [this.compileLangMatchesFilter(expression)];
    }

    const binary = this.binaryFilter(operator);
    if (binary) {
      return [this.compileBinaryFilter(binary, expression.args[0], expression.args[1])];
    }

    if (operator === 'in' || operator === 'notin') {
      const values = expression.args[1];
      if (!Array.isArray(values)) {
        throw new UnsupportedSparqlQueryError('FILTER IN tuple fallback to compatibility engine');
      }
      const functionFilter = this.compileFunctionInFilter(
        this.expressionArg(expression.args[0]),
        values,
        operator === 'notin',
      );
      if (functionFilter) {
        return [functionFilter];
      }
      const operand = this.stringOperandVariable(this.expressionArg(expression.args[0]));
      return [{
        variable: operand.variable,
        operator: operator === 'in' ? '$in' : '$notIn',
        operand: operand.operand,
        values: values.map((value) => this.filterValue(value)),
      }];
    }

    const stringOperator = this.stringFilter(operator);
    if (stringOperator) {
      const [left, right, flags] = expression.args;
      const leftOperand = this.stringOperandVariable(this.expressionArg(left));
      return [{
        variable: leftOperand.variable,
        operator: stringOperator,
        operand: leftOperand.operand,
        value: this.literalString(this.expressionArg(right)),
        flags: operator === 'regex' && flags ? this.literalString(this.expressionArg(flags)) : undefined,
      }];
    }

    throw new UnsupportedSparqlQueryError(`FILTER ${operator} fallback to compatibility engine`);
  }

  private compileOrFilter(expression: OperationExpression): RdfQueryFilter {
    const branches = this.flattenOrExpressions(expression);
    let variable: string | undefined;
    let operand: RdfQueryFilter['operand'] = undefined;
    let operandInitialized = false;
    const values: RdfQueryFilterValue[] = [];
    const seen = new Set<string>();

    for (const branch of branches) {
      const filters = this.compileFilter(branch);
      if (filters.length !== 1) {
        throw new UnsupportedSparqlQueryError('FILTER OR only supports equality or IN branches on one variable locally');
      }

      const filter = filters[0];
      if (filter.operator !== '$eq' && filter.operator !== '$in') {
        throw new UnsupportedSparqlQueryError('FILTER OR only supports equality or IN branches on one variable locally');
      }
      if (variable && variable !== filter.variable) {
        throw new UnsupportedSparqlQueryError('FILTER OR branches must constrain the same variable locally');
      }
      if (operandInitialized && operand !== filter.operand) {
        throw new UnsupportedSparqlQueryError('FILTER OR branches must use the same operand locally');
      }
      variable = filter.variable;
      operand = filter.operand;
      operandInitialized = true;

      const branchValues = filter.operator === '$eq'
        ? filter.value === undefined ? [] : [filter.value]
        : filter.values ?? [];
      if (branchValues.length === 0) {
        throw new UnsupportedSparqlQueryError('FILTER OR branch without values fallback to compatibility engine');
      }
      for (const value of branchValues) {
        const key = this.filterValueKey(value);
        if (!seen.has(key)) {
          seen.add(key);
          values.push(value);
        }
      }
    }

    if (!variable || values.length === 0) {
      throw new UnsupportedSparqlQueryError('FILTER OR without equality branches fallback to compatibility engine');
    }
    return {
      variable,
      operator: '$in',
      operand,
      values,
    };
  }

  private flattenOrExpressions(expression: Expression): Expression[] {
    if (isOperationExpression(expression) && expression.operator.toLowerCase() === '||') {
      return expression.args.flatMap((arg: Expression | Pattern) => this.flattenOrExpressions(this.expressionArg(arg)));
    }
    return [expression];
  }

  private filterValueKey(value: RdfQueryFilterValue): string {
    if (value && typeof value === 'object' && 'termType' in value) {
      return `term:${termToId(value as any)}`;
    }
    return `${typeof value}:${String(value)}`;
  }

  private compileBinaryFilter(
    operator: RdfQueryFilterOperator,
    left: Expression | Pattern | undefined,
    right: Expression | Pattern | undefined,
  ): RdfQueryFilter {
    const leftExpression = this.expressionArg(left);
    const rightExpression = this.expressionArg(right);
    const leftStringLengthVariable = this.stringLengthVariableOrUndefined(leftExpression);
    const rightStringLengthVariable = this.stringLengthVariableOrUndefined(rightExpression);
    if (leftStringLengthVariable && rightStringLengthVariable) {
      return {
        variable: leftStringLengthVariable,
        operator,
        operand: 'stringLength',
        variable2: rightStringLengthVariable,
      };
    }
    if (leftStringLengthVariable) {
      return {
        variable: leftStringLengthVariable,
        operator,
        operand: 'stringLength',
        value: this.filterValue(rightExpression),
      };
    }
    if (rightStringLengthVariable) {
      return {
        variable: rightStringLengthVariable,
        operator: this.reverseBinaryFilter(operator),
        operand: 'stringLength',
        value: this.filterValue(leftExpression),
      };
    }
    const leftFunction = this.compileFunctionComparisonFilter(operator, leftExpression, rightExpression);
    if (leftFunction) {
      return leftFunction;
    }
    const rightFunction = this.compileFunctionComparisonFilter(this.reverseBinaryFilter(operator), rightExpression, leftExpression);
    if (rightFunction) {
      return rightFunction;
    }
    const leftStringOperand = this.stringOperandVariableOrUndefined(leftExpression);
    const rightStringOperand = this.stringOperandVariableOrUndefined(rightExpression);
    if (leftStringOperand && rightStringOperand) {
      if (leftStringOperand.operand !== rightStringOperand.operand) {
        throw new UnsupportedSparqlQueryError('FILTER string expression comparison must use matching operands locally');
      }
      return {
        variable: leftStringOperand.variable,
        operator,
        operand: leftStringOperand.operand,
        variable2: rightStringOperand.variable,
      };
    }
    if (leftStringOperand) {
      return {
        variable: leftStringOperand.variable,
        operator,
        operand: leftStringOperand.operand,
        value: this.literalString(rightExpression),
      };
    }
    if (rightStringOperand) {
      return {
        variable: rightStringOperand.variable,
        operator: this.reverseBinaryFilter(operator),
        operand: rightStringOperand.operand,
        value: this.literalString(leftExpression),
      };
    }
    const leftVariable = this.expressionVariableOrUndefined(leftExpression);
    const rightVariable = this.expressionVariableOrUndefined(rightExpression);

    if (leftVariable && !rightVariable) {
      return {
        variable: leftVariable,
        operator,
        value: this.filterValue(rightExpression),
      };
    }

    if (leftVariable && rightVariable) {
      return {
        variable: leftVariable,
        operator,
        variable2: rightVariable,
      };
    }

    if (rightVariable && !leftVariable) {
      return {
        variable: rightVariable,
        operator: this.reverseBinaryFilter(operator),
        value: this.filterValue(leftExpression),
      };
    }

    throw new UnsupportedSparqlQueryError('FILTER comparison must compare one variable with one RDF term locally');
  }

  private compileTermTestFilter(operator: string, expression: OperationExpression): RdfQueryFilter | null {
    switch (operator) {
      case 'isiri':
      case 'isuri':
        return {
          variable: this.expressionVariable(this.expressionArg(expression.args[0])),
          operator: '$termType',
          value: 'iri',
        };
      case 'isblank':
        return {
          variable: this.expressionVariable(this.expressionArg(expression.args[0])),
          operator: '$termType',
          value: 'blank',
        };
      case 'isliteral':
        return {
          variable: this.expressionVariable(this.expressionArg(expression.args[0])),
          operator: '$termType',
          value: 'literal',
        };
      case 'isnumeric':
        return {
          variable: this.expressionVariable(this.expressionArg(expression.args[0])),
          operator: '$termType',
          value: 'numeric',
        };
      case 'sameterm': {
        const leftExpression = this.expressionArg(expression.args[0]);
        const rightExpression = this.expressionArg(expression.args[1]);
        const leftVariable = this.expressionVariableOrUndefined(leftExpression);
        const rightVariable = this.expressionVariableOrUndefined(rightExpression);
        if (leftVariable && rightVariable) {
          return {
            variable: leftVariable,
            operator: '$sameTerm',
            variable2: rightVariable,
          };
        }
        if (leftVariable) {
          return {
            variable: leftVariable,
            operator: '$sameTerm',
            value: this.filterValue(rightExpression),
          };
        }
        if (rightVariable) {
          return {
            variable: rightVariable,
            operator: '$sameTerm',
            value: this.filterValue(leftExpression),
          };
        }
        throw new UnsupportedSparqlQueryError('sameTerm FILTER must compare at least one variable locally');
      }
      default:
        return null;
    }
  }

  private compileFunctionComparisonFilter(
    operator: RdfQueryFilterOperator,
    functionExpression: Expression,
    valueExpression: Expression,
  ): RdfQueryFilter | null {
    if (operator !== '$eq' && operator !== '$ne') {
      return null;
    }
    if (!isOperationExpression(functionExpression)) {
      return null;
    }
    const functionOperator = functionExpression.operator.toLowerCase();
    if (functionOperator === 'lang') {
      return {
        variable: this.expressionVariable(this.expressionArg(functionExpression.args[0])),
        operator: operator === '$eq' ? '$lang' : '$notLang',
        value: this.literalString(valueExpression),
      };
    }
    if (functionOperator === 'datatype') {
      const value = this.filterValue(valueExpression);
      if (!isNamedNodeTerm(value)) {
        throw new UnsupportedSparqlQueryError('DATATYPE FILTER value must be an IRI locally');
      }
      return {
        variable: this.expressionVariable(this.expressionArg(functionExpression.args[0])),
        operator: operator === '$eq' ? '$datatype' : '$notDatatype',
        value,
      };
    }
    return null;
  }

  private compileFunctionInFilter(
    functionExpression: Expression,
    values: Expression[],
    negated: boolean,
  ): RdfQueryFilter | null {
    if (!isOperationExpression(functionExpression)) {
      return null;
    }
    const functionOperator = functionExpression.operator.toLowerCase();
    if (functionOperator === 'lang') {
      return {
        variable: this.expressionVariable(this.expressionArg(functionExpression.args[0])),
        operator: negated ? '$notLangIn' : '$langIn',
        values: values.map((value) => this.literalString(value)),
      };
    }
    if (functionOperator === 'datatype') {
      const datatypeValues = values.map((value) => this.filterValue(value));
      if (datatypeValues.some((value) => !isNamedNodeTerm(value))) {
        throw new UnsupportedSparqlQueryError('DATATYPE FILTER values must be IRIs locally');
      }
      return {
        variable: this.expressionVariable(this.expressionArg(functionExpression.args[0])),
        operator: negated ? '$notDatatypeIn' : '$datatypeIn',
        values: datatypeValues,
      };
    }
    return null;
  }

  private stringLengthVariableOrUndefined(expression: Expression): string | undefined {
    const normalized = this.normalizeFunctionCallExpression(expression);
    if (!isOperationExpression(normalized) || normalized.operator.toLowerCase() !== 'strlen') {
      return undefined;
    }
    return this.stringOperandVariable(this.expressionArg(normalized.args[0])).variable;
  }

  private stringValueVariableOrUndefined(expression: Expression): string | undefined {
    const operand = this.stringOperandVariableOrUndefined(expression);
    return operand?.operand === 'stringValue' ? operand.variable : undefined;
  }

  private stringOperandVariable(expression: Expression): { variable: string; operand?: RdfQueryFilter['operand'] } {
    const stringOperand = this.stringOperandVariableOrUndefined(expression);
    if (stringOperand) {
      return stringOperand;
    }
    return {
      variable: this.expressionVariable(expression),
    };
  }

  private stringOperandVariableOrUndefined(expression: Expression): { variable: string; operand: RdfQueryFilter['operand'] } | undefined {
    if (isStrOperation(expression)) {
      return {
        variable: this.expressionVariable(this.expressionArg(expression.args[0])),
        operand: 'stringValue',
      };
    }
    const normalized = this.normalizeFunctionCallExpression(expression);
    if (!isOperationExpression(normalized)) {
      return undefined;
    }
    const operator = normalized.operator.toLowerCase();
    if (operator !== 'lcase' && operator !== 'lower-case' && operator !== 'ucase' && operator !== 'upper-case') {
      return undefined;
    }
    const innerOperand = this.stringOperandVariableOrUndefined(this.expressionArg(normalized.args[0]));
    if (!innerOperand || innerOperand.operand !== 'stringValue') {
      return undefined;
    }
    return {
      variable: innerOperand.variable,
      operand: operator === 'lcase' || operator === 'lower-case' ? 'lowerStringValue' : 'upperStringValue',
    };
  }

  private compileLangMatchesFilter(expression: OperationExpression): RdfQueryFilter {
    const langExpression = this.expressionArg(expression.args[0]);
    if (!isOperationExpression(langExpression) || langExpression.operator.toLowerCase() !== 'lang') {
      throw new UnsupportedSparqlQueryError('LANGMATCHES first argument must be LANG(?var) locally');
    }
    return {
      variable: this.expressionVariable(this.expressionArg(langExpression.args[0])),
      operator: '$langMatches',
      value: this.literalString(this.expressionArg(expression.args[1])),
    };
  }

  private compileValuesRows(rows: ValuePatternRow[], state: CompileState, optional = false): void {
    if (rows.length === 0) {
      return;
    }

    const keys = unique(rows.flatMap((row) => Object.keys(row))).sort();

    if (keys.length === 0) {
      return;
    }
    const hasUnboundValues = rows.some((row) => keys.some((key) => !row[key]));

    if (!optional && keys.length === 1 && !hasUnboundValues) {
      const key = keys[0];
      state.query.filters?.push({
        variable: key.replace(/^\?/, ''),
        operator: '$in',
        values: rows.map((row) => this.filterValue(row[key] as Expression)),
        source: 'values',
      });
      return;
    }

    const variables = keys.map((key) => key.replace(/^\?/, ''));
    state.addValuesSource({
      variables,
      rows: rows.map((row) => {
        const binding: RdfBindingRow = {};
        keys.forEach((key, index) => {
          const expression = row[key];
          if (expression) {
            binding[variables[index]] = this.valuesTerm(expression as Expression);
          }
        });
        return binding;
      }),
    }, optional);
  }

  private valuesTerm(expression: Expression): Term {
    const value = this.filterValue(expression);
    if (!isRdfJsTerm(value)) {
      throw new UnsupportedSparqlQueryError('VALUES rows must contain RDF terms locally');
    }
    return value;
  }

  private compileNegatedFilter(expression: Expression): RdfQueryFilter[] {
    if (!isOperationExpression(expression)) {
      throw new UnsupportedSparqlQueryError('Only safely negated FILTER operations are supported locally');
    }

    const operator = expression.operator.toLowerCase();
    if (operator === 'bound') {
      return [{
        variable: this.expressionVariable(this.expressionArg(expression.args[0])),
        operator: '$bound',
        value: false,
      }];
    }
    const termTest = this.compileTermTestFilter(operator, expression);
    if (termTest) {
      return [this.negateTermTestFilter(termTest)];
    }
    if (operator === 'langmatches') {
      const filter = this.compileLangMatchesFilter(expression);
      return [{
        ...filter,
        operator: '$notLangMatches',
      }];
    }
    if (operator === '||') {
      const filter = this.compileOrFilter(expression);
      return [{
        ...filter,
        operator: '$notIn',
      }];
    }

    const binary = this.negatedBinaryFilter(operator);
    if (binary) {
      return [this.compileBinaryFilter(binary, expression.args[0], expression.args[1])];
    }

    if (operator === 'in' || operator === 'notin') {
      const values = expression.args[1];
      if (!Array.isArray(values)) {
        throw new UnsupportedSparqlQueryError('FILTER negated IN tuple fallback to compatibility engine');
      }
      const functionFilter = this.compileFunctionInFilter(
        this.expressionArg(expression.args[0]),
        values,
        operator === 'in',
      );
      if (functionFilter) {
        return [functionFilter];
      }
      const operand = this.stringOperandVariable(this.expressionArg(expression.args[0]));
      return [{
        variable: operand.variable,
        operator: operator === 'in' ? '$notIn' : '$in',
        operand: operand.operand,
        values: values.map((value) => this.filterValue(value)),
      }];
    }

    const stringOperator = this.stringFilter(operator);
    if (stringOperator) {
      const [left, right, flags] = expression.args;
      const leftOperand = this.stringOperandVariable(this.expressionArg(left));
      return [{
        variable: leftOperand.variable,
        operator: this.negatedStringFilter(stringOperator),
        operand: leftOperand.operand,
        value: this.literalString(this.expressionArg(right)),
        flags: operator === 'regex' && flags ? this.literalString(this.expressionArg(flags)) : undefined,
      }];
    }

    throw new UnsupportedSparqlQueryError(`FILTER !${operator} fallback to compatibility engine`);
  }

  private expressionArg(value: Expression | Pattern | undefined): Expression {
    if (!value || (value as Pattern).type === 'bgp') {
      throw new UnsupportedSparqlQueryError('Unsupported FILTER argument');
    }
    return this.normalizeFunctionCallExpression(value as Expression);
  }

  private expressionVariable(expression: Expression): string {
    if (isVariableTerm(expression)) {
      return expression.value;
    }
    throw new UnsupportedSparqlQueryError('Only variable expressions are supported in this query position');
  }

  private expressionVariableOrUndefined(expression: Expression): string | undefined {
    return isVariableTerm(expression) ? expression.value : undefined;
  }

  private filterValue(expression: Expression): Term | string | number | boolean {
    if (isRdfTermExpression(expression)) {
      return expression as unknown as Term;
    }
    throw new UnsupportedSparqlQueryError('Only RDF term filter values are supported locally');
  }

  private literalString(expression: Expression): string {
    if (isLiteralTerm(expression)) {
      return expression.value;
    }
    throw new UnsupportedSparqlQueryError('String FILTER arguments must be literals');
  }

  private binaryFilter(operator: string): RdfQueryFilterOperator | null {
    switch (operator) {
      case '=':
        return '$eq';
      case '!=':
        return '$ne';
      case '>':
        return '$gt';
      case '>=':
        return '$gte';
      case '<':
        return '$lt';
      case '<=':
        return '$lte';
      default:
        return null;
    }
  }

  private reverseBinaryFilter(operator: RdfQueryFilterOperator): RdfQueryFilterOperator {
    switch (operator) {
      case '$eq':
      case '$ne':
        return operator;
      case '$gt':
        return '$lt';
      case '$gte':
        return '$lte';
      case '$lt':
        return '$gt';
      case '$lte':
        return '$gte';
      default:
        throw new UnsupportedSparqlQueryError(`FILTER ${operator} cannot be reversed locally`);
    }
  }

  private negatedBinaryFilter(operator: string): RdfQueryFilterOperator | null {
    switch (operator) {
      case '=':
        return '$ne';
      case '!=':
        return '$eq';
      case '>':
        return '$lte';
      case '>=':
        return '$lt';
      case '<':
        return '$gte';
      case '<=':
        return '$gt';
      default:
        return null;
    }
  }

  private stringFilter(operator: string): RdfQueryFilterOperator | null {
    switch (operator) {
      case 'strstarts':
        return '$startsWith';
      case 'contains':
        return '$contains';
      case 'strends':
        return '$endsWith';
      case 'regex':
        return '$regex';
      default:
        return null;
    }
  }

  private negatedStringFilter(operator: RdfQueryFilterOperator): RdfQueryFilterOperator {
    switch (operator) {
      case '$startsWith':
        return '$notStartsWith';
      case '$contains':
        return '$notContains';
      case '$endsWith':
        return '$notEndsWith';
      case '$regex':
        return '$notRegex';
      default:
        throw new UnsupportedSparqlQueryError(`FILTER !${operator} fallback to compatibility engine`);
    }
  }

  private negateTermTestFilter(filter: RdfQueryFilter): RdfQueryFilter {
    switch (filter.operator) {
      case '$termType':
        return {
          ...filter,
          operator: '$notTermType',
        };
      case '$sameTerm':
        return {
          ...filter,
          operator: '$notSameTerm',
        };
      default:
        throw new UnsupportedSparqlQueryError(`FILTER !${filter.operator} fallback to compatibility engine`);
    }
  }

  private normalizeFunctionCallExpression(expression: Expression): Expression {
    if (!isFunctionCallExpression(expression)) {
      return expression;
    }
    if (expression.distinct) {
      throw new UnsupportedSparqlQueryError('DISTINCT function calls fallback to compatibility engine');
    }
    const functionIri = typeof expression.function === 'string'
      ? expression.function
      : expression.function.value;
    const operator = this.xpathFunctionOperator(functionIri);
    if (!operator) {
      throw new UnsupportedSparqlQueryError(`Unsupported SPARQL function ${functionIri} fallback to compatibility engine`);
    }
    return {
      type: 'operation',
      operator,
      args: expression.args.map((arg) => (
        Array.isArray(arg)
          ? arg.map((item) => this.normalizeFunctionCallExpression(this.expressionArg(item)))
          : this.normalizeFunctionCallExpression(this.expressionArg(arg))
      )),
    } as OperationExpression;
  }

  private xpathFunctionOperator(iri: string): string | null {
    if (!iri.startsWith(XPATH_FUNCTION_NS)) {
      return null;
    }
    switch (iri.slice(XPATH_FUNCTION_NS.length).toLowerCase()) {
      case 'concat':
        return 'concat';
      case 'contains':
        return 'contains';
      case 'starts-with':
        return 'strstarts';
      case 'ends-with':
        return 'strends';
      case 'matches':
        return 'regex';
      case 'string-length':
        return 'strlen';
      case 'lower-case':
        return 'lcase';
      case 'upper-case':
        return 'ucase';
      case 'substring':
        return 'substring';
      case 'langmatches':
        return 'langmatches';
      default:
        return null;
    }
  }
}

class CompileState {
  public readonly query: RdfLocalQuery = {
    patterns: [],
    unions: [],
    optional: [],
    filters: [],
  };

  private readonly optionalStack: OptionalFrame[] = [];
  private pathJoinVariableIndex = 0;
  private groupVariableIndex = 0;
  private orderVariableIndex = 0;
  private havingAggregateVariableIndex = 0;
  public visibleSolutionVariables: string[] | undefined;

  public constructor(
    public readonly basePath: string,
    private readonly skipMinusSharedVariableCheck = false,
  ) {}

  public setVisibleSolutionVariables(variables: string[]): void {
    this.visibleSolutionVariables = variables;
  }

  public addPattern(pattern: RdfQueryPattern, optional: boolean): void {
    if (optional) {
      this.currentOptionalFrame().patterns.push(this.scopePattern(pattern));
      return;
    }
    this.query.patterns.push(this.scopePattern(pattern));
  }

  public addImpossibleGraphPattern(optional: boolean): void {
    const impossible = DataFactory.namedNode(`${this.basePath}__outside_graph_scope__`) as unknown as NamedNode;
    this.addPattern({ graph: impossible }, optional);
  }

  public startOptional(): void {
    this.optionalStack.push({
      patterns: [],
      filters: [],
      binds: [],
      unions: [],
      values: [],
      optional: [],
      minus: [],
      exists: [],
    });
  }

  public finishOptional(): void {
    const frame = this.optionalStack.pop();
    if (!frame) {
      throw new UnsupportedSparqlQueryError('OPTIONAL scope fallback to compatibility engine');
    }
    if (
      frame.patterns.length > 0
        || frame.filters.length > 0
        || frame.binds.length > 0
        || frame.unions.length > 0
        || frame.values.length > 0
        || frame.optional.length > 0
        || frame.minus.length > 0
        || frame.exists.length > 0
    ) {
      const optionalGroup: RdfOptionalQueryGroup = {
        patterns: frame.patterns,
        ...(frame.values.length ? { values: frame.values } : {}),
        ...(frame.unions.length ? { unions: frame.unions } : {}),
        ...(frame.optional.length ? { optional: frame.optional } : {}),
        ...(frame.minus.length ? { minus: frame.minus } : {}),
        ...(frame.exists.length ? { exists: frame.exists } : {}),
        ...(frame.binds.length ? { binds: frame.binds } : {}),
        ...(frame.filters.length > 0 ? { filters: frame.filters } : {}),
      };
      const parent = this.peekOptionalFrame();
      if (parent) {
        parent.optional.push(optionalGroup);
      } else {
        this.query.optional?.push(optionalGroup);
      }
    }
  }

  public addOptionalFilters(filters: RdfQueryFilter[]): void {
    this.currentOptionalFrame().filters.push(...filters);
  }

  public addBind(bind: RdfQueryBind, optional: boolean): void {
    if (optional) {
      this.currentOptionalFrame().binds.push(bind);
      return;
    }
    this.query.binds ??= [];
    this.query.binds.push(bind);
  }

  public addOptionalUnion(branches: RdfUnionQueryBranch[]): void {
    this.currentOptionalFrame().unions.push({ branches });
  }

  public addUnion(branches: RdfUnionQueryBranch[]): void {
    this.query.unions?.push({ branches });
  }

  public addOptionalMinus(group: RdfMinusQueryGroup): void {
    this.currentOptionalFrame().minus.push(group);
  }

  public addMinus(group: RdfMinusQueryGroup): void {
    this.query.minus ??= [];
    this.query.minus.push(group);
  }

  public addOptionalExists(group: RdfExistsQueryGroup): void {
    this.currentOptionalFrame().exists.push(group);
  }

  public addExists(group: RdfExistsQueryGroup): void {
    this.query.exists ??= [];
    this.query.exists.push(group);
  }

  public addValuesSource(source: RdfValuesBindingSource, optional: boolean): void {
    if (optional) {
      this.currentOptionalFrame().values.push(source);
      return;
    }
    this.query.values ??= [];
    this.query.values.push(source);
  }

  public nextPathJoinVariable(): RdfQueryTermPattern {
    this.pathJoinVariableIndex += 1;
    return rdfVar(`${PATH_JOIN_VARIABLE_PREFIX}_${this.pathJoinVariableIndex}`);
  }

  public nextGroupVariable(index: number): string {
    this.groupVariableIndex += 1;
    return `__rdf_group_${index}_${this.groupVariableIndex}`;
  }

  public nextOrderVariable(index: number): string {
    this.orderVariableIndex += 1;
    return `__rdf_order_${index}_${this.orderVariableIndex}`;
  }

  public nextHavingAggregateVariable(): string {
    this.havingAggregateVariableIndex += 1;
    return `__rdf_having_aggregate_${this.havingAggregateVariableIndex}`;
  }

  public assertValuesVariablesBoundByRequiredPatterns(): void {
    for (const source of this.query.values ?? []) {
      for (const variable of source.variables) {
        if (!this.isVariableBoundByRequiredShape(variable)) {
          throw new UnsupportedSparqlQueryError('VALUES must constrain a variable from every required embedded query branch');
        }
      }
    }
    for (const filter of this.query.filters ?? []) {
      if (filter.operator !== '$in' || filter.source !== 'values') {
        continue;
      }
      if (!this.isVariableBoundByRequiredShape(filter.variable)) {
        throw new UnsupportedSparqlQueryError('VALUES must constrain a variable from every required embedded query branch');
      }
    }
  }

  public assertBindVariablesSafe(): void {
    const bound = new Set<string>();
    for (const variableName of variablesInPatterns(this.query.patterns)) {
      bound.add(variableName);
    }
    for (const unionGroup of this.query.unions ?? []) {
      for (const branch of unionGroup.branches) {
        for (const variableName of variablesInPatterns(branch.patterns)) {
          bound.add(variableName);
        }
        for (const bind of branch.binds ?? []) {
          for (const dependency of variablesInBindExpression(bind.expression)) {
            if (!bound.has(dependency)) {
              throw new UnsupportedSparqlQueryError('BIND dependency must be bound before use locally');
            }
          }
          bound.add(bind.variable);
        }
      }
    }
    for (const bind of this.query.binds ?? []) {
      for (const dependency of variablesInBindExpression(bind.expression)) {
        if (!bound.has(dependency)) {
          throw new UnsupportedSparqlQueryError('BIND dependency must be bound before use locally');
        }
      }
      bound.add(bind.variable);
    }
    for (const rawOptionalGroup of this.query.optional ?? []) {
      assertOptionalBindVariablesSafe(rawOptionalGroup, bound);
    }
  }

  public assertDependentGroupsShareRequiredVariables(): void {
    if (this.skipMinusSharedVariableCheck) {
      return;
    }
    for (const minusGroup of this.query.minus ?? []) {
      const shared = variablesInDependentGroup(minusGroup)
        .some((variableName) => queryBindsVariableInRequiredShape(this.query, variableName));
      if (!shared) {
        throw new UnsupportedSparqlQueryError('MINUS must share a required query variable locally');
      }
    }
    for (const existsGroup of this.query.exists ?? []) {
      const shared = variablesInDependentGroup(existsGroup)
        .some((variableName) => queryBindsVariableInRequiredShape(this.query, variableName));
      if (!shared) {
        throw new UnsupportedSparqlQueryError('FILTER EXISTS must share a required query variable locally');
      }
    }
    const requiredBound = variablesBoundByRequiredShape(this.query);
    for (const optionalGroup of this.query.optional ?? []) {
      assertOptionalDependentGroupsShareVariables(normalizeOptionalGroupForAdapter(optionalGroup), requiredBound);
    }
  }

  private isVariableBoundByRequiredShape(variableName: string): boolean {
    return queryBindsVariableInRequiredShape(this.query, variableName);
  }

  private scopePattern(pattern: RdfQueryPattern): RdfQueryPattern {
    return pattern.graph ? pattern : { ...pattern, graph: implicitQueryDefaultGraph(this.basePath) };
  }

  private currentOptionalFrame(): OptionalFrame {
    const frame = this.peekOptionalFrame();
    if (!frame) {
      throw new UnsupportedSparqlQueryError('OPTIONAL scope fallback to compatibility engine');
    }
    return frame;
  }

  private peekOptionalFrame(): OptionalFrame | undefined {
    return this.optionalStack[this.optionalStack.length - 1];
  }
}

function implicitQueryDefaultGraph(basePath: string): RdfQueryTermPattern {
  return basePath.endsWith('/')
    ? { $startsWith: basePath }
    : DataFactory.namedNode(basePath) as unknown as Term;
}

function isVariableTerm(value: Variable | Expression): value is VariableTerm {
  return Boolean(value && 'termType' in value && value.termType === 'Variable');
}

function isSelectVariableTerm(value: Variable | Wildcard): value is VariableTerm {
  return Boolean(value && 'termType' in value && value.termType === 'Variable');
}

function isVariableExpression(value: Variable | Wildcard): value is VariableExpression {
  return Boolean(value && 'expression' in value && 'variable' in value);
}

function isVariableExpressionTerm(value: Expression): value is VariableTerm {
  return Boolean(value && 'termType' in value && value.termType === 'Variable');
}

function isOperationExpression(value: Expression): value is OperationExpression {
  return Boolean(value && 'type' in value && value.type === 'operation');
}

function isStrOperation(value: Expression): value is OperationExpression {
  return isOperationExpression(value) && value.operator.toLowerCase() === 'str';
}

function isFunctionCallExpression(value: Expression): value is FunctionCallExpression {
  return Boolean(value && 'type' in value && value.type === 'functionCall');
}

function isAggregateExpression(value: Expression): value is AggregateExpression {
  return Boolean(value && 'type' in value && value.type === 'aggregate');
}

function isLiteralTerm(value: Expression): value is LiteralTerm {
  return Boolean(value && 'termType' in value && value.termType === 'Literal');
}

function isWildcardTerm(value: Expression | Wildcard): value is Wildcard {
  return value instanceof Wildcard;
}

function isRdfTermExpression(value: Expression): value is LiteralTerm | IriTerm | VariableTerm {
  return Boolean(value && 'termType' in value && value.termType !== 'Quad');
}

function isNamedNodeTerm(value: unknown): value is NamedNode {
  return Boolean(value && typeof value === 'object' && 'termType' in value && value.termType === 'NamedNode');
}

function isRdfJsTerm(value: unknown): value is Term {
  return Boolean(value && typeof value === 'object' && 'termType' in value);
}

function isSimpleTerm(value: Triple['predicate']): value is IriTerm | VariableTerm {
  return Boolean(value && 'termType' in value);
}

function visibleSelectVariables(query: { where?: Pattern[]; values?: ValuePatternRow[] }): string[] {
  const variables = new Set<string>();
  for (const pattern of query.where ?? []) {
    collectPatternVariables(pattern, variables);
  }
  for (const row of query.values ?? []) {
    for (const key of Object.keys(row)) {
      variables.add(key.replace(/^\?/, ''));
    }
  }
  return [...variables];
}

function collectPatternVariables(pattern: Pattern, variables: Set<string>): void {
  switch (pattern.type) {
    case 'bgp':
      for (const triple of pattern.triples) {
        collectTripleVariables(triple, variables);
      }
      break;
    case 'graph':
      if (pattern.name.termType === 'Variable') {
        variables.add(pattern.name.value);
      }
      for (const child of pattern.patterns) {
        collectPatternVariables(child, variables);
      }
      break;
    case 'optional':
    case 'group':
    case 'union':
    case 'minus':
    case 'service':
      for (const child of pattern.patterns) {
        collectPatternVariables(child, variables);
      }
      break;
    case 'filter':
      collectExpressionVariables(pattern.expression, variables);
      break;
    case 'bind':
      collectExpressionVariables(pattern.expression, variables);
      variables.add(pattern.variable.value);
      break;
    case 'values':
      for (const row of pattern.values) {
        for (const key of Object.keys(row)) {
          variables.add(key.replace(/^\?/, ''));
        }
      }
      break;
    default:
      if ('queryType' in pattern) {
        for (const child of pattern.where ?? []) {
          collectPatternVariables(child, variables);
        }
      }
      break;
  }
}

function collectTripleVariables(triple: Triple, variables: Set<string>): void {
  collectTermVariables(triple.subject, variables);
  if (isSimpleTerm(triple.predicate)) {
    collectTermVariables(triple.predicate, variables);
  } else {
    collectPathVariables(triple.predicate, variables);
  }
  collectTermVariables(triple.object, variables);
}

function collectPathVariables(path: PropertyPath, variables: Set<string>): void {
  for (const item of path.items) {
    if (isSimpleTerm(item)) {
      collectTermVariables(item, variables);
    } else {
      collectPathVariables(item, variables);
    }
  }
}

function collectExpressionVariables(expression: Expression, variables: Set<string>): void {
  if (isVariableTerm(expression)) {
    variables.add(expression.value);
    return;
  }
  if (!expression || typeof expression !== 'object' || !('type' in expression)) {
    return;
  }
  if (isOperationExpression(expression) || isFunctionCallExpression(expression)) {
    for (const arg of expression.args) {
      if (Array.isArray(arg)) {
        for (const item of arg) {
          collectExpressionVariables(item, variables);
        }
      } else if (arg && !isPattern(arg)) {
        collectExpressionVariables(arg as Expression, variables);
      }
    }
    return;
  }
  if (isAggregateExpression(expression) && !isWildcardTerm(expression.expression)) {
    collectExpressionVariables(expression.expression, variables);
  }
}

function collectTermVariables(term: SparqlTerm, variables: Set<string>): void {
  if (term.termType === 'Variable') {
    variables.add(term.value);
  }
}

function isPattern(value: Expression | Pattern): value is Pattern {
  return Boolean(
    value
      && typeof value === 'object'
      && 'type' in value
      && [
        'bgp',
        'optional',
        'union',
        'group',
        'graph',
        'minus',
        'service',
        'filter',
        'bind',
        'values',
        'query',
      ].includes(value.type),
  );
}

function isCompiledVariable(value: RdfQueryTermPattern): value is { variable: string } {
  return Boolean(value && typeof value === 'object' && 'variable' in value);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueTerms<T extends Term>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = termToId(value as any);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function variablesInPattern(pattern: RdfQueryPattern): string[] {
  const values = [pattern.graph, pattern.subject, pattern.predicate, pattern.object];
  return values
    .filter((value): value is { variable: string } => Boolean(value && typeof value === 'object' && 'variable' in value))
    .map((value) => value.variable);
}

function patternsBindVariable(patterns: RdfQueryPattern[], variableName: string): boolean {
  return patterns.some((pattern) => variablesInPattern(pattern).includes(variableName));
}

function variablesInPatterns(patterns: RdfQueryPattern[]): string[] {
  return unique(patterns.flatMap((pattern) => variablesInPattern(pattern)));
}

function variablesBoundByOptionalGroup(optionalGroup: RdfOptionalQueryGroup): string[] {
  return unique([
    ...variablesInPatterns(optionalGroup.patterns),
    ...variablesInValuesSources(optionalGroup.values ?? []),
    ...variablesInUnionGroups(optionalGroup.unions ?? []),
    ...((optionalGroup.binds ?? []).map((bind) => bind.variable)),
  ]);
}

function variablesInUnionGroups(unions: RdfUnionQueryGroup[]): string[] {
  return unique(unions.flatMap((unionGroup) => (
    unionGroup.branches.flatMap((branch) => [
      ...variablesInPatterns(branch.patterns),
      ...variablesInValuesSources(branch.values ?? []),
      ...((branch.binds ?? []).map((bind) => bind.variable)),
    ])
  )));
}

function variablesBoundByRequiredShape(query: RdfLocalQuery): Set<string> {
  return new Set([
    ...variablesInPatterns(query.patterns),
    ...variablesInValuesSources(query.values ?? []),
    ...variablesInUnionGroups(query.unions ?? []),
    ...((query.binds ?? []).map((bind) => bind.variable)),
  ]);
}

function hasNumericGuard(filters: RdfQueryFilter[], variableName: string): boolean {
  return filters.some((filter) => (
    filter.variable === variableName
      && filter.operator === '$termType'
      && filter.value === 'numeric'
  ));
}

function variablesInDependentGroup(group: RdfMinusQueryGroup | RdfExistsQueryGroup): string[] {
  return unique([
    ...variablesInPatterns(group.patterns),
    ...variablesInValuesSources(group.values ?? []),
    ...variablesInUnionGroups(group.unions ?? []),
    ...((group.binds ?? []).map((bind) => bind.variable)),
    ...variablesBoundByNestedOptionalGroups(group.optional ?? []),
  ]);
}

function variablesBoundByNestedOptionalGroups(groups: Array<RdfQueryPattern[] | RdfOptionalQueryGroup>): string[] {
  return unique(groups.flatMap((group) => variablesBoundByOptionalGroup(normalizeOptionalGroupForAdapter(group))));
}

function variablesInValuesSources(sources: RdfValuesBindingSource[]): string[] {
  return unique(sources.flatMap((source) => source.variables));
}

function variablesInBindExpression(expression: RdfBindExpression): string[] {
  switch (expression.type) {
    case 'term':
      return [];
    case 'variable':
    case 'stringValue':
    case 'stringLength':
      return [expression.variable];
    case 'lowerCase':
    case 'upperCase':
      return variablesInBindExpression(expression.expression);
    case 'coalesce':
      return unique(expression.expressions.flatMap((item) => variablesInBindExpression(item)));
    case 'if':
      return unique([
        ...variablesInFilters(expression.condition),
        ...variablesInBindExpression(expression.then),
        ...variablesInBindExpression(expression.else),
      ]);
    case 'substring':
      return unique([
        ...variablesInBindExpression(expression.expression),
        ...variablesInBindExpression(expression.start),
        ...(expression.length ? variablesInBindExpression(expression.length) : []),
      ]);
    case 'concat':
      return unique(expression.expressions.flatMap((item) => variablesInBindExpression(item)));
    case 'iri':
      return variablesInBindExpression(expression.expression);
    case 'strdt':
      return unique([
        ...variablesInBindExpression(expression.lexical),
        ...variablesInBindExpression(expression.datatype),
      ]);
    case 'strlang':
      return unique([
        ...variablesInBindExpression(expression.lexical),
        ...variablesInBindExpression(expression.language),
      ]);
    default: {
      const exhaustive: never = expression;
      return exhaustive;
    }
  }
}

function variablesInFilters(filters: RdfQueryFilter[]): string[] {
  return unique(filters.flatMap((filter) => [
    filter.variable,
    filter.variable2,
  ].filter((value): value is string => Boolean(value))));
}

function assertOptionalBindVariablesSafe(
  rawOptionalGroup: RdfQueryPattern[] | RdfOptionalQueryGroup,
  outerBound: Set<string>,
): void {
  const optionalGroup = normalizeOptionalGroupForAdapter(rawOptionalGroup);
  const optionalBound = new Set(outerBound);
  for (const variableName of variablesInPatterns(optionalGroup.patterns)) {
    optionalBound.add(variableName);
  }
  for (const variableName of variablesInValuesSources(optionalGroup.values ?? [])) {
    optionalBound.add(variableName);
  }
  for (const unionGroup of optionalGroup.unions ?? []) {
    for (const branch of unionGroup.branches) {
      const branchBound = new Set(optionalBound);
      for (const variableName of variablesInPatterns(branch.patterns)) {
        branchBound.add(variableName);
      }
      for (const variableName of variablesInValuesSources(branch.values ?? [])) {
        branchBound.add(variableName);
      }
      for (const bind of branch.binds ?? []) {
        assertBindDependenciesBound(bind, branchBound);
        branchBound.add(bind.variable);
      }
      for (const variableName of branchBound) {
        optionalBound.add(variableName);
      }
    }
  }
  for (const bind of optionalGroup.binds ?? []) {
    assertBindDependenciesBound(bind, optionalBound);
    optionalBound.add(bind.variable);
  }
  for (const nestedOptionalGroup of optionalGroup.optional ?? []) {
    assertOptionalBindVariablesSafe(nestedOptionalGroup, optionalBound);
  }
}

function assertOptionalDependentGroupsShareVariables(
  optionalGroup: RdfOptionalQueryGroup,
  outerBound: Set<string> = new Set(),
): void {
  const bound = new Set(outerBound);
  for (const variableName of variablesBoundByOptionalGroup(optionalGroup)) {
    bound.add(variableName);
  }

  for (const minusGroup of optionalGroup.minus ?? []) {
    const shared = variablesInDependentGroup(minusGroup).some((variableName) => bound.has(variableName));
    if (!shared) {
      throw new UnsupportedSparqlQueryError('OPTIONAL MINUS must share a locally bound optional variable');
    }
  }
  for (const existsGroup of optionalGroup.exists ?? []) {
    const shared = variablesInDependentGroup(existsGroup).some((variableName) => bound.has(variableName));
    if (!shared) {
      throw new UnsupportedSparqlQueryError('OPTIONAL FILTER EXISTS must share a locally bound optional variable');
    }
  }
  for (const nestedOptionalGroup of optionalGroup.optional ?? []) {
    assertOptionalDependentGroupsShareVariables(normalizeOptionalGroupForAdapter(nestedOptionalGroup), bound);
  }
}

function assertBindDependenciesBound(bind: RdfQueryBind, bound: Set<string>): void {
  for (const dependency of variablesInBindExpression(bind.expression)) {
    if (!bound.has(dependency)) {
      throw new UnsupportedSparqlQueryError('OPTIONAL BIND dependency must be bound before use locally');
    }
  }
}

function queryBindsVariableInRequiredShape(query: RdfLocalQuery, variableName: string): boolean {
  if (patternsBindVariable(query.patterns, variableName)) {
    return true;
  }
  if ((query.unions?.length ?? 0) === 0) {
    return false;
  }
  return (query.unions ?? []).every((group) => (
    group.branches.every((branch) => patternsBindVariable(branch.patterns, variableName))
  ));
}

function normalizeOptionalGroupForAdapter(group: RdfQueryPattern[] | RdfOptionalQueryGroup): RdfOptionalQueryGroup {
  return Array.isArray(group) ? { patterns: group } : group;
}
