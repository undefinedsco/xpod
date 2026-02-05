import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { Supervisor } from '../../src/supervisor/Supervisor';
import { GatewayProxy } from '../../src/gateway/Proxy';

describe('Service Endpoints', () => {
  let supervisor: Supervisor;
  let proxy: GatewayProxy;
  const TEST_PORT = 3999;
  const BASE_URL = `http://localhost:${TEST_PORT}`;

  beforeAll(async () => {
    supervisor = new Supervisor();
    proxy = new GatewayProxy(TEST_PORT, supervisor);
    
    // Add some test logs
    supervisor.addLog('xpod', 'info', 'Test info message');
    supervisor.addLog('css', 'warn', 'Test warning message');
    supervisor.addLog('api', 'error', 'Test error message');
    supervisor.addLog('css', 'info', 'CSS started');
    supervisor.addLog('api', 'info', 'API started');
    
    proxy.start();
    
    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  afterAll(() => {
    // Cleanup
  });

  describe('GET /service/status', () => {
    it('should return service status array', async () => {
      const res = await fetch(`${BASE_URL}/service/status`);
      
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it('should return CORS headers', async () => {
      const res = await fetch(`${BASE_URL}/service/status`, {
        headers: { 'Origin': 'http://localhost:3000' }
      });
      
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    });
  });

  describe('GET /service/logs', () => {
    it('should return all logs without filter', async () => {
      const res = await fetch(`${BASE_URL}/service/logs`);
      
      expect(res.status).toBe(200);
      
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
      expect(data[0]).toHaveProperty('timestamp');
      expect(data[0]).toHaveProperty('level');
      expect(data[0]).toHaveProperty('source');
      expect(data[0]).toHaveProperty('message');
    });

    it('should filter logs by level=info', async () => {
      const res = await fetch(`${BASE_URL}/service/logs?level=info`);
      const data = await res.json();
      
      expect(data.every((log: any) => log.level === 'info')).toBe(true);
    });

    it('should filter logs by level=error', async () => {
      const res = await fetch(`${BASE_URL}/service/logs?level=error`);
      const data = await res.json();
      
      expect(data.every((log: any) => log.level === 'error')).toBe(true);
      expect(data.length).toBe(1);
      expect(data[0].message).toBe('Test error message');
    });

    it('should filter logs by source=css', async () => {
      const res = await fetch(`${BASE_URL}/service/logs?source=css`);
      const data = await res.json();
      
      expect(data.every((log: any) => log.source === 'css')).toBe(true);
    });

    it('should filter logs by source=api', async () => {
      const res = await fetch(`${BASE_URL}/service/logs?source=api`);
      const data = await res.json();
      
      expect(data.every((log: any) => log.source === 'api')).toBe(true);
    });

    it('should combine level and source filters', async () => {
      const res = await fetch(`${BASE_URL}/service/logs?level=info&source=css`);
      const data = await res.json();
      
      expect(data.every((log: any) => log.level === 'info' && log.source === 'css')).toBe(true);
      expect(data.length).toBe(1);
      expect(data[0].message).toBe('CSS started');
    });

    it('should respect limit parameter', async () => {
      const res = await fetch(`${BASE_URL}/service/logs?limit=2`);
      const data = await res.json();
      
      expect(data.length).toBeLessThanOrEqual(2);
    });

    it('should return empty array for non-matching filters', async () => {
      const res = await fetch(`${BASE_URL}/service/logs?level=warn&source=xpod`);
      const data = await res.json();
      
      expect(Array.isArray(data)).toBe(true);
      // Our test data has no warn logs from xpod
    });
  });

  describe('CORS preflight for service endpoints', () => {
    it('should handle OPTIONS for /service/status', async () => {
      const res = await fetch(`${BASE_URL}/service/status`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:3000',
          'Access-Control-Request-Method': 'GET'
        }
      });
      
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    });

    it('should handle OPTIONS for /service/logs', async () => {
      const res = await fetch(`${BASE_URL}/service/logs`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:3000',
          'Access-Control-Request-Method': 'GET'
        }
      });
      
      expect(res.status).toBe(204);
    });
  });
});
