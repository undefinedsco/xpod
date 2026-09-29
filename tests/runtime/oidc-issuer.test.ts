import { describe, expect, it } from 'vitest';
import {
  cloudApiEndpointFromIssuer,
  isLoopbackIssuer,
  resolveExternalOidcIssuer,
} from '../../src/runtime/oidc-issuer';

describe('OIDC issuer configuration', () => {
  it('reads the canonical uppercase environment key', () => {
    expect(resolveExternalOidcIssuer({ SOLID_OIDC_ISSUER: 'https://id.example/' })).toBe('https://id.example/');
  });

  it('does not infer an issuer when the canonical shorthand is absent', () => {
    expect(resolveExternalOidcIssuer({})).toBeUndefined();
  });

  it('ignores the internal Components.js shorthand as a process alias', () => {
    expect(resolveExternalOidcIssuer({ oidcIssuer: 'https://wrong.example/' })).toBeUndefined();
  });

  it('recognizes an issuer only this machine could serve', () => {
    expect(isLoopbackIssuer('http://127.0.0.1:41300/')).toBe(true);
    expect(isLoopbackIssuer('http://127.0.0.1:3000/')).toBe(true);
    expect(isLoopbackIssuer('http://localhost:41300/')).toBe(true);
    expect(isLoopbackIssuer('http://[::1]:41300/')).toBe(true);
    expect(isLoopbackIssuer('https://id.undefineds.co/')).toBe(false);
    expect(isLoopbackIssuer('https://127.example.com/')).toBe(false);
    expect(isLoopbackIssuer(undefined)).toBe(false);
    expect(isLoopbackIssuer('not a url')).toBe(false);
  });

  it('derives the official split control plane and self-hosted same-origin control plane', () => {
    expect(cloudApiEndpointFromIssuer('https://id.undefineds.co/')).toBe('https://api.undefineds.co');
    expect(cloudApiEndpointFromIssuer('https://solid.example/idp/')).toBe('https://solid.example');
  });
});
