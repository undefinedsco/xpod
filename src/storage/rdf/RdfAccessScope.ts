import { DataFactory } from 'n3';
import type { Term } from '@rdfjs/types';
import { isTerm } from '../quint/types';
import type {
  RdfQuery,
  RdfQueryFilter,
  RdfQueryPattern,
  RdfQueryTermPattern,
  RdfUnionQueryBranch,
  RdfUnionQueryGroup,
  RdfMinusQueryGroup,
  RdfExistsQueryGroup,
  RdfOptionalQueryGroup,
  RdfQueryVariable,
  RdfQueryCacheScope,
} from './types';

export type RdfAccessMode = 'read' | 'append' | 'delete' | 'write';

export interface RdfAccessScope {
  basePath: string;
  mode: RdfAccessMode;
  principal?: string;
  allowedGraphUrls?: string[];
  deniedGraphUrls?: string[];
  deniedGraphPrefixes?: string[];
  version?: string;
}

interface ApplyState {
  impossibleGraph: Term;
}

export function isRestrictiveRdfAccessScope(scope?: RdfAccessScope): boolean {
  return Boolean(
    scope
      && (
        (scope.allowedGraphUrls?.length ?? 0) > 0
        || (scope.deniedGraphUrls?.length ?? 0) > 0
        || (scope.deniedGraphPrefixes?.length ?? 0) > 0
      ),
  );
}

export function rdfAccessCacheScope(scope?: RdfAccessScope): RdfQueryCacheScope | undefined {
  if (!scope) {
    return undefined;
  }
  return {
    mode: scope.mode,
    principal: scope.principal ?? 'anonymous',
    basePath: scope.basePath,
    permissionVersion: scope.version ?? 'unversioned',
    allowedGraphUrls: scope.allowedGraphUrls,
    deniedGraphUrls: scope.deniedGraphUrls,
    deniedGraphPrefixes: scope.deniedGraphPrefixes,
  };
}

export function applyRdfAccessScope(query: RdfQuery, scope?: RdfAccessScope): RdfQuery {
  const cacheScope = rdfAccessCacheScope(scope);
  if (!isRestrictiveRdfAccessScope(scope)) {
    return cacheScope
      ? {
          ...query,
          cache: {
            ...query.cache,
            scope: mergeRdfQueryCacheScopes(query.cache?.scope, cacheScope),
          },
        }
      : query;
  }

  const state: ApplyState = {
    impossibleGraph: DataFactory.namedNode('urn:xpod:rdf-access-denied') as unknown as Term,
  };
  const scoped = applyScopeToQuery(query, scope!, state);
  return {
    ...scoped,
    cache: {
      ...scoped.cache,
      scope: mergeRdfQueryCacheScopes(scoped.cache?.scope, cacheScope),
    },
  };
}

function mergeRdfQueryCacheScopes(
  existing: RdfQueryCacheScope | undefined,
  access: RdfQueryCacheScope | undefined,
): RdfQueryCacheScope | undefined {
  if (!existing) {
    return access;
  }
  if (!access) {
    return existing;
  }
  return [existing, access];
}

export function filterRdfAccessGraphs(graphs: Iterable<string>, scope?: RdfAccessScope): Set<string> {
  if (!isRestrictiveRdfAccessScope(scope)) {
    return new Set(graphs);
  }
  const filtered = new Set<string>();
  for (const graph of graphs) {
    if (rdfAccessGraphAllowed(graph, scope!)) {
      filtered.add(graph);
    }
  }
  return filtered;
}

export function rdfAccessGraphAllowed(graph: string, scope: RdfAccessScope): boolean {
  if (scope.allowedGraphUrls?.length && !scope.allowedGraphUrls.includes(graph)) {
    return false;
  }
  if (scope.deniedGraphUrls?.includes(graph)) {
    return false;
  }
  return !(scope.deniedGraphPrefixes ?? []).some((prefix) => graph.startsWith(prefix));
}

function applyScopeToQuery(query: RdfQuery, scope: RdfAccessScope, state: ApplyState): RdfQuery {
  const rootFilters: RdfQueryFilter[] = [...(query.filters ?? [])];
  const patterns = query.patterns.map((pattern) => scopePattern(pattern, rootFilters, scope, state));
  return {
    ...query,
    patterns,
    filters: rootFilters.length > 0 ? rootFilters : undefined,
    unions: query.unions?.map((group) => scopeUnionGroup(group, scope, state)),
    minus: query.minus?.map((group) => scopeMinusGroup(group, scope, state)),
    exists: query.exists?.map((group) => scopeExistsGroup(group, scope, state)),
    optional: query.optional?.map((group) => scopeOptionalGroup(group, scope, state)),
  };
}

function scopeUnionGroup(group: RdfUnionQueryGroup, scope: RdfAccessScope, state: ApplyState): RdfUnionQueryGroup {
  return {
    branches: group.branches.map((branch) => scopeUnionBranch(branch, scope, state)),
  };
}

function scopeUnionBranch(branch: RdfUnionQueryBranch, scope: RdfAccessScope, state: ApplyState): RdfUnionQueryBranch {
  const filters: RdfQueryFilter[] = [...(branch.filters ?? [])];
  return {
    ...branch,
    patterns: branch.patterns.map((pattern) => scopePattern(pattern, filters, scope, state)),
    filters: filters.length > 0 ? filters : undefined,
    unions: branch.unions?.map((group) => scopeUnionGroup(group, scope, state)),
    optional: branch.optional?.map((group) => scopeOptionalGroup(group, scope, state)),
  };
}

function scopeMinusGroup(group: RdfMinusQueryGroup, scope: RdfAccessScope, state: ApplyState): RdfMinusQueryGroup {
  const filters: RdfQueryFilter[] = [...(group.filters ?? [])];
  return {
    ...group,
    patterns: group.patterns.map((pattern) => scopePattern(pattern, filters, scope, state)),
    filters: filters.length > 0 ? filters : undefined,
    unions: group.unions?.map((union) => scopeUnionGroup(union, scope, state)),
  };
}

function scopeExistsGroup(group: RdfExistsQueryGroup, scope: RdfAccessScope, state: ApplyState): RdfExistsQueryGroup {
  const filters: RdfQueryFilter[] = [...(group.filters ?? [])];
  return {
    ...group,
    patterns: group.patterns.map((pattern) => scopePattern(pattern, filters, scope, state)),
    filters: filters.length > 0 ? filters : undefined,
    unions: group.unions?.map((union) => scopeUnionGroup(union, scope, state)),
  };
}

function scopeOptionalGroup(
  group: RdfQueryPattern[] | RdfOptionalQueryGroup,
  scope: RdfAccessScope,
  state: ApplyState,
): RdfQueryPattern[] | RdfOptionalQueryGroup {
  if (Array.isArray(group)) {
    const ignoredFilters: RdfQueryFilter[] = [];
    return group.map((pattern) => scopePattern(pattern, ignoredFilters, scope, state));
  }

  const filters: RdfQueryFilter[] = [...(group.filters ?? [])];
  return {
    ...group,
    patterns: group.patterns.map((pattern) => scopePattern(pattern, filters, scope, state)),
    filters: filters.length > 0 ? filters : undefined,
    unions: group.unions?.map((union) => scopeUnionGroup(union, scope, state)),
    optional: group.optional?.map((optional) => scopeOptionalGroup(optional, scope, state)),
    minus: group.minus?.map((minus) => scopeMinusGroup(minus, scope, state)),
    exists: group.exists?.map((exists) => scopeExistsGroup(exists, scope, state)),
  };
}

function scopePattern(
  pattern: RdfQueryPattern,
  filters: RdfQueryFilter[],
  scope: RdfAccessScope,
  state: ApplyState,
): RdfQueryPattern {
  const graph = pattern.graph ?? { $startsWith: scope.basePath };
  if (isVariable(graph)) {
    addGraphAccessFilters(filters, graph.variable, scope);
    return pattern.graph ? pattern : { ...pattern, graph };
  }
  if (isTerm(graph as any)) {
    return rdfAccessGraphAllowed((graph as Term).value, scope)
      ? pattern
      : { ...pattern, graph: state.impossibleGraph };
  }
  return {
    ...pattern,
    graph: scopeGraphOperators(graph, scope, state.impossibleGraph),
  };
}

function scopeGraphOperators(
  graph: RdfQueryTermPattern,
  scope: RdfAccessScope,
  impossibleGraph: Term,
): RdfQueryTermPattern {
  const operators = { ...(graph as Record<string, unknown>) };
  if (scope.allowedGraphUrls?.length) {
    const allowedTerms = scope.allowedGraphUrls
      .filter((url) => graphOperatorsMayMatch(graph, url))
      .map((url) => DataFactory.namedNode(url) as unknown as Term);
    if (allowedTerms.length === 0) {
      return impossibleGraph;
    }
    operators.$in = intersectTermArrays(operators.$in, allowedTerms);
    if ((operators.$in as Term[]).length === 0) {
      return impossibleGraph;
    }
  }
  if (scope.deniedGraphUrls?.length) {
    const deniedTerms = scope.deniedGraphUrls.map((url) => DataFactory.namedNode(url) as unknown as Term);
    operators.$notIn = unionTermArrays(operators.$notIn, deniedTerms);
  }
  return operators as RdfQueryTermPattern;
}

function graphOperatorsMayMatch(graph: RdfQueryTermPattern, graphUrl: string): boolean {
  if (isVariable(graph)) {
    return true;
  }
  if (isTerm(graph as any)) {
    return (graph as Term).value === graphUrl;
  }
  const operators = graph as Record<string, unknown>;
  if (operators.$startsWith !== undefined && typeof operators.$startsWith === 'string' && !graphUrl.startsWith(operators.$startsWith)) {
    return false;
  }
  if (Array.isArray(operators.$in) && !operators.$in.some((value) => isTerm(value as any) && (value as Term).value === graphUrl)) {
    return false;
  }
  if (Array.isArray(operators.$notIn) && operators.$notIn.some((value) => isTerm(value as any) && (value as Term).value === graphUrl)) {
    return false;
  }
  return true;
}

function addGraphAccessFilters(filters: RdfQueryFilter[], variable: string, scope: RdfAccessScope): void {
  if (scope.allowedGraphUrls?.length) {
    filters.push({
      variable,
      operator: '$in',
      values: scope.allowedGraphUrls.map((url) => DataFactory.namedNode(url) as unknown as Term),
    });
  }
  if (scope.deniedGraphUrls?.length) {
    filters.push({
      variable,
      operator: '$notIn',
      values: scope.deniedGraphUrls.map((url) => DataFactory.namedNode(url) as unknown as Term),
    });
  }
  for (const prefix of scope.deniedGraphPrefixes ?? []) {
    filters.push({
      variable,
      operator: '$notStartsWith',
      value: prefix,
    });
  }
}

function isVariable(value: RdfQueryTermPattern): value is RdfQueryVariable {
  return Boolean(value && typeof value === 'object' && 'variable' in value);
}

function intersectTermArrays(existing: unknown, incoming: Term[]): Term[] {
  if (!Array.isArray(existing)) {
    return incoming;
  }
  const incomingValues = new Set(incoming.map((term) => term.value));
  return existing.filter((value): value is Term => isTerm(value as any) && incomingValues.has((value as Term).value));
}

function unionTermArrays(existing: unknown, incoming: Term[]): Term[] {
  const byValue = new Map<string, Term>();
  if (Array.isArray(existing)) {
    for (const value of existing) {
      if (isTerm(value as any)) {
        byValue.set((value as Term).value, value as Term);
      }
    }
  }
  for (const term of incoming) {
    byValue.set(term.value, term);
  }
  return [...byValue.values()];
}
