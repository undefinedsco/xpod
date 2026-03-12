import { describe, expect, it } from 'vitest';
import { buildRuntimeEnv, buildRuntimeShorthand, resolveRuntimeBootstrap } from '../../src/runtime/bootstrap';
import { nodeRuntimeHost } from '../../src/runtime/host/node/NodeRuntimeHost';

describe('runtime bootstrap helpers', () => {
  it('should resolve socket runtime bootstrap layout', async() => {
    const state = await resolveRuntimeBootstrap('test-id', {
      mode: 'local',
      transport: 'socket',
      runtimeRoot: '.test-data/runtime-bootstrap/socket',
      gatewayPort: 5610,
      cssPort: 5611,
      apiPort: 5612,
    }, nodeRuntimeHost);

    expect(state.transport).toBe('socket');
    expect(state.baseUrl).toBe('http://localhost/');
    expect(state.sockets.gateway).toContain('gateway.sock');
    expect(state.sockets.api).toContain('api.sock');
    expect(state.ports.gateway).toBe(5610);
  });

  it('should build env and shorthand from bootstrap state', async() => {
    const state = await resolveRuntimeBootstrap('test-port', {
      mode: 'cloud',
      transport: 'port',
      runtimeRoot: '.test-data/runtime-bootstrap/port',
      bindHost: '127.0.0.1',
      gatewayPort: 5710,
      cssPort: 5711,
      apiPort: 5712,
      open: true,
    }, nodeRuntimeHost);

    const runtimeEnv = buildRuntimeEnv(state, {
      mode: 'cloud',
      transport: 'port',
      edgeNodesEnabled: true,
      centerRegistrationEnabled: true,
    }, {
      XPOD_NODE_ID: 'node-1',
    });

    const shorthand = buildRuntimeShorthand(runtimeEnv, {
      mode: 'cloud',
      edgeNodesEnabled: true,
      centerRegistrationEnabled: true,
    }, state);

    expect(runtimeEnv.CSS_BASE_URL).toBe('http://127.0.0.1:5710/');
    expect(runtimeEnv.API_PORT).toBe('5712');
    expect(shorthand.edition).toBe('server');
    expect(shorthand.nodeId).toBe('node-1');
    expect(shorthand.edgeNodesEnabled).toBe(true);
    expect(shorthand.centerRegistrationEnabled).toBe(true);
  });
});
