import { describe, expect, it } from 'vitest';
import { INVALID_CONFIGURATION_PREFIX, validateBaseUrl } from '../../src/runtime/base-url';

describe('validateBaseUrl', (): void => {
  it('skips validation when CSS_BASE_URL was not explicitly set', (): void => {
    expect((): void => validateBaseUrl({
      baseUrl: 'http://localhost:9999/',
      mainPort: 3000,
      explicit: false,
    })).not.toThrow();
  });

  it('accepts an explicit loopback base URL matching the gateway port', (): void => {
    expect((): void => validateBaseUrl({
      baseUrl: 'http://localhost:3000/',
      mainPort: 3000,
      explicit: true,
    })).not.toThrow();
  });

  it('rejects an explicit loopback base URL on a different port', (): void => {
    expect((): void => validateBaseUrl({
      baseUrl: 'http://localhost:5741/',
      mainPort: 3000,
      explicit: true,
    })).toThrowError(new RegExp(`^${INVALID_CONFIGURATION_PREFIX}`));
  });

  it('rejects a loopback base URL with an implicit default port', (): void => {
    expect((): void => validateBaseUrl({
      baseUrl: 'http://localhost/',
      mainPort: 3000,
      explicit: true,
    })).toThrowError(/port 80/);
  });

  it('rejects non-http(s) schemes', (): void => {
    expect((): void => validateBaseUrl({
      baseUrl: 'ftp://localhost:3000/',
      mainPort: 3000,
      explicit: true,
    })).toThrowError(/http or https/);
  });

  it('rejects subpath hosting', (): void => {
    expect((): void => validateBaseUrl({
      baseUrl: 'http://localhost:3000/solid/',
      mainPort: 3000,
      explicit: true,
    })).toThrowError(/subpath/);
  });

  it('rejects unparseable values', (): void => {
    expect((): void => validateBaseUrl({
      baseUrl: 'not-a-url',
      mainPort: 3000,
      explicit: true,
    })).toThrowError(/not a valid URL/);
  });

  it('accepts non-loopback hosts even when the port differs', (): void => {
    expect((): void => validateBaseUrl({
      baseUrl: 'https://pod.example.com/',
      mainPort: 3000,
      explicit: true,
    })).not.toThrow();
  });

  it('treats 127.0.0.1 as loopback', (): void => {
    expect((): void => validateBaseUrl({
      baseUrl: 'http://127.0.0.1:5741/',
      mainPort: 3000,
      explicit: true,
    })).toThrowError(new RegExp(`^${INVALID_CONFIGURATION_PREFIX}`));
  });

  it('accepts https on the gateway port', (): void => {
    expect((): void => validateBaseUrl({
      baseUrl: 'https://localhost:3443/',
      mainPort: 3443,
      explicit: true,
    })).not.toThrow();
  });
});
