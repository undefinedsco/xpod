import path from 'node:path';
import {
  configureSparqlEngine,
  createNodeModuleSparqlEngineFactory,
} from '@undefineds.co/drizzle-solid';

let configured = false;

export function ensureDrizzleSolidRuntimeConfigured(): void {
  if (configured) {
    return;
  }

  configureSparqlEngine({
    createQueryEngine: createNodeModuleSparqlEngineFactory(
      path.join(process.cwd(), '__xpod_drizzle_sparql_engine__.cjs'),
    ),
  });

  configured = true;
}

ensureDrizzleSolidRuntimeConfigured();
