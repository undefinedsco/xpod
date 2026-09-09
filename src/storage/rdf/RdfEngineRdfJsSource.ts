import { BufferedIterator } from 'asynciterator';
import { DataFactory } from 'n3';
import type {
  Quad,
  Quad_Graph,
  Quad_Object,
  Quad_Predicate,
  Quad_Subject,
  Source,
  Stream,
  Term,
  Variable,
} from '@rdfjs/types';
import { applyRdfAccessScope, type RdfAccessScope } from './RdfAccessScope';
import type {
  RdfBindingRow,
  RdfEngineLike,
  RdfQuery,
  RdfQueryPattern,
  RdfQueryResult,
  RdfQueryTermPattern,
} from './types';

const { quad, defaultGraph } = DataFactory;

export interface RdfEngineRdfJsSourceOptions {
  accessScope?: RdfAccessScope;
  signal?: AbortSignal;
}

export class RdfEngineRdfJsSource implements Source {
  public constructor(
    private readonly rdfEngine: RdfEngineLike,
    private readonly options: RdfEngineRdfJsSourceOptions = {},
  ) {}

  public match(
    subject?: Term | null,
    predicate?: Term | null,
    object?: Term | null,
    graph?: Term | null,
  ): Stream {
    return new RdfEngineMatchIterator(this.rdfEngine, {
      subject,
      predicate,
      object,
      graph,
    }, this.options);
  }

  public async countQuads(
    subject?: Term | null,
    predicate?: Term | null,
    object?: Term | null,
    graph?: Term | null,
  ): Promise<number> {
    return executeCount(this.rdfEngine, {
      subject,
      predicate,
      object,
      graph,
    }, this.options);
  }
}

interface MatchTerms {
  subject?: Term | null;
  predicate?: Term | null;
  object?: Term | null;
  graph?: Term | null;
}

class RdfEngineMatchIterator extends BufferedIterator<Quad> {
  private started = false;
  private readonly abort: () => void;

  public constructor(
    private readonly rdfEngine: RdfEngineLike,
    private readonly terms: MatchTerms,
    private readonly options: RdfEngineRdfJsSourceOptions,
  ) {
    super({ autoStart: false });
    this.abort = (): void => this.destroy(createAbortError(options.signal));
    options.signal?.addEventListener('abort', this.abort, { once: true });
  }

  protected override _read(_count: number, done: () => void): void {
    if (this.started) {
      done();
      return;
    }
    this.started = true;

    executeMatch(this.rdfEngine, this.terms, this.options)
      .then((quads) => {
        for (const item of quads) {
          this._push(item);
        }
        this.close();
        done();
      })
      .catch((error: unknown) => {
        this.destroy(error instanceof Error ? error : new Error(String(error)));
        done();
      });
  }

  protected override _destroy(cause: Error | undefined, callback: (error?: Error) => void): void {
    this.options.signal?.removeEventListener('abort', this.abort);
    super._destroy(cause, callback);
  }
}

type RdfSlotName = 'subject' | 'predicate' | 'object' | 'graph';

const SLOT_NAMES: RdfSlotName[] = ['subject', 'predicate', 'object', 'graph'];

async function executeMatch(
  rdfEngine: RdfEngineLike,
  terms: MatchTerms,
  options: RdfEngineRdfJsSourceOptions,
): Promise<Quad[]> {
  const select = SLOT_NAMES.filter((slot) => isUnboundMatchTerm(terms[slot]));
  const result = await queryWithAbort(rdfEngine, applyRdfAccessScope({
    patterns: [matchPattern(terms)],
    select,
  }, options.accessScope), options.signal);
  assertNotAborted(options.signal);
  return result.bindings.map((row) => {
    assertNotAborted(options.signal);
    return quad(
      requireQuadSubject(isUnboundMatchTerm(terms.subject) ? requireBinding(row, 'subject') : terms.subject),
      requireQuadPredicate(isUnboundMatchTerm(terms.predicate) ? requireBinding(row, 'predicate') : terms.predicate),
      requireQuadObject(isUnboundMatchTerm(terms.object) ? requireBinding(row, 'object') : terms.object),
      requireQuadGraph(isUnboundMatchTerm(terms.graph) ? (row.graph ?? defaultGraph()) : terms.graph),
    );
  });
}

async function executeCount(
  rdfEngine: RdfEngineLike,
  terms: MatchTerms,
  options: RdfEngineRdfJsSourceOptions,
): Promise<number> {
  const countSlot = 'count';
  const result = await queryWithAbort(rdfEngine, applyRdfAccessScope({
    patterns: [matchPattern(terms)],
    select: [countSlot],
    aggregates: [{ type: 'count', as: countSlot }],
  }, options.accessScope), options.signal);
  const count = Number(result.bindings[0]?.[countSlot]?.value ?? result.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('RDF/JS source count query returned an invalid count');
  }
  return count;
}

function matchPattern(terms: MatchTerms): RdfQueryPattern {
  return {
    subject: termPattern(terms.subject, 'subject'),
    predicate: termPattern(terms.predicate, 'predicate'),
    object: termPattern(terms.object, 'object'),
    graph: termPattern(terms.graph, 'graph'),
  };
}

function queryWithAbort(
  rdfEngine: RdfEngineLike,
  query: RdfQuery,
  signal?: AbortSignal,
): Promise<RdfQueryResult> {
  assertNotAborted(signal);
  if (!signal) {
    return Promise.resolve(rdfEngine.query(query));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      complete();
    };
    const onAbort = (): void => settle(() => reject(createAbortError(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(() => {
        assertNotAborted(signal);
        return rdfEngine.query(query);
      })
      .then(
        (result) => settle(() => resolve(result)),
        (error: unknown) => settle(() => reject(error)),
      );
  });
}

function termPattern(term: Term | null | undefined, variable: RdfSlotName): RdfQueryTermPattern | undefined {
  if (isUnboundMatchTerm(term)) {
    return { variable };
  }
  return term;
}

function isUnboundMatchTerm(term: Term | null | undefined): term is undefined | null | Variable {
  return !term || term.termType === 'Variable';
}

function requireBinding(row: RdfBindingRow, slot: RdfSlotName): Term {
  const term = row[slot];
  if (!term) {
    throw new Error(`RDF/JS source query result is missing ${slot} binding`);
  }
  return term;
}

function requireQuadSubject(term: Term): Quad_Subject {
  if (term.termType === 'NamedNode' || term.termType === 'BlankNode') {
    return term;
  }
  throw new Error(`RDF/JS source query result has invalid subject term type ${term.termType}`);
}

function requireQuadPredicate(term: Term): Quad_Predicate {
  if (term.termType === 'NamedNode') {
    return term;
  }
  throw new Error(`RDF/JS source query result has invalid predicate term type ${term.termType}`);
}

function requireQuadObject(term: Term): Quad_Object {
  if (
    term.termType === 'NamedNode'
    || term.termType === 'BlankNode'
    || term.termType === 'Literal'
  ) {
    return term;
  }
  throw new Error(`RDF/JS source query result has invalid object term type ${term.termType}`);
}

function requireQuadGraph(term: Term): Quad_Graph {
  if (term.termType === 'DefaultGraph' || term.termType === 'NamedNode' || term.termType === 'BlankNode') {
    return term;
  }
  throw new Error(`RDF/JS source query result has invalid graph term type ${term.termType}`);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

function createAbortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('RDF/JS source match aborted', 'AbortError');
}
