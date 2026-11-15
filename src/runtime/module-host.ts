import { Supervisor } from '../supervisor/Supervisor';
import { GatewayProxy } from './Proxy';
import { nodeRuntimeHost } from './host/node/NodeRuntimeHost';
import type { RuntimeHost } from './host/types';
import { applyRuntimePlan, deriveRuntimePlan } from './service-plan';
import type { RuntimeModuleDescription, RuntimePlan } from './service-plan';

export interface ModuleRuntimeOptions {
  modules: readonly RuntimeModuleDescription[];
  baseUrl: string;
  externalOidcIssuer?: string;
  port?: number;
  bindHost?: string;
  socketPath?: string;
  runtimeHost?: RuntimeHost;
  ingressPort?: number;
  internalAdminAuthSecret?: string;
}

export interface ModuleRuntimeHandle {
  readonly plan: RuntimePlan;
  readonly supervisor: Supervisor;
  readonly gateway: GatewayProxy;
  readonly closed: Promise<void>;
  readonly cleanupFailure: Promise<unknown>;
  /** Failed cleanup remains retryable; callers must retain module leases. */
  stop(): Promise<void>;
}

export class ModuleRuntimeStartupError extends Error {
  constructor(readonly startupError: unknown, readonly cleanupError: unknown,
    readonly runtime: ModuleRuntimeHandle) {
    super('Module runtime startup failed and cleanup did not complete');
    this.name = 'ModuleRuntimeStartupError';
  }
}

/** Launch only admitted descriptors; this entry imports no CSS/API implementation. */
export async function startModuleRuntime(options: ModuleRuntimeOptions): Promise<ModuleRuntimeHandle> {
  const plan = deriveRuntimePlan(options);
  const runtimeHost = options.runtimeHost ?? nodeRuntimeHost;
  const supervisor = new Supervisor({ handleProcessSignals: false });
  let reportClosed!: () => void;
  const closed = new Promise<void>(resolve => { reportClosed = resolve; });
  let reportFailure!: (error: unknown) => void;
  const cleanupFailure = new Promise<unknown>(resolve => { reportFailure = resolve; });
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (!stopping) {
      stopping = Promise.allSettled([gateway.stop(), supervisor.stopAll()]).then(results => {
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, 'Module runtime cleanup did not complete');
        reportClosed();
      });
      void stopping.catch(error => { reportFailure(error); stopping = undefined; });
    }
    return stopping;
  };
  const gateway = new GatewayProxy(options.port, supervisor, options.bindHost, {
    runtimeHost, socketPath: options.socketPath, baseUrl: options.baseUrl,
    ingressPort: options.ingressPort, internalAdminAuthSecret: options.internalAdminAuthSecret,
    exitOnStop: false, shutdownHandler: stop, requireCloseCompletion: true,
  });
  const handle: ModuleRuntimeHandle = Object.freeze({plan, supervisor, gateway, closed, cleanupFailure, stop});
  applyRuntimePlan(plan, {
    register: config => supervisor.register(config),
    setTargets: targets => gateway.setTargets(targets),
  });
  try {
    await supervisor.startAll();
    for (const module of plan.modules) {
      if (!await runtimeHost.isConnectionTargetReady(module.target, 30_000)) {
        throw new Error(`Runtime module ${module.id} did not become ready`);
      }
    }
    await gateway.start();
    return handle;
  } catch (error) {
    try { await stop(); } catch (cleanupError) {
      throw new ModuleRuntimeStartupError(error, cleanupError, handle);
    }
    throw error;
  }
}
