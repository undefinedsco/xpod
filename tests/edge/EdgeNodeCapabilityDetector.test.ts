import { EdgeNodeCapabilityDetector } from '../../src/edge/EdgeNodeCapabilityDetector';

describe('EdgeNodeCapabilityDetector', () => {
  let detector: EdgeNodeCapabilityDetector;

  beforeEach(() => {
    detector = new EdgeNodeCapabilityDetector();
  });

  describe('detectCapabilities', () => {
    it('should return basic capabilities when no configuration is provided', async () => {
      const capabilities = await detector.detectCapabilities();
      
      expect(capabilities).toBeDefined();
      expect(capabilities.solidProtocolVersion).toBeDefined();
      expect(capabilities.storageBackends).toBeDefined();
      expect(capabilities.authMethods).toBeDefined();
    });

    it('should use base capabilities when provided', async () => {
      const baseCapabilities = {
        solidProtocolVersion: 'solid-1.0-test',
        maxBandwidth: 100,
        location: {
          country: 'US',
          region: 'California',
        },
      };

      const detectorWithBase = new EdgeNodeCapabilityDetector({
        baseCapabilities,
      });

      const capabilities = await detectorWithBase.detectCapabilities();
      
      expect(capabilities.solidProtocolVersion).toBe('solid-1.0-test');
      expect(capabilities.maxBandwidth).toBe(100);
      expect(capabilities.location).toEqual({
        country: 'US',
        region: 'California',
      });
    });
  });

  describe('capabilitiesToStringArray', () => {
    it('should convert structured capabilities to string array', () => {
      const capabilities = {
        solidProtocolVersion: 'solid-0.11',
        storageBackends: ['filesystem', 's3-compatible'],
        authMethods: ['webid', 'oidc'],
        maxBandwidth: 50,
        location: {
          country: 'US',
          region: 'California',
        },
      };

      const stringArray = EdgeNodeCapabilityDetector.capabilitiesToStringArray(capabilities);
      
      expect(stringArray).toContain('solid:solid-0.11');
      expect(stringArray).toContain('storage:filesystem');
      expect(stringArray).toContain('storage:s3-compatible');
      expect(stringArray).toContain('auth:webid');
      expect(stringArray).toContain('auth:oidc');
      expect(stringArray).toContain('bandwidth:50mbps');
      expect(stringArray).toContain('location:US');
      expect(stringArray).toContain('region:California');
    });

    it('should handle partial capabilities', () => {
      const capabilities = {
        solidProtocolVersion: 'solid-0.11',
      };

      const stringArray = EdgeNodeCapabilityDetector.capabilitiesToStringArray(capabilities);
      
      expect(stringArray).toContain('solid:solid-0.11');
      expect(stringArray).toHaveLength(1);
    });
  });

  describe('parseCapabilitiesFromStringArray', () => {
    it('should parse capabilities from string array', () => {
      const capabilityStrings = [
        'solid:solid-0.11',
        'storage:filesystem',
        'storage:s3-compatible',
        'auth:webid',
        'auth:oidc',
        'bandwidth:50mbps',
        'location:US',
        'region:California',
      ];

      const capabilities = EdgeNodeCapabilityDetector.parseCapabilitiesFromStringArray(capabilityStrings);
      
      expect(capabilities.solidProtocolVersion).toBe('solid-0.11');
      expect(capabilities.storageBackends).toEqual(['filesystem', 's3-compatible']);
      expect(capabilities.authMethods).toEqual(['webid', 'oidc']);
      expect(capabilities.maxBandwidth).toBe(50);
      expect(capabilities.location?.country).toBe('US');
      expect(capabilities.location?.region).toBe('California');
    });

    it('should handle empty array', () => {
      const capabilities = EdgeNodeCapabilityDetector.parseCapabilitiesFromStringArray([]);
      
      expect(Object.keys(capabilities)).toHaveLength(0);
    });
  });

  describe('round-trip conversion', () => {
    it('should maintain data integrity through conversion', () => {
      const originalCapabilities = {
        solidProtocolVersion: 'solid-0.11',
        storageBackends: ['filesystem', 's3-compatible'],
        authMethods: ['webid', 'oidc'],
        maxBandwidth: 50,
        location: {
          country: 'US',
          region: 'California',
        },
      };

      // Convert to string array and back
      const stringArray = EdgeNodeCapabilityDetector.capabilitiesToStringArray(originalCapabilities);
      const parsedCapabilities = EdgeNodeCapabilityDetector.parseCapabilitiesFromStringArray(stringArray);
      
      expect(parsedCapabilities.solidProtocolVersion).toBe(originalCapabilities.solidProtocolVersion);
      expect(parsedCapabilities.storageBackends).toEqual(originalCapabilities.storageBackends);
      expect(parsedCapabilities.authMethods).toEqual(originalCapabilities.authMethods);
      expect(parsedCapabilities.maxBandwidth).toBe(originalCapabilities.maxBandwidth);
      expect(parsedCapabilities.location).toEqual(originalCapabilities.location);
    });
  });
});