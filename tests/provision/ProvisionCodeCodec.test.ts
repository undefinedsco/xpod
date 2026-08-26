import { describe, it, expect } from 'vitest';
import { ProvisionCodeCodec } from '../../src/provision/ProvisionCodeCodec';

describe('ProvisionCodeCodec', () => {
  const baseUrl = 'https://cloud.example.com/';
  const codec = new ProvisionCodeCodec(baseUrl);

  it('encode/decode round-trip', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const payload = {
      spUrl: 'https://sp.example.com',
      serviceAccessToken: 'sat-secret-token.signature',
      serviceAccessTokenExp: expiresAt,
      nodeId: 'node-1',
      exp: expiresAt,
    };

    const code = codec.encode(payload);
    const decoded = codec.decode(code);

    expect(decoded).toBeDefined();
    expect(decoded!.spUrl).toBe(payload.spUrl);
    expect(decoded!.serviceAccessToken).toBe(payload.serviceAccessToken);
    expect(decoded!.nodeId).toBe(payload.nodeId);
    expect(decoded!.exp).toBe(payload.exp);
  });

  it('encode/decode round-trip with short-lived service access token', () => {
    const payload = {
      spUrl: 'https://sp.example.com',
      serviceAccessToken: 'sat-short-lived-token.signature',
      serviceAccessTokenExp: Math.floor(Date.now() / 1000) + 900,
      nodeId: 'node-1',
      exp: Math.floor(Date.now() / 1000) + 900,
    };

    const code = codec.encode(payload);
    const decoded = codec.decode(code);

    expect(decoded).toBeDefined();
    expect(decoded!.spUrl).toBe(payload.spUrl);
    expect(decoded!.serviceAccessToken).toBe(payload.serviceAccessToken);
    expect(decoded!.serviceAccessTokenExp).toBe(payload.serviceAccessTokenExp);
  });

  it('keeps complete managed route credentials together', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 900;
    const code = codec.encode({
      spUrl: 'https://node-1.nodes.example/',
      serviceAccessToken: 'sat-short-lived-token.signature',
      serviceAccessTokenExp: expiresAt,
      spDomain: 'node-1.nodes.example',
      signalApiUrl: 'https://api.example/',
      routeAccessToken: 'route-token',
      routeAccessTokenExp: expiresAt,
      nodeId: 'node-1',
      exp: expiresAt,
    });

    expect(codec.decode(code)).toEqual(expect.objectContaining({
      signalApiUrl: 'https://api.example/',
      routeAccessToken: 'route-token',
      routeAccessTokenExp: expiresAt,
      nodeId: 'node-1',
    }));
  });

  it('rejects incomplete managed route credentials', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 900;
    const code = codec.encode({
      spUrl: 'https://node-1.nodes.example/',
      serviceAccessToken: 'sat-short-lived-token.signature',
      serviceAccessTokenExp: expiresAt,
      signalApiUrl: 'https://api.example/',
      nodeId: 'node-1',
      exp: expiresAt,
    });

    expect(codec.decode(code)).toBeUndefined();
  });

  it('accepts a legacy managed code without route credentials during rolling upgrades', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 900;
    const code = codec.encode({
      spUrl: 'https://node-1.nodes.example/',
      serviceAccessToken: 'sat-short-lived-token.signature',
      serviceAccessTokenExp: expiresAt,
      nodeId: 'node-1',
      spDomain: 'node-1.nodes.example',
      exp: expiresAt,
    });

    expect(codec.decode(code)).toEqual(expect.objectContaining({
      spDomain: 'node-1.nodes.example',
      nodeId: 'node-1',
    }));
  });

  it('encode/decode round-trip with spDomain', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const payload = {
      spUrl: 'https://sp.example.com',
      serviceAccessToken: 'sat-secret-token.signature',
      serviceAccessTokenExp: expiresAt,
      nodeId: 'node-1',
      spDomain: 'abc123.undefineds.site',
      signalApiUrl: 'https://api.example/',
      routeAccessToken: 'route-token',
      routeAccessTokenExp: expiresAt,
      exp: expiresAt,
    };

    const code = codec.encode(payload);
    const decoded = codec.decode(code);

    expect(decoded).toBeDefined();
    expect(decoded!.spUrl).toBe(payload.spUrl);
    expect(decoded!.serviceAccessToken).toBe(payload.serviceAccessToken);
    expect(decoded!.nodeId).toBe(payload.nodeId);
    expect(decoded!.spDomain).toBe(payload.spDomain);
    expect(decoded!.exp).toBe(payload.exp);
  });

  it('spDomain is undefined when not provided', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const payload = {
      spUrl: 'https://sp.example.com',
      serviceAccessToken: 'sat-secret-token.signature',
      serviceAccessTokenExp: expiresAt,
      exp: expiresAt,
    };

    const code = codec.encode(payload);
    const decoded = codec.decode(code);

    expect(decoded).toBeDefined();
    expect(decoded!.spDomain).toBeUndefined();
  });

  it('normalizes provision baseUrl trailing slash for signing', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const payload = {
      spUrl: 'https://sp.example.com',
      serviceAccessToken: 'sat-secret-token.signature',
      serviceAccessTokenExp: expiresAt,
      exp: expiresAt,
    };
    const slashCodec = new ProvisionCodeCodec('https://cloud.example.com/');
    const noSlashCodec = new ProvisionCodeCodec('https://cloud.example.com');

    expect(noSlashCodec.decode(slashCodec.encode(payload))).toBeDefined();
    expect(slashCodec.decode(noSlashCodec.encode(payload))).toBeDefined();
  });

  it('rejects expired code', () => {
    const code = codec.encode({
      spUrl: 'https://sp.example.com',
      serviceAccessToken: 'sat-expired.signature',
      serviceAccessTokenExp: Math.floor(Date.now() / 1000) - 1,
      exp: Math.floor(Date.now() / 1000) - 1,
    });

    expect(codec.decode(code)).toBeUndefined();
  });

  it('rejects expired service access token payload', () => {
    const code = codec.encode({
      spUrl: 'https://sp.example.com',
      serviceAccessToken: 'sat-expired.signature',
      serviceAccessTokenExp: Math.floor(Date.now() / 1000) - 1,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    expect(codec.decode(code)).toBeUndefined();
  });

  it('rejects tampered code', () => {
    const code = codec.encode({
      spUrl: 'https://sp.example.com',
      serviceAccessToken: 'sat-current.signature',
      serviceAccessTokenExp: Math.floor(Date.now() / 1000) + 3600,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    // Tamper with the payload part
    const tampered = 'x' + code.slice(1);
    expect(codec.decode(tampered)).toBeUndefined();
  });

  it('rejects code signed with different baseUrl', () => {
    const otherCodec = new ProvisionCodeCodec('https://other.example.com/');
    const code = otherCodec.encode({
      spUrl: 'https://sp.example.com',
      serviceAccessToken: 'sat-current.signature',
      serviceAccessTokenExp: Math.floor(Date.now() / 1000) + 3600,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    expect(codec.decode(code)).toBeUndefined();
  });

  it('rejects malformed input', () => {
    expect(codec.decode('')).toBeUndefined();
    expect(codec.decode('nodot')).toBeUndefined();
    expect(codec.decode('.onlysig')).toBeUndefined();
  });
});
