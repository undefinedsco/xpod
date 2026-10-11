import type { ServiceConfig } from '../supervisor/types';
import type { RuntimeConnectionTarget } from './host/types';

export type RuntimeCapability = 'css' | 'api';

/** Produced by the host from an admitted module's entry and allocated endpoint. */
export interface RuntimeModuleDescription {
  readonly id: RuntimeCapability;
  readonly process: Readonly<Omit<ServiceConfig, 'args'>> & { readonly args: readonly string[] };
  readonly target: RuntimeConnectionTarget;
}

export interface RuntimePlan {
  readonly modules: readonly RuntimeModuleDescription[];
  readonly targets: Readonly<Partial<Record<RuntimeCapability, RuntimeConnectionTarget>>>;
}

/** Module selection is a host input. Deployment edition never selects capabilities. */
export function deriveRuntimePlan(options: {
  modules: readonly RuntimeModuleDescription[];
  baseUrl: string;
  externalOidcIssuer?: string;
}): RuntimePlan {
  const selected = new Map<RuntimeCapability, RuntimeModuleDescription>();
  for (const module of options.modules) {
    if (module.id !== 'css' && module.id !== 'api') throw new Error('Unknown runtime capability');
    if (selected.has(module.id)) throw new Error('Duplicate runtime capability');
    if (module.process.name !== module.id) throw new Error('Runtime process capability mismatch');
    if (!module.process.command || (!module.target.url && !module.target.socketPath)) {
      throw new Error('Runtime module process or endpoint missing');
    }
    selected.set(module.id, module);
  }
  if (selected.has('api') && !selected.has('css')) {
    // The API's existing default token endpoint is served by the local CSS child.
    // An API-only host must provide the actual independent issuer authority.
    let issuer: URL;
    try { issuer = new URL(options.externalOidcIssuer ?? ''); } catch {
      throw new Error('API-only runtime requires an independent OIDC issuer');
    }
    if (!['http:', 'https:'].includes(issuer.protocol) || issuer.username || issuer.password
      || issuer.search || issuer.hash || issuer.origin === new URL(options.baseUrl).origin) {
      throw new Error('API-only runtime requires an independent OIDC issuer');
    }
  }
  const modules = (['css', 'api'] as const).flatMap(id => {
    const module = selected.get(id);
    return module ? [Object.freeze({ id, process: Object.freeze({ ...module.process,
      args: Object.freeze([...module.process.args]),
      ...(module.process.env ? { env: Object.freeze({ ...module.process.env }) } : {}),
    }), target: Object.freeze({ ...module.target }) })] : [];
  });
  return Object.freeze({ modules: Object.freeze(modules),
    targets: Object.freeze(Object.fromEntries(modules.map(module => [module.id, module.target]))),
  });
}

/** One plan drives process registration and routing, with no disabled implementation lookup. */
export function applyRuntimePlan(plan: RuntimePlan, host: {
  register(config: ServiceConfig): void;
  setTargets(targets: Partial<Record<RuntimeCapability, RuntimeConnectionTarget>>): void;
}): void {
  for (const module of plan.modules) host.register({ ...module.process, args: [...module.process.args] });
  host.setTargets(plan.targets);
}
