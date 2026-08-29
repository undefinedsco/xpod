import { QueryEngine } from '@comunica/query-sparql-solid';
import type { Term } from '@rdfjs/types';
import { compareRdfNumericNaNOrder } from './RdfTermSemantics';

const ORDER_BY_ACTOR = 'urn:comunica:default:query-operation/actors#orderby';
const TERM_COMPARATOR_ACTOR = 'urn:comunica:default:term-comparator-factory/actors#expression-evaluator';

interface ComunicaTermComparator {
  orderTypes(left: Term | undefined, right: Term | undefined): -1 | 0 | 1;
}

/**
 * Creates the public Cloud evaluator with Xpod's QLever-aligned NaN ordering.
 *
 * Comunica exposes term comparison through a shared actor bus used by ORDER BY
 * and MIN/MAX. Its generated engine does not expose that bus on QueryEngine's
 * public type, so this adapter locates the named actors and fails at startup if
 * a future Comunica upgrade changes the integration boundary.
 */
export function createXpodComunicaQueryEngine(): QueryEngine {
  const engine = new QueryEngine();
  const init = objectProperty(engine, 'actorInitQuery', 'query init actor');
  const queryProcess = objectProperty(init, 'mediatorQueryProcess', 'query-process mediator');
  const processActor = actorWithProperty(queryProcess, 'mediatorQueryOperation', 'query-process actor');
  const queryOperation = objectProperty(processActor, 'mediatorQueryOperation', 'query-operation mediator');
  const orderBy = namedActor(queryOperation, ORDER_BY_ACTOR);
  const termComparator = objectProperty(orderBy, 'mediatorTermComparatorFactory', 'term-comparator mediator');
  const comparatorActor = namedActor(termComparator, TERM_COMPARATOR_ACTOR);
  const run = comparatorActor.run;
  if (typeof run !== 'function') {
    throw new Error(`Comunica actor ${TERM_COMPARATOR_ACTOR} does not expose run()`);
  }

  const originalRun = run.bind(comparatorActor) as (action: unknown) => Promise<ComunicaTermComparator>;
  comparatorActor.run = async (action: unknown): Promise<ComunicaTermComparator> => {
    const comparator = await originalRun(action);
    return {
      ...comparator,
      orderTypes(left: Term | undefined, right: Term | undefined): -1 | 0 | 1 {
        return compareRdfNumericNaNOrder(left, right) ?? comparator.orderTypes(left, right);
      },
    };
  };
  return engine;
}

function actorWithProperty(mediator: Record<string, unknown>, property: string, label: string): Record<string, unknown> {
  const actor = actors(mediator).find((candidate) => property in candidate);
  if (!actor) {
    throw new Error(`Comunica ${label} with ${property} was not found`);
  }
  return actor;
}

function namedActor(mediator: Record<string, unknown>, name: string): Record<string, unknown> {
  const actor = actors(mediator).find((candidate) => candidate.name === name);
  if (!actor) {
    throw new Error(`Comunica actor ${name} was not found`);
  }
  return actor;
}

function actors(mediator: Record<string, unknown>): Array<Record<string, unknown>> {
  const bus = objectProperty(mediator, 'bus', 'actor bus');
  const value = bus.actors;
  if (!Array.isArray(value)) {
    throw new Error('Comunica actor bus does not expose its actors');
  }
  return value.map((actor, index) => objectValue(actor, `actor ${index}`));
}

function objectProperty(value: object, property: string, label: string): Record<string, unknown> {
  return objectValue((value as Record<string, unknown>)[property], label);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(`Comunica ${label} was not found`);
  }
  return value as Record<string, unknown>;
}
