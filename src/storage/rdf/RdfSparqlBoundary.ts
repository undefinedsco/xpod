import { Parser } from 'sparqljs';
import type { IriTerm, SparqlQuery } from 'sparqljs';

const QLEVER_SERVICE_HOST = 'qlever.cs.uni-freiburg.de';
const QLEVER_EXTENSION_SERVICE_ENDPOINTS = new Set([
  `https://${QLEVER_SERVICE_HOST}/pathSearch/`,
  `https://${QLEVER_SERVICE_HOST}/spatialSearch/`,
  `https://${QLEVER_SERVICE_HOST}/textSearch/`,
  `https://${QLEVER_SERVICE_HOST}/external-values/`,
]);
const QLEVER_EXTENSION_SERVICE_PREFIXES = [
  `https://${QLEVER_SERVICE_HOST}/external-values-`,
  `http://${QLEVER_SERVICE_HOST}/builtin-functions/cached-result-with-name-`,
  `https://${QLEVER_SERVICE_HOST}/materializedView/`,
];

export interface UnsupportedSparqlQueryErrorOptions {
  code?: string;
  capability?: string;
  hint?: string;
  correction?: SparqlCorrection;
}

export type SparqlCorrectionAction =
  | 'rewrite_query'
  | 'constrain_graph_scope'
  | 'materialize_intermediate'
  | 'route_external_executor'
  | 'use_write_api';

export type SparqlCorrectionTarget =
  | 'embedded_rdf_engine'
  | 'trusted_client_or_federated_engine'
  | 'pod_write_api';

export interface SparqlCorrection {
  capability: string;
  primaryAction: SparqlCorrectionAction;
  availableActions: SparqlCorrectionAction[];
  target: SparqlCorrectionTarget;
  message: string;
}

export class UnsupportedSparqlQueryError extends Error {
  public readonly code: string;
  public readonly capability: string;
  public readonly hint: string;
  public readonly correction: SparqlCorrection;

  public constructor(message: string, options: UnsupportedSparqlQueryErrorOptions = {}) {
    const normalizedMessage = normalizeUnsupportedSparqlMessage(message);
    super(normalizedMessage);
    this.name = 'UnsupportedSparqlQueryError';
    this.code = options.code ?? 'rdf.sparql.unsupported_query_shape';
    this.capability = options.capability ?? inferUnsupportedSparqlCapability(normalizedMessage);
    this.hint = options.hint ?? unsupportedSparqlHint(this.capability);
    this.correction = options.correction ?? sparqlCorrectionForCapability(this.capability);
  }
}

function normalizeUnsupportedSparqlMessage(message: string): string {
  const noFallbackMatch = /^No compatibility SPARQL fallback configured for ([^:]+):\s*(.+)$/i.exec(message);
  if (noFallbackMatch) {
    return `Embedded SPARQL engine cannot execute ${noFallbackMatch[1]}: ${normalizeEmbeddedUnsupportedReason(noFallbackMatch[2])}`;
  }
  return normalizeEmbeddedUnsupportedReason(message);
}

function normalizeEmbeddedUnsupportedReason(reason: string): string {
  let normalized = reason
    .replace(/\s+fallback to compatibility engine\b/gi, ' is not supported by the embedded RDF engine')
    .replace(/\bis handled by the compatibility engine\b/gi, 'is not supported by the embedded RDF engine')
    .replace(/\bcompatibility fallback\b/gi, 'embedded RDF engine');
  if (/^unsupported shape$/i.test(normalized.trim())) {
    normalized = 'Query shape is not supported by the embedded RDF engine';
  }
  return normalized;
}

export class DisabledSparqlFeatureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DisabledSparqlFeatureError';
  }
}

export class NativeSparqlExecutionError extends Error {
  public readonly code = 'rdf.sparql.native_execution_error';

  public constructor(message: string) {
    super(message.startsWith('Native SPARQL engine failed:') ? message : `Native SPARQL engine failed: ${message}`);
    this.name = 'NativeSparqlExecutionError';
  }
}

export class NativeSparqlTimeoutError extends Error {
  public readonly code = 'rdf.sparql.timeout';

  public constructor(
    public readonly timeoutMs: number,
    detail?: string,
  ) {
    super(`Native SPARQL query timed out after ${timeoutMs}ms${detail ? `: ${detail}` : ''}`);
    this.name = 'NativeSparqlTimeoutError';
  }
}

function inferUnsupportedSparqlCapability(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('subquer')) return 'sparql.query.subquery';
  if (normalized.includes('rdf-star')) return 'sparql.query.rdf_star';
  if (normalized.includes('property path')) return 'sparql.query.property_path';
  if (normalized.includes('default graph')) return 'sparql.graph.default';
  if (normalized.includes('graph variable')) return 'sparql.graph.variable';
  if (normalized.includes('graph outside') || normalized.includes('dataset scope')) return 'sparql.graph.scope';
  if (normalized.includes('update')) return 'sparql.update.authority';
  if (normalized.includes('construct')) return 'sparql.query.construct';
  if (normalized.includes('describe')) return 'sparql.query.describe';
  if (normalized.includes('wildcard')) return 'sparql.query.wildcard_projection';
  if (normalized.includes('having')) return 'sparql.query.having';
  if (normalized.includes('group by') || normalized.includes('grouped')) return 'sparql.query.group';
  if (normalized.includes('aggregate')) return 'sparql.query.aggregate';
  if (normalized.includes('values')) return 'sparql.query.values';
  if (/\bbind\b/.test(normalized)) return 'sparql.query.bind';
  if (normalized.includes('minus')) return 'sparql.query.minus';
  if (normalized.includes('exists')) return 'sparql.query.exists';
  if (normalized.includes('optional')) return 'sparql.query.optional';
  if (normalized.includes('union')) return 'sparql.query.union';
  if (normalized.includes('filter')) return 'sparql.query.filter';
  if (normalized.includes('function')) return 'sparql.query.function';
  return 'sparql.query.shape';
}

function unsupportedSparqlHint(capability: string): string {
  switch (capability) {
    case 'sparql.query.subquery':
      return 'Flatten the subquery, materialize its intermediate result, or route it through a trusted external executor.';
    case 'sparql.query.property_path':
      return 'Rewrite the property path as explicit predicate patterns, or use a QLever-supported path expression.';
    case 'sparql.graph.default':
      return 'Use explicit named GRAPH clauses inside the Pod base path.';
    case 'sparql.graph.variable':
      return 'Constrain graph variables to finite named graphs inside the Pod base path.';
    case 'sparql.graph.scope':
      return 'Limit GRAPH, FROM, and USING targets to graph documents inside the current Pod base path.';
    case 'sparql.update.authority':
      return 'Send the update through the Pod write authority so QLever can prepare an atomic source-file delta.';
    default:
      return 'Rewrite the query to a QLever-supported shape, or route it through a trusted external executor.';
  }
}

export function sparqlCorrectionForCapability(capability: string): SparqlCorrection {
  if (capability === 'sparql.geosparql') {
    return {
      capability,
      primaryAction: 'route_external_executor',
      availableActions: [ 'route_external_executor', 'materialize_intermediate' ],
      target: 'trusted_client_or_federated_engine',
      message: 'Route GeoSPARQL to a trusted external executor until Xpod has a concrete native product workload.',
    };
  }
  if (capability === 'sparql.federation.service') {
    return {
      capability,
      primaryAction: 'route_external_executor',
      availableActions: [ 'route_external_executor' ],
      target: 'trusted_client_or_federated_engine',
      message: 'Execute SERVICE federation from a trusted client-side or federated query layer.',
    };
  }
  if (capability === 'sparql.update.authority' || capability === 'sparql.update.embedded_delta') {
    return {
      capability,
      primaryAction: 'use_write_api',
      availableActions: [ 'use_write_api', 'rewrite_query' ],
      target: 'pod_write_api',
      message: 'Apply the update through the Pod write authority and its QLever prepared-delta contract.',
    };
  }
  if (capability === 'sparql.query.subquery' || capability === 'sparql.query.rdf_star') {
    return {
      capability,
      primaryAction: 'materialize_intermediate',
      availableActions: [ 'materialize_intermediate', 'rewrite_query', 'route_external_executor' ],
      target: 'embedded_rdf_engine',
      message: 'Materialize the unsupported intermediate result before retrying, or route it through a trusted external executor.',
    };
  }
  if (capability.startsWith('sparql.graph.')) {
    return {
      capability,
      primaryAction: 'constrain_graph_scope',
      availableActions: [ 'constrain_graph_scope', 'rewrite_query' ],
      target: 'embedded_rdf_engine',
      message: 'Constrain graph scope to named graph documents inside the current Pod base path.',
    };
  }
  return {
    capability,
    primaryAction: 'rewrite_query',
    availableActions: [ 'rewrite_query', 'route_external_executor' ],
    target: 'embedded_rdf_engine',
    message: 'Rewrite the query to a QLever-supported shape, or route it through a trusted external executor.',
  };
}

/** Validate only the server-owned graph and SERVICE boundary before native QLever execution. */
export function assertServerOwnedNativeSparqlQuery(query: string, basePath: string): boolean {
  const parsed = new Parser({ baseIRI: basePath }).parse(query);
  const usesQleverExtensionService = assertNoExternalService(parsed);
  if (parsed.type !== 'update') {
    assertNativeDatasetScope(queryFromClause(parsed), basePath);
  }
  return usesQleverExtensionService;
}

function isQleverExtensionServiceEndpoint(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const endpoint = value as Record<string, unknown>;
  if (endpoint.termType !== 'NamedNode' || typeof endpoint.value !== 'string') return false;
  return QLEVER_EXTENSION_SERVICE_ENDPOINTS.has(endpoint.value)
    || QLEVER_EXTENSION_SERVICE_PREFIXES.some((prefix) => (endpoint.value as string).startsWith(prefix));
}

function assertNoExternalService(value: unknown): boolean {
  if (Array.isArray(value)) {
    let usesQleverExtensionService = false;
    for (const item of value) {
      if (assertNoExternalService(item)) usesQleverExtensionService = true;
    }
    return usesQleverExtensionService;
  }
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  let usesQleverExtensionService = false;
  if (record.type === 'service') {
    if (!isQleverExtensionServiceEndpoint(record.name)) {
      throw new DisabledSparqlFeatureError(
        'SPARQL SERVICE federation is disabled for server-owned Pod queries',
      );
    }
    usesQleverExtensionService = true;
  }
  for (const child of Object.values(record)) {
    if (assertNoExternalService(child)) usesQleverExtensionService = true;
  }
  return usesQleverExtensionService;
}

function assertNativeDatasetScope(
  datasets: { default: IriTerm[]; named: IriTerm[] },
  basePath: string,
): void {
  for (const graph of [ ...datasets.default, ...datasets.named ]) {
    if (!graph.value.startsWith(basePath)) {
      throw new DisabledSparqlFeatureError(
        `SPARQL dataset graph is outside the server-owned Pod scope: ${graph.value}`,
      );
    }
  }
}

function queryFromClause(query: SparqlQuery): { default: IriTerm[]; named: IriTerm[] } {
  const from = 'from' in query ? query.from : undefined;
  return {
    default: from?.default ?? [],
    named: from?.named ?? [],
  };
}
