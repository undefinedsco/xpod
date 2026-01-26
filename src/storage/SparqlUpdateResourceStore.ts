import { DataFactory } from 'n3';
import { Generator as SparqlGenerator, Parser as SparqlParser, type GraphQuads, type UpdateOperation, type Update as SparqlUpdate } from 'sparqljs';
import {
  DataAccessorBasedStore,
  IdentifierMap,
  type ChangeMap,
  type ResourceIdentifier,
  type Patch,
  NotImplementedHttpError,
  type Conditions,
  NotFoundHttpError,
  RepresentationMetadata,
  AS,
  SOLID_AS,
  BadRequestHttpError,
  type DataAccessor,
  type IdentifierStrategy,
  type AuxiliaryStrategy,
} from '@solid/community-server';
import type { SparqlUpdatePatch } from '@solid/community-server';
import { readableToString } from '@solid/community-server/dist/util/StreamUtil';
import { getLoggerFor } from 'global-logger-factory';

export interface SparqlUpdateResourceStoreOptions {
  accessor: DataAccessor;
  identifierStrategy: IdentifierStrategy;
  auxiliaryStrategy: AuxiliaryStrategy;
  metadataStrategy: AuxiliaryStrategy;
}

/**
 * ResourceStore that short-circuits PATCH into direct SPARQL UPDATE
 * when the underlying DataAccessor supports it.
 */
export class SparqlUpdateResourceStore extends DataAccessorBasedStore {
  private readonly generator = new SparqlGenerator();
  private readonly parser = new SparqlParser();
  protected override readonly logger = getLoggerFor(this);

  public constructor(options: SparqlUpdateResourceStoreOptions) {
    super(options.accessor, options.identifierStrategy, options.auxiliaryStrategy, options.metadataStrategy);
  }

  // @ts-expect-error Upstream signature returns never; we return ChangeMap for successful PATCH.
  public override async modifyResource(identifier: ResourceIdentifier, patch: Patch, conditions?: Conditions): Promise<ChangeMap> {
    this.logger.debug(`SparqlUpdateResourceStore.modifyResource called for ${identifier.path}`);
    this.logger.debug(`Patch has algebra: ${typeof (patch as SparqlUpdatePatch).algebra === 'object'}, metadata.contentType: ${patch.metadata?.contentType}`);

    const accessor = (this as unknown as { accessor: unknown }).accessor as unknown;
    if (!this.isSparqlCapable(accessor)) {
      this.logger.debug('Accessor is not SPARQL capable');
      throw new NotImplementedHttpError('SPARQL UPDATE not supported by this accessor');
    }

    // Keep the default condition validation semantics
    if (conditions) {
      let metadata: RepresentationMetadata | undefined;
      try {
        metadata = await accessor.getMetadata(identifier);
      } catch (error: unknown) {
        if (!NotFoundHttpError.isInstance(error)) {
          throw error;
        }
      }
      this.validateConditions(conditions, metadata);
    }

    const sparqlUpdate = await this.toSparqlUpdate(patch, identifier);
    if (!sparqlUpdate) {
      this.logger.debug(`toSparqlUpdate returned undefined for ${identifier.path}, falling back to CSS handler`);
      throw new NotImplementedHttpError('Unsupported PATCH payload for SPARQL conversion');
    }

    this.logger.debug(`Applying SPARQL PATCH to ${identifier.path}: ${sparqlUpdate}`);
    await accessor.executeSparqlUpdate(sparqlUpdate, identifier.path);

    // PATCH does not affect containment; mark the target resource as updated.
    const changes: ChangeMap = new IdentifierMap();
    changes.set(identifier, new RepresentationMetadata(identifier, { [SOLID_AS.activity]: AS.terms.Update }));
    return changes;
  }

  /**
   * 只处理 SPARQL UPDATE (application/sparql-update)。
   * N3 Patch 和其他类型返回 undefined，让 CSS PatchingStore 回退到 get-patch-set 逻辑。
   */
  private async toSparqlUpdate(patch: Patch, identifier: ResourceIdentifier): Promise<string | undefined> {
    // 只处理 SPARQL UPDATE，其他类型（包括 N3 Patch）回退到 CSS 默认处理
    if (!this.isSparqlUpdatePatch(patch)) {
      return undefined;
    }

    const updateText = await readableToString(patch.data);
    return this.normalizeGraphs(updateText, identifier);
  }

  /**
   * Ensure SPARQL UPDATE targets the resource graph (CSS stores documents in named graphs).
   */
  private normalizeGraphs(updateText: string, identifier: ResourceIdentifier): string | undefined {
    const graph = DataFactory.namedNode(identifier.path);
    const identifierStrategy = (this as unknown as { identifierStrategy: { supportsIdentifier: (id: ResourceIdentifier) => boolean }}).identifierStrategy;

    const assertGraphAllowed = (value: unknown): void => {
      if (!value || typeof value !== 'object') {
        return;
      }
      const term = value as { termType?: string; value?: string };
      if (term.termType === 'NamedNode' && term.value && !identifierStrategy.supportsIdentifier({ path: term.value })) {
        throw new BadRequestHttpError(`GRAPH ${term.value} is outside the configured identifier space.`);
      }
    };
    const wrapDefaultGraph = (text: string): string => {
      const insert = /INSERT\s+DATA\s*{\s*([^}]*)}/is;
      const del = /DELETE\s+DATA\s*{\s*([^}]*)}/is;
      const rewrite = (regex: RegExp, label: string, input: string): string =>
        input.replace(regex, (_match, body) => `${label} { GRAPH <${graph.value}> { ${body} } }`);
      let out = text;
      if (insert.test(out)) {
        out = rewrite(insert, 'INSERT DATA', out);
      }
      if (del.test(out)) {
        out = rewrite(del, 'DELETE DATA', out);
      }
      return out;
    };

    const rewriteTriples = (triples?: any[], targetGraph = graph): any[] => {
      if (!triples) return [];
      return triples.map((triple: any): any => ({
        ...triple,
        graph: (!triple.graph || triple.graph.termType === 'DefaultGraph') ? targetGraph : triple.graph,
      }));
    };

    const rewritePattern = (pattern: any): any => {
      if (pattern.type === 'bgp') {
        return { ...pattern, triples: rewriteTriples(pattern.triples) };
      }
      if (pattern.type === 'graph') {
        return { ...pattern, patterns: pattern.patterns?.map(rewritePattern) ?? [] };
      }
      if (pattern.type === 'group') {
        return { ...pattern, patterns: pattern.patterns?.map(rewritePattern) ?? [] };
      }
      if (pattern.type === 'optional') {
        return { ...pattern, patterns: pattern.patterns?.map(rewritePattern) ?? [] };
      }
      if (pattern.type === 'union') {
        return { ...pattern, patterns: pattern.patterns?.map(rewritePattern) ?? [] };
      }
      if (pattern.type === 'minus') {
        return { ...pattern, patterns: pattern.patterns?.map(rewritePattern) ?? [] };
      }
      if (pattern.type === 'filter') {
        return pattern; // FILTER doesn't contain triples, pass through
      }
      if (pattern.type === 'bind') {
        return pattern; // BIND doesn't contain triples, pass through
      }
      if (pattern.type === 'values') {
        return pattern; // VALUES doesn't contain triples, pass through
      }
      if (pattern.type === 'service') {
        return { ...pattern, patterns: pattern.patterns?.map(rewritePattern) ?? [] };
      }
      return pattern;
    };

    const toGraphQuads = (items?: any[]): GraphQuads[] | undefined => {
      if (!items) return items;
      return items.map((item: any): GraphQuads => {
        if (item?.type === 'graph') {
          assertGraphAllowed(item.name);
          return {
            ...item,
            name: item.name ?? graph,
            triples: rewriteTriples(item.triples, item.name ?? graph),
          };
        }
        // Treat as plain quad
        return {
          type: 'graph',
          name: graph,
          triples: rewriteTriples([ item ], graph),
        };
      });
    };

    try {
      console.log(`[normalizeGraphs] Input SPARQL (first 500 chars): ${updateText.slice(0, 500)}`);
      const parsed = this.parser.parse(updateText) as unknown as SparqlUpdate;

      // Explicitly reject SPARQL Queries (SELECT, ASK, CONSTRUCT) in PATCH
      if ((parsed as any).type === 'query') {
        this.logger.warn(`Received SPARQL Query in PATCH request for ${identifier.path}. SPARQL PATCH only supports UPDATE operations.`);
        return undefined;
      }

      const collect = (ops: any[], key: 'delete' | 'insert'): any[] =>
        ops.flatMap((op): any[] => {
          const entries = op[key];
          if (!entries) return [];
          if (Array.isArray(entries)) {
            return entries.flatMap((entry: any): any[] =>
              entry.triples ? entry.triples : (entry.quads ?? []));
          }
          return [];
        });
    const deleteTriples = collect(parsed.updates as any[], 'delete');
    const insertTriples = collect(parsed.updates as any[], 'insert');
    const hasVariables = [...deleteTriples, ...insertTriples].some((t: any): boolean =>
      t.subject?.termType === 'Variable' || t.predicate?.termType === 'Variable' || t.object?.termType === 'Variable');

      const simpleOps = parsed.updates.every((op: any): boolean =>
        [ 'delete', 'insert', 'insertdelete', 'deleteinsert' ].includes(op.updateType) &&
        (!op.where || op.where.length === 0) &&
        !hasVariables);

      this.logger.debug(`[normalizeGraphs] simpleOps=${simpleOps}, hasVariables=${hasVariables}, deleteTriples=${deleteTriples.length}, insertTriples=${insertTriples.length}`);
      this.logger.debug(`[normalizeGraphs] updateTypes: ${parsed.updates.map((op: any) => op.updateType).join(', ')}`);

      if (simpleOps && deleteTriples.length + insertTriples.length > 0) {
        const termToString = (term: any): string => {
          if (term.termType === 'NamedNode') {
            return `<${term.value}>`;
          }
          if (term.termType === 'Literal') {
            // Escape special characters in literal values
            const hasQuotes = term.value.includes('"');
            const hasNewlines = term.value.includes('\n') || term.value.includes('\r');

            let escaped: string;
            let useTripleQuotes = false;

            if (hasQuotes || hasNewlines) {
              // Use triple-quoted strings for values with quotes or newlines
              useTripleQuotes = true;
              escaped = term.value;
              // Escape triple-quote sequences
              escaped = escaped.replace(/"""/g, '"\\"\\""');
              // Escape trailing quotes to avoid """content"""" sequences
              if (escaped.endsWith('"')) {
                const match = escaped.match(/"*$/);
                const trailingQuotes = match ? match[0].length : 0;
                if (trailingQuotes > 0) {
                  escaped = escaped.slice(0, -trailingQuotes) + '\\"'.repeat(trailingQuotes);
                }
              }
            } else {
              // Regular escaping for simple strings
              escaped = term.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            }

            const quote = useTripleQuotes ? '"""' : '"';

            // Handle language tags and datatypes
            if (term.language) {
              return `${quote}${escaped}${quote}@${term.language}`;
            }
            if (term.datatype && term.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string') {
              return `${quote}${escaped}${quote}^^<${term.datatype.value}>`;
            }
            return `${quote}${escaped}${quote}`;
          }
          if (term.termType === 'BlankNode') {
            return `_:${term.value}`;
          }
          // Fallback for unknown term types
          return `<${term.value}>`;
        };
        const toTripleStr = (triples: any[]): string =>
          triples.map((t): string => `${termToString(t.subject)} ${termToString(t.predicate)} ${termToString(t.object)} .`).join(' ');
        let parts: string[] = [];
        if (deleteTriples.length > 0) {
          parts.push(`DELETE DATA { GRAPH <${graph.value}> { ${toTripleStr(deleteTriples)} } }`);
        }
        if (insertTriples.length > 0) {
          parts.push(`INSERT DATA { GRAPH <${graph.value}> { ${toTripleStr(insertTriples)} } }`);
        }
        const normalizedSimple = parts.join(';\n');
        this.logger.verbose(`Normalized SPARQL UPDATE for ${identifier.path}: ${normalizedSimple}`);
        return normalizedSimple;
      }

      parsed.updates = parsed.updates.map((op: any): UpdateOperation => {
        switch (op.updateType) {
          case 'deleteinsert':
          case 'insertdelete':
            return {
              ...op,
              delete: toGraphQuads(op.delete),
              insert: toGraphQuads(op.insert),
              where: op.where && op.where.length > 0 ? [ { type: 'graph', name: graph, patterns: op.where.map(rewritePattern) } ] : [],
            };
          case 'delete':
          case 'insert': {
            const deleteQuads = toGraphQuads(op.delete) ?? [];
            const insertQuads = toGraphQuads(op.insert) ?? [];
            return {
              updateType: 'insertdelete',
              delete: deleteQuads,
              insert: insertQuads,
              where: op.where && op.where.length > 0 ? [ { type: 'graph', name: graph, patterns: op.where.map(rewritePattern) } ] : [],
            };
          }
          default:
            return op;
        }
      });
      const normalized = this.generator.stringify(parsed);
      this.logger.verbose(`Normalized SPARQL UPDATE for ${identifier.path}: ${normalized}`);
      return normalized;
    } catch (error: unknown) {
      console.log(`[normalizeGraphs] Parse FAILED for ${identifier.path}: ${error}`);
      console.log(`[normalizeGraphs] Input was: ${updateText.slice(0, 300)}`);
      const fallbackResult = wrapDefaultGraph(updateText);
      console.log(`[normalizeGraphs] Fallback result: ${fallbackResult.slice(0, 300)}`);
      return fallbackResult;
    }
  }

  private isSparqlUpdatePatch(patch: Patch): patch is SparqlUpdatePatch {
    return typeof (patch as SparqlUpdatePatch).algebra === 'object';
  }

  private isSparqlCapable(accessor: unknown): accessor is {
    executeSparqlUpdate: (query: string, baseIri?: string) => Promise<void>;
    getMetadata: (identifier: ResourceIdentifier) => Promise<RepresentationMetadata>;
  } {
    return typeof accessor === 'object' &&
      accessor !== null &&
      typeof (accessor as { executeSparqlUpdate?: unknown }).executeSparqlUpdate === 'function' &&
      typeof (accessor as { getMetadata?: unknown }).getMetadata === 'function';
  }
}
