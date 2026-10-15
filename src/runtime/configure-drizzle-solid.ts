import * as sparqlJsonObserver from '@comunica/actor-query-result-serialize-sparql-json';
import * as statsObserver from '@comunica/actor-query-result-serialize-stats';
import {
  configureSparqlEngine,
  type SPARQLQueryEngine,
} from '@undefineds.co/drizzle-solid';

let configured = false;

type ActionObserverModule = {
  ActionObserverHttp?: {
    prototype: {
      onRun?: (actor: unknown, action: unknown, output: unknown) => unknown;
      __xpodObservedActorsPatched?: boolean;
    };
  };
};

function patchActionObserverModule(mod: ActionObserverModule): void {
  const proto = mod.ActionObserverHttp?.prototype;
  const originalOnRun = proto?.onRun;
  if (!proto || !originalOnRun || proto.__xpodObservedActorsPatched) {
    return;
  }

  proto.onRun = function(this: { observedActors?: string[] }, actor, action, output): unknown {
    if (!Array.isArray(this.observedActors)) {
      this.observedActors = [];
    }
    return originalOnRun.call(this, actor, action, output);
  };
  proto.__xpodObservedActorsPatched = true;
}

function patchBundledActionObservers(): void {
  patchActionObserverModule(sparqlJsonObserver as unknown as ActionObserverModule);
  patchActionObserverModule(statsObserver as unknown as ActionObserverModule);
}

export async function createBundledQueryEngine(): Promise<SPARQLQueryEngine> {
  const comunica = await import('@comunica/query-sparql-solid');
  // Patch the exact bundled instances before constructing the actor graph.
  patchBundledActionObservers();

  return new comunica.QueryEngine() as unknown as SPARQLQueryEngine;
}

export function ensureDrizzleSolidRuntimeConfigured(): void {
  if (configured) {
    return;
  }

  // Direct CSS evaluators share these actor prototypes with the ORM factory.
  patchBundledActionObservers();

  configureSparqlEngine({
    createQueryEngine: createBundledQueryEngine,
  });

  configured = true;
}

ensureDrizzleSolidRuntimeConfigured();
