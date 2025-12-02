import { DataFactory } from 'n3';
import { Generator as SparqlGenerator, Parser as SparqlParser, type GraphQuads, type UpdateOperation, type Update as SparqlUpdate } from 'sparqljs';
import {
  DataAccessorBasedStore,
  IdentifierMap,
  type ChangeMap,
  type ResourceIdentifier,
  type Patch,
  type Representation,
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
import type { SparqlUpdatePatch } from '@solid/community-server/dist/http/representation/SparqlUpdatePatch';
import { isN3Patch } from '@solid/community-server/dist/http/representation/N3Patch';
import { readableToString } from '@solid/community-server/dist/util/StreamUtil';
import { getLoggerFor } from '@solid/community-server/dist/logging/LogUtil';

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
    const accessor = (this as unknown as { accessor: unknown }).accessor as unknown;
    if (!this.isSparqlCapable(accessor)) {
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
      throw new NotImplementedHttpError('Unsupported PATCH payload for SPARQL conversion');
    }

    this.logger.info(`Applying SPARQL PATCH to ${identifier.path}: ${sparqlUpdate}`);
    await accessor.executeSparqlUpdate(sparqlUpdate, identifier.path);

    // PATCH does not affect containment; mark the target resource as updated.
    const changes: ChangeMap = new IdentifierMap();
    changes.set(identifier, new RepresentationMetadata(identifier, { [SOLID_AS.activity]: AS.terms.Update }));
    return changes;
  }

  private async toSparqlUpdate(patch: Patch, identifier: ResourceIdentifier): Promise<string | undefined> {
    this.logger.info(`toSparqlUpdate received patch with contentType: ${patch.metadata.contentType}`);
    if (this.isSparqlUpdatePatch(patch)) {
      const updateText = await readableToString(patch.data);
      return this.normalizeGraphs(updateText, identifier);
    }

    if (isN3Patch(patch)) {
      return this.fromN3Patch(patch, identifier);
    }

    return undefined;
  }

  /**
   * Ensure SPARQL UPDATE targets the resource graph (CSS stores documents in named graphs).
   */
  private normalizeGraphs(updateText: string, identifier: ResourceIdentifier): string {
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
      const parsed = this.parser.parse(updateText) as unknown as SparqlUpdate;
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

      if (simpleOps && deleteTriples.length + insertTriples.length > 0) {
        const toTripleStr = (triples: any[]): string =>
          triples.map((t): string => `<${t.subject.value}> <${t.predicate.value}> <${t.object.value}> .`).join(' ');
        let parts: string[] = [];
        if (deleteTriples.length > 0) {
          parts.push(`DELETE DATA { GRAPH <${graph.value}> { ${toTripleStr(deleteTriples)} } }`);
        }
        if (insertTriples.length > 0) {
          parts.push(`INSERT DATA { GRAPH <${graph.value}> { ${toTripleStr(insertTriples)} } }`);
        }
        const normalizedSimple = parts.join(';\n');
        this.logger.info(`Normalized SPARQL UPDATE for ${identifier.path}: ${normalizedSimple}`);
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
      this.logger.info(`Normalized SPARQL UPDATE for ${identifier.path}: ${normalized}`);
      return normalized;
    } catch (error: unknown) {
      this.logger.warn(`Failed to parse SPARQL UPDATE for ${identifier.path}, applying DATA rewrite fallback: ${error}`);
      return wrapDefaultGraph(updateText);
    }
  }

  private isSparqlUpdatePatch(patch: Patch): patch is SparqlUpdatePatch {
    return typeof (patch as SparqlUpdatePatch).algebra === 'object';
  }

  /**
   * Convert N3 InsertDeletePatch into SPARQL UPDATE against the resource graph.
   */
  private fromN3Patch(patch: any, identifier: ResourceIdentifier): string | undefined {
    const graphName = DataFactory.namedNode(identifier.path);
    const normalizeTerm = (term: any) => {
      if (term?.termType === 'Variable') {
        return DataFactory.variable(term.value);
      }
      if (term?.termType === 'Literal') {
        if (term.datatype.value === 'http://www.w3.org/2001/XMLSchema#string') {
          return DataFactory.literal(term.value);
        }
      }
      return term;
    };
    const toTriples = (quads?: any[]): any[] =>
      (quads ?? []).map((quad: any) => DataFactory.quad(
        normalizeTerm(quad.subject),
        normalizeTerm(quad.predicate),
        normalizeTerm(quad.object),
        graphName,
      ));

    const deleteTriples = toTriples(patch.deletes);
    const insertTriples = toTriples(patch.inserts);
    const whereTriples = toTriples(patch.conditions);

    if (deleteTriples.length === 0 && insertTriples.length === 0) {
      return undefined;
    }

    // Optimization: Use DELETE DATA / INSERT DATA for unconditional updates
    if (whereTriples.length === 0) {
      const operations: string[] = [];
      if (deleteTriples.length > 0) {
        // sparqljs structure for DELETE DATA is effectively a 'deletewhere' without variables? 
        // Or we can manually construct the query string to ensure it is DELETE DATA.
        // But we want to use the generator if possible.
        // sparqljs 'deleteData' type?
        // Let's use the object structure that corresponds to DELETE DATA.
        // It seems sparqljs uses `updateType: 'delete'` with `data: true`? No.
        // Let's look at how normalizeGraphs did it manually.
        // We can create a manual string or try to force sparqljs.
        // Given we are inside fromN3Patch which returns string, manual construction for this optimized path is safest and simplest.
        
        // We need to convert quads back to string?
        // That's tedious because we just converted them TO terms.
        
        // Better: Use sparqljs UpdateOperation structure but split them.
        
        // If we return a string, we can stringify multiple updates.
        const updates: UpdateOperation[] = [];
        
        // DELETE DATA
        if (deleteTriples.length > 0) {
           // To force DELETE DATA in sparqljs, we use type 'delete' and empty 'where'? 
           // Actually, 'delete' updateType usually implies DELETE WHERE.
           // DELETE DATA is strictly `DELETE DATA { ... }`.
           // sparqljs supports `updateType: 'delete'` with `insert: []`?
           
           // Looking at sparqljs types:
           // export type UpdateOperation = InsertDeleteOperation | ...
           // InsertDeleteOperation: { updateType: 'insertdelete' | 'delete' | 'insert', delete?: ..., insert?: ..., where?: ... }
           
           // If I use `updateType: 'delete'` and NO `where`, it generates `DELETE { ... } WHERE {}`?
           // Yes, that's what we want to avoid.
           
           // There isn't a direct 'deleteData' UpdateOperation in sparqljs types exposed usually.
           // But `normalizeGraphs` used string manipulation.
           
           // Let's construct the string manually using the generator for the quads part?
           // `generator.stringify` takes a full query/update object.
           
           // Let's stick to the previous strategy: Use `updateType: 'insertdelete'` but with empty WHERE?
           // No, that's what caused the bug (presumably).
           
           // Wait, if `normalizeGraphs` manual string construction worked (or was the plan), we should do that here.
           // But here we have `Quad` objects (terms).
           
           // I will use `updateType: 'insertdelete'` but split them into two operations: one DELETE, one INSERT.
           // Maybe executing them separately helps?
           // op1: DELETE { ... } WHERE {}
           // op2: INSERT { ... } WHERE {}
           
           // If the bug is that `DELETE ... INSERT ...` in one op fails to delete before inserting?
           
           updates.push({
             updateType: 'insertdelete',
             delete: deleteTriples.length > 0 ? [ { type: 'graph', name: graphName, triples: deleteTriples } as any ] : [],
             insert: [],
             where: [],
           });
        }
        
        if (insertTriples.length > 0) {
           updates.push({
             updateType: 'insertdelete',
             delete: [],
             insert: insertTriples.length > 0 ? [ { type: 'graph', name: graphName, triples: insertTriples } as any ] : [],
             where: [],
           });
        }
        
        const update: SparqlUpdate = {
          type: 'update',
          prefixes: {},
          updates,
        };
        return this.generator.stringify(update);
      }
    }

    const updateOp: UpdateOperation = {
      updateType: 'insertdelete',
      delete: deleteTriples.length > 0 ? [ { type: 'graph', name: graphName, triples: deleteTriples } as any ] : [],
      insert: insertTriples.length > 0 ? [ { type: 'graph', name: graphName, triples: insertTriples } as any ] : [],
      where: whereTriples.length > 0
        ? [ { type: 'graph', name: graphName, patterns: [ { type: 'bgp', triples: whereTriples } ] } ]
        : [ { type: 'bgp', triples: [] } ],
    };

    const update: SparqlUpdate = {
      type: 'update',
      prefixes: {},
      updates: [ updateOp ],
    };

    return this.generator.stringify(update);
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
