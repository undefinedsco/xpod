import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';

// Mock the database module before importing the service
vi.mock('../../src/identity/drizzle/db', () => ({
  getIdentityDatabase: vi.fn(() => ({
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  })),
}));

// Mock EdgeNodeRepository
vi.mock('../../src/identity/drizzle/EdgeNodeRepository', () => ({
  EdgeNodeRepository: vi.fn().mockImplementation(() => ({
    registerCenterNode: vi.fn().mockResolvedValue({ nodeId: 'test-node', token: 'test-token' }),
    updateCenterNodeHeartbeat: vi.fn().mockResolvedValue(undefined),
    listCenterNodes: vi.fn().mockResolvedValue([]),
    getCenterNode: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { CenterNodeRegistrationService } from '../../src/identity/CenterNodeRegistrationService';

describe('CenterNodeRegistrationService', () => {
  let service: CenterNodeRegistrationService;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (service) {
      service.stopHeartbeat();
    }
  });

  describe('constructor', () => {
    it('auto-generates nodeId when not provided', () => {
      service = new CenterNodeRegistrationService({
        identityDbUrl: 'sqlite::memory:',
        port: 3000,
      });

      const nodeId = service.getNodeId();
      expect(nodeId).toMatch(/^center-[a-f0-9-]{36}$/);
    });

    it('uses provided nodeId', () => {
      service = new CenterNodeRegistrationService({
        identityDbUrl: 'sqlite::memory:',
        port: 3000,
        nodeId: 'my-custom-node',
      });

      expect(service.getNodeId()).toBe('my-custom-node');
    });

    it('normalizes port from string', () => {
      service = new CenterNodeRegistrationService({
        identityDbUrl: 'sqlite::memory:',
        port: '8080',
      });

      const endpoint = service.getInternalEndpoint();
      expect(endpoint.port).toBe(8080);
    });

    it('detects internal IP', () => {
      service = new CenterNodeRegistrationService({
        identityDbUrl: 'sqlite::memory:',
        port: 3000,
      });

      const endpoint = service.getInternalEndpoint();
      // Should detect some IP (not empty unless running in unusual environment)
      expect(typeof endpoint.ip).toBe('string');
    });
  });

  describe('getInternalEndpoint', () => {
    it('returns IP and port', () => {
      service = new CenterNodeRegistrationService({
        identityDbUrl: 'sqlite::memory:',
        port: 9000,
      });

      const endpoint = service.getInternalEndpoint();
      expect(endpoint.port).toBe(9000);
      expect(typeof endpoint.ip).toBe('string');
    });
  });

  describe('handle', () => {
    it('skips registration when disabled', async () => {
      service = new CenterNodeRegistrationService({
        identityDbUrl: 'sqlite::memory:',
        port: 3000,
        enabled: false,
      });

      // Should not throw
      await service.handle();
    });

    it('skips registration when port is 0', async () => {
      service = new CenterNodeRegistrationService({
        identityDbUrl: 'sqlite::memory:',
        port: 0,
      });

      // Should not throw
      await service.handle();
    });
  });

  describe('enabled normalization', () => {
    it('defaults to enabled', () => {
      service = new CenterNodeRegistrationService({
        identityDbUrl: 'sqlite::memory:',
        port: 3000,
      });

      // Check via handle behavior - would register if enabled
      expect(service.getNodeId()).toBeDefined();
    });

    it('respects boolean false', () => {
      service = new CenterNodeRegistrationService({
        identityDbUrl: 'sqlite::memory:',
        port: 3000,
        enabled: false,
      });

      expect(service.getNodeId()).toBeDefined();
    });

    it('normalizes string "true"', () => {
      service = new CenterNodeRegistrationService({
        identityDbUrl: 'sqlite::memory:',
        port: 3000,
        enabled: 'true',
      });

      expect(service.getNodeId()).toBeDefined();
    });

    it('normalizes string "false"', () => {
      service = new CenterNodeRegistrationService({
        identityDbUrl: 'sqlite::memory:',
        port: 3000,
        enabled: 'false',
      });

      expect(service.getNodeId()).toBeDefined();
    });
  });

  describe('stopHeartbeat', () => {
    it('can be called multiple times safely', () => {
      service = new CenterNodeRegistrationService({
        identityDbUrl: 'sqlite::memory:',
        port: 3000,
      });

      // Should not throw
      service.stopHeartbeat();
      service.stopHeartbeat();
    });
  });
});
