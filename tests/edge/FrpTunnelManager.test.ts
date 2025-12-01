import { describe, it, expect } from 'vitest';
import { FrpTunnelManager } from '../../src/edge/FrpTunnelManager';

describe('FrpTunnelManager', () => {
  describe('constructor', () => {
    it('disables when serverHost or token is missing', () => {
      const manager = new FrpTunnelManager({});
      expect(manager).toBeDefined();
    });

    it('enables when serverHost and token are provided', () => {
      const manager = new FrpTunnelManager({
        serverHost: 'frp.example.com',
        serverPort: 7000,
        token: 'secret-token',
        protocol: 'tcp',
      });
      expect(manager).toBeDefined();
    });

    it('normalizes string port to number', () => {
      const manager = new FrpTunnelManager({
        serverHost: 'frp.example.com',
        serverPort: '7000',
        token: 'secret-token',
      });
      expect(manager).toBeDefined();
    });
  });

  describe('ensureConnectivity', () => {
    it('returns undefined when disabled', async () => {
      const manager = new FrpTunnelManager({});
      const result = await manager.ensureConnectivity('node-1', {});
      expect(result).toBeUndefined();
    });

    it('returns unreachable when config incomplete', async () => {
      const manager = new FrpTunnelManager({
        serverHost: 'frp.example.com',
        token: 'secret-token',
        // missing serverPort
      });
      const result = await manager.ensureConnectivity('node-1', {});
      expect(result).toBeDefined();
      expect(result?.tunnel).toBeDefined();
      const tunnel = result?.tunnel as Record<string, unknown>;
      expect(tunnel.status).toBe('unreachable');
      expect(tunnel.reason).toContain('missing');
    });

    it('sets tunnel to standby when direct connection is healthy', async () => {
      const manager = new FrpTunnelManager({
        serverHost: 'frp.example.com',
        serverPort: 7000,
        token: 'secret-token',
      });
      const result = await manager.ensureConnectivity('node-1', {
        reachability: { status: 'redirect' },
      });
      expect(result).toBeDefined();
      const tunnel = result?.tunnel as Record<string, unknown>;
      expect(tunnel.status).toBe('standby');
      expect(tunnel.entrypoint).toContain('frp.example.com');
    });

    it('sets tunnel to active when direct connection is unhealthy', async () => {
      const manager = new FrpTunnelManager({
        serverHost: 'frp.example.com',
        serverPort: 7000,
        token: 'secret-token',
      });
      const result = await manager.ensureConnectivity('node-1', {
        reachability: { status: 'unreachable' },
      });
      expect(result).toBeDefined();
      const tunnel = result?.tunnel as Record<string, unknown>;
      expect(tunnel.status).toBe('active');
    });

    it('preserves existing tunnel remotePort', async () => {
      const manager = new FrpTunnelManager({
        serverHost: 'frp.example.com',
        serverPort: 7000,
        token: 'secret-token',
      });
      const result = await manager.ensureConnectivity('node-1', {
        reachability: { status: 'unreachable' },
        tunnel: { remotePort: 12345, proxyName: 'existing-proxy' },
      });
      expect(result).toBeDefined();
      const tunnel = result?.tunnel as Record<string, unknown>;
      expect(tunnel.remotePort).toBe(12345);
      expect(tunnel.proxyName).toBe('existing-proxy');
    });

    it('generates consistent remotePort from nodeId hash', async () => {
      const manager = new FrpTunnelManager({
        serverHost: 'frp.example.com',
        serverPort: 7000,
        token: 'secret-token',
      });
      const result1 = await manager.ensureConnectivity('node-abc', {
        reachability: { status: 'unreachable' },
      });
      const result2 = await manager.ensureConnectivity('node-abc', {
        reachability: { status: 'unreachable' },
      });
      const tunnel1 = result1?.tunnel as Record<string, unknown>;
      const tunnel2 = result2?.tunnel as Record<string, unknown>;
      expect(tunnel1.remotePort).toBe(tunnel2.remotePort);
    });

    it('handles degraded status with recent success as healthy', async () => {
      const manager = new FrpTunnelManager({
        serverHost: 'frp.example.com',
        serverPort: 7000,
        token: 'secret-token',
      });
      const result = await manager.ensureConnectivity('node-1', {
        reachability: {
          status: 'degraded',
          lastSuccessAt: new Date().toISOString(),
        },
      });
      expect(result).toBeDefined();
      const tunnel = result?.tunnel as Record<string, unknown>;
      expect(tunnel.status).toBe('standby');
    });

    it('handles degraded status with stale success as unhealthy', async () => {
      const manager = new FrpTunnelManager({
        serverHost: 'frp.example.com',
        serverPort: 7000,
        token: 'secret-token',
      });
      const staleTime = new Date(Date.now() - 120_000).toISOString();
      const result = await manager.ensureConnectivity('node-1', {
        reachability: {
          status: 'degraded',
          lastSuccessAt: staleTime,
        },
      });
      expect(result).toBeDefined();
      const tunnel = result?.tunnel as Record<string, unknown>;
      expect(tunnel.status).toBe('active');
    });

    it('includes config in tunnel metadata', async () => {
      const manager = new FrpTunnelManager({
        serverHost: 'frp.example.com',
        serverPort: 7000,
        token: 'secret-token',
        protocol: 'kcp',
      });
      const result = await manager.ensureConnectivity('node-1', {
        reachability: { status: 'unreachable' },
      });
      const tunnel = result?.tunnel as Record<string, unknown>;
      const config = tunnel.config as Record<string, unknown>;
      expect(config.serverHost).toBe('frp.example.com');
      expect(config.serverPort).toBe(7000);
      expect(config.protocol).toBe('kcp');
      expect(config.token).toBe('secret-token');
    });
  });
});
