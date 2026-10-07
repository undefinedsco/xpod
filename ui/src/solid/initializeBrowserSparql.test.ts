import { describe, expect, it } from 'vitest';
import { QueryEngine } from '@comunica/query-sparql-solid';
import { ActionObserverHttp } from '@comunica/actor-query-result-serialize-stats';
import { ActionObserverHttp as JsonActionObserverHttp } from '@comunica/actor-query-result-serialize-sparql-json';
import { getConfiguredSparqlEngineFactory } from '../../../node_modules/@undefineds.co/drizzle-solid/dist/esm/core/sparql-engine.js';
import { createXpodSolidRuntimeValue } from './XpodSolidRuntime';
import { initializeBrowserSparql } from './initializeBrowserSparql';

describe('browser SPARQL host initialization', () => {
  it('initializes the real engine before any AI store is constructed and stays idempotent', async () => {
    expect(typeof window).toBe('object');
    createXpodSolidRuntimeValue();
    const factory = getConfiguredSparqlEngineFactory();
    initializeBrowserSparql();
    expect(getConfiguredSparqlEngineFactory()).toBe(factory);
    const engine = await factory();
    expect(engine).toBeInstanceOf(QueryEngine);
    const result = await engine.queryBindings('SELECT ?value WHERE { VALUES ?value { "host-ready" } }');
    const rows = await result.toArray();
    expect(rows[0].get('value')?.value).toBe('host-ready');
  });

  it.each([ActionObserverHttp, JsonActionObserverHttp])('protects the real observer when generated engine arguments omit observedActors', (Observer) => {
    initializeBrowserSparql();
    const observer = new Observer({
      name: 'host-regression',
      bus: { subscribeObserver: () => undefined },
      httpInvalidator: { addInvalidateListener: () => undefined },
    } as never);
    expect(() => observer.onRun({ name: 'http-regression' } as never, {} as never, {} as never)).not.toThrow();
  });
});
