import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  configureSparqlEngine,
  createNodeModuleSparqlEngineFactory,
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

function getBunComunicaEntrypoints(): string[] {
  const bunDir = path.join(process.cwd(), 'node_modules', '.bun');
  if (!fs.existsSync(bunDir)) {
    return [];
  }

  const packageNames = [
    'actor-query-result-serialize-sparql-json',
    'actor-query-result-serialize-stats',
  ];
  const entrypoints: string[] = [];

  for (const entry of fs.readdirSync(bunDir)) {
    for (const packageName of packageNames) {
      if (!entry.startsWith(`@comunica+${packageName}@`)) {
        continue;
      }

      entrypoints.push(path.join(
        bunDir,
        entry,
        'node_modules',
        '@comunica',
        packageName,
        'lib',
        'index.js',
      ));
    }
  }

  return entrypoints;
}

function patchComunicaActionObserver(): void {
  const requireFromProject = createRequire(path.join(process.cwd(), '__xpod_comunica_patch__.cjs'));
  const moduleNames = [
    '@comunica/actor-query-result-serialize-sparql-json',
    '@comunica/actor-query-result-serialize-stats',
  ];

  for (const moduleId of [ ...moduleNames, ...getBunComunicaEntrypoints() ]) {
    try {
      patchActionObserverModule(requireFromProject(moduleId) as ActionObserverModule);
    } catch {
      // Optional Comunica modules are only present when LDP/SPARQL queries run.
    }
  }
}

export function ensureDrizzleSolidRuntimeConfigured(): void {
  if (configured) {
    return;
  }

  patchComunicaActionObserver();

  configureSparqlEngine({
    createQueryEngine: createNodeModuleSparqlEngineFactory(
      path.join(process.cwd(), '__xpod_drizzle_sparql_engine__.cjs'),
    ),
  });

  configured = true;
}

ensureDrizzleSolidRuntimeConfigured();
