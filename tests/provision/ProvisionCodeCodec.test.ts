import { describe, it, expect } from 'vitest';
import { ProvisionCodeCodec } from '../../src/provision/ProvisionCodeCodec';

describe('ProvisionCodeCodec', () => {
  const baseUrl = 'https://cloud.example.com/';
  const codec = new ProvisionCodeCodec(baseUrl);

  it('encode/decode round-trip', () => {
    const payload = {
      spUrl: 'https://sp.example.com',
      serviceToken: 'st-secret-token',
      nodeId: 'node-1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const code = codec.encode(payload);
    const decoded = codec.decode(code);

    expect(decoded).toBeDefined();
    expect(decoded!.spUrl).toBe(payload.spUrl);
    expect(decoded!.serviceToken).toBe(payload.serviceToken);
    expect(decoded!.nodeId).toBe(payload.nodeId);
    expect(decoded!.exp).toBe(payload.exp);
  });

  it('encode/decode round-trip with spDomain', () => {
    const payload = {
      spUrl: 'https://sp.example.com',
      serviceToken: 'st-secret-token',
      nodeId: 'node-1',
      spDomain: 'abc123.undefineds.site',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const code = codec.encode(payload);
    const decoded = codec.decode(code);

    expect(decoded).toBeDefined();
    expect(decoded!.spUrl).toBe(payload.spUrl);
    expect(decoded!.serviceToken).toBe(payload.serviceToken);
    expect(decoded!.nodeId).toBe(payload.nodeId);
    expect(decoded!.spDomain).toBe(payload.spDomain);
    expect(decoded!.exp).toBe(payload.exp);
  });

  it('spDomain is undefined when not provided', () => {
    const payload = {
      spUrl: 'https://sp.example.com',
      serviceToken: 'st-secret-token',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const code = codec.encode(payload);
    const decoded = codec.decode(code);

    expect(decoded).toBeDefined();
    expect(decoded!.spDomain).toBeUndefined();
  });

  it('rejects expired code', () => {
    const code = codec.encode({
      spUrl: 'https://sp.example.com',
      serviceToken: 'st-xxx',
      exp: Math.floor(Date.now() / 1000) - 1,
    });

    expect(codec.decode(code)).toBeUndefined();
  });

  it('rejects tampered code', () => {
    const code = codec.encode({
      spUrl: 'https://sp.example.com',
      serviceToken: 'st-xxx',
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
      serviceToken: 'st-xxx',
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
