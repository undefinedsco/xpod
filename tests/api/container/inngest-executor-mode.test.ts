import { describe, expect, it } from 'vitest';
import { createApiContainer, type ApiContainerConfig } from '../../../src/api/container';
import type { InngestRunExecutionBackend } from '../../../src/api/runs/InngestRunExecutionBackend';

// The Inngest SDK decides whether the serve handler verifies the x-inngest-signature
// header from the client's mode: mode !== "cloud" skips validation. The spawned
// `inngest dev` executor never signs its callback requests, while a managed Inngest
// server does, so signature mode is a property of the executor protocol, not of
// whether delivery is durable. These assertions lock that separation: a durable
// spawned executor must still serve in dev mode.
//
// The authoritative fact is EmbeddedInngestRuntimeConfig.mode, produced by
// EmbeddedInngestService.start() and consumed here.
function baseConfig(overrides: Partial<ApiContainerConfig>): ApiContainerConfig {
  return {
    edition: 'local',
    port: 3001,
    host: '127.0.0.1',
    authMode: 'acp',
    databaseUrl: 'sqlite::memory:',
    corsOrigins: ['*'],
    cssTokenEndpoint: 'http://localhost/.oidc/token',
    rdfIndexPath: ':memory:',
    ...overrides,
  };
}

function durableRuntime(mode: 'managed' | 'spawn') {
  return {
    enabled: true,
    durableDelivery: true,
    mode,
    baseUrl: mode === 'spawn' ? 'http://127.0.0.1:8288' : 'http://xpod-inngest:8288',
    eventKey: 'event-key',
    signingKey: 'signing-key',
    functionEndpoint: 'http://localhost:3001/api/inngest',
  };
}

function clientMode(config: ApiContainerConfig): string {
  const container = createApiContainer(config);
  try {
    const backend = container.resolve('runExecutionBackend') as InngestRunExecutionBackend;
    return (backend.getClient() as unknown as { mode: string }).mode;
  } finally {
    void container.dispose();
  }
}

describe('Inngest executor signature mode', () => {
  it('serves the spawned dev executor without signature validation even when delivery is durable', () => {
    const mode = clientMode(baseConfig({
      edition: 'local',
      inngestRuntimeConfig: durableRuntime('spawn'),
    }));

    expect(mode).toBe('dev');
  });

  it('keeps signature validation for a managed executor', () => {
    const mode = clientMode(baseConfig({
      edition: 'cloud',
      sparqlEndpoint: 'postgres://user:pass@localhost:5432/xpod',
      inngestRuntimeConfig: durableRuntime('managed'),
    }));

    expect(mode).toBe('cloud');
  });

  it('treats a runtime without a resolved mode as non-spawn (managed signature expectation)', () => {
    const mode = clientMode(baseConfig({
      edition: 'cloud',
      sparqlEndpoint: 'postgres://user:pass@localhost:5432/xpod',
      inngestRuntimeConfig: {
        enabled: true,
        durableDelivery: true,
        baseUrl: 'http://xpod-inngest:8288',
        eventKey: 'event-key',
        signingKey: 'signing-key',
      },
    }));

    expect(mode).toBe('cloud');
  });

  it('stays in dev mode when Inngest is not enabled', () => {
    const mode = clientMode(baseConfig({
      edition: 'cloud',
      sparqlEndpoint: 'postgres://user:pass@localhost:5432/xpod',
      inngestRuntimeConfig: { enabled: false, durableDelivery: false },
    }));

    expect(mode).toBe('dev');
  });
});
