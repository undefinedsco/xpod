import { describe, expect, it } from 'vitest';
import { resolveRuntimeBootstrap } from '../../src/runtime/bootstrap';
import { createRuntimeEnvironmentSession } from '../../src/runtime/environment';
import { nodeRuntimeHost } from '../../src/runtime/host/node/NodeRuntimeHost';

describe('runtime environment session', () => {
  it('should apply and restore runtime env deterministically', async() => {
    const previous = process.env.CSS_BASE_URL;
    const state = await resolveRuntimeBootstrap('env-test', {
      mode: 'local',
      transport: 'port',
      runtimeRoot: '.test-data/runtime-environment',
      bindHost: '127.0.0.1',
      gatewayPort: 5810,
      cssPort: 5811,
      apiPort: 5812,
    }, nodeRuntimeHost);

    const session = createRuntimeEnvironmentSession(state, {
      mode: 'local',
      transport: 'port',
    });

    expect(process.env.CSS_BASE_URL).toBe('http://127.0.0.1:5810/');
    expect(session.shorthand.edition).toBe('local');

    session.restore();
    expect(process.env.CSS_BASE_URL).toBe(previous);

    session.restore();
    expect(process.env.CSS_BASE_URL).toBe(previous);
  });
});
