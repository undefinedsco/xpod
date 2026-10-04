import { configureSparqlEngine, type SPARQLQueryEngine } from '@undefineds.co/drizzle-solid';
import { QueryEngine } from '@comunica/query-sparql-solid';
import { ActionObserverHttp } from '@comunica/actor-query-result-serialize-stats';
import { ActionObserverHttp as JsonActionObserverHttp } from '@comunica/actor-query-result-serialize-sparql-json';

let initialized = false;

/** Initialize the host engine before any Pod consumer starts reading. */
export function initializeBrowserSparql(): void {
  if (initialized) return;
  patchBrowserComunicaObserver();
  configureSparqlEngine({
    createQueryEngine: async () => new QueryEngine() as unknown as SPARQLQueryEngine,
  });
  initialized = true;
}

function patchBrowserComunicaObserver(): void {
  patchObserverPrototype(ActionObserverHttp.prototype);
  patchObserverPrototype(JsonActionObserverHttp.prototype);
}

function patchObserverPrototype(source: object): void {
  const prototype = source as {
    __xpodObservedActorsPatch?: boolean;
    onRun(actor: { name: string }, action: unknown, output: unknown): unknown;
  };
  if (prototype.__xpodObservedActorsPatch) return;
  const originalOnRun = prototype.onRun;
  prototype.onRun = function (this: { observedActors?: string[] }, actor, action, output) {
    if (!Array.isArray(this.observedActors)) this.observedActors = [];
    return originalOnRun.call(this, actor, action, output);
  };
  prototype.__xpodObservedActorsPatch = true;
}
