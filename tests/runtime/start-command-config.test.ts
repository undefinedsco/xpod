import { describe, expect, it } from 'vitest';

import {
  resolveCanonicalRuntimeBaseUrl,
  resolveChildDatabaseUrl,
  resolveCliOidcIssuer,
  resolveManagedEdgeAgentConfig,
  resolveMainPort,
  resolveServicePort,
} from '../../src/cli/commands/start';
import { resolveDefaultRdfIndexPath } from '../../src/runtime/database-url';

describe('start command runtime configuration', () => {
  it('uses one env file to derive the gateway, CSS, and API ports', () => {
    const env = {
      CSS_BASE_URL: 'http://localhost:5739/',
      CSS_PORT: '5737',
    };
    const mainPort = resolveMainPort(undefined, env, env.CSS_BASE_URL);
    const cssPort = resolveServicePort(env.CSS_PORT, mainPort + 1, new Set([mainPort]));
    const apiPort = resolveServicePort(undefined, cssPort + 1, new Set([mainPort, cssPort]));

    expect({ mainPort, cssPort, apiPort }).toEqual({
      mainPort: 5739,
      cssPort: 5737,
      apiPort: 5738,
    });
  });

  it('lets an explicit CLI port override the URL-derived gateway port', () => {
    expect(resolveMainPort(6400, {}, 'http://localhost:5739/')).toBe(6400);
  });

  it('never assigns a child service to the gateway port', () => {
    expect(resolveServicePort('5739', 5740, new Set([5739]))).toBe(5740);
  });

  it('shares a relative SQLite identity database across CSS and API child processes', () => {
    expect(resolveChildDatabaseUrl('sqlite:./data/identity.sqlite', '/runtime/css'))
      .toBe('sqlite:/runtime/css/data/identity.sqlite');
    expect(resolveChildDatabaseUrl('sqlite:/shared/identity.sqlite', '/runtime/css'))
      .toBe('sqlite:/shared/identity.sqlite');
  });

  it('places the default RDF index beside the child SQLite RDF database', () => {
    expect(resolveDefaultRdfIndexPath({
      sparqlEndpoint: 'sqlite:./data/rdf.sqlite',
      fallbackRoot: '/runtime/css',
      sqliteRelativeRoot: '/runtime/css',
    })).toBe('/runtime/css/data/rdf-index.sqlite');
  });

  it('keeps non-SQLite RDF endpoints on the legacy runtime index path', () => {
    expect(resolveDefaultRdfIndexPath({
      sparqlEndpoint: 'postgres://db.example/xpod',
      fallbackRoot: '/runtime/css',
      sqliteRelativeRoot: '/runtime/css',
    })).toBe('/runtime/css/rdf-index.sqlite');
  });

  it('uses the Cloud-issued URL as the CSS identity without changing the local Gateway port', () => {
    const canonicalBaseUrl = resolveCanonicalRuntimeBaseUrl(
      'https://node-1.nodes.undefineds.co/',
      undefined,
      'http://localhost:3000/',
    );

    expect(canonicalBaseUrl).toBe('https://node-1.nodes.undefineds.co/');
    expect(resolveMainPort(undefined, {}, undefined)).toBe(3000);
  });

  it('keeps standalone and explicitly configured deployments unchanged', () => {
    expect(resolveCanonicalRuntimeBaseUrl(undefined, 'https://self.example/', 'http://localhost:3000/'))
      .toBe('https://self.example/');
    expect(resolveCanonicalRuntimeBaseUrl(undefined, undefined, 'http://localhost:3000/'))
      .toBe('http://localhost:3000/');
  });

  it('passes a restored Cloud issuer to the CSS child when the env omits it', () => {
    expect(resolveCliOidcIssuer({}, 'https://id.undefineds.co/'))
      .toBe('https://id.undefineds.co/');
    expect(resolveCliOidcIssuer(
      { SOLID_OIDC_ISSUER: 'https://self.example/' },
      'https://id.undefineds.co/',
    )).toBe('https://self.example/');
  });

  it('defaults only an unconfigured Local CLI runtime to the official Cloud identity', () => {
    expect(resolveCliOidcIssuer({}, undefined, 'local'))
      .toBe('https://id.undefineds.co/');
    expect(resolveCliOidcIssuer(
      { SOLID_OIDC_ISSUER: 'http://localhost:3000/' },
      undefined,
      'local',
    )).toBe('http://localhost:3000/');
    expect(resolveCliOidcIssuer({}, undefined, 'cloud')).toBeUndefined();
  });

  it('derives the managed P2P agent from provisioned Cloud state', () => {
    expect(resolveManagedEdgeAgentConfig({
      cloudApiEndpoint: 'https://api.undefineds.co/',
      nodeId: 'node-1',
      nodeToken: 'node-token',
    }, 3000)).toEqual({
      signalEndpoint: 'https://api.undefineds.co/v1/signal',
      nodeId: 'node-1',
      nodeToken: 'node-token',
      targetBaseUrl: 'http://127.0.0.1:3000/',
    });
    expect(resolveManagedEdgeAgentConfig({}, 3000)).toBeUndefined();
  });
});
