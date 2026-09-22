import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveCanonicalRuntimeBaseUrl,
  resolveChildDatabaseUrl,
  resolveCliOidcIssuer,
  resolveIngressPort,
  resolveManagedEdgeAgentConfig,
  resolveMainPort,
  resolveServicePort,
} from '../../src/cli/commands/start';
import { resolveDefaultRdfIndexPath } from '../../src/runtime/database-url';
import { findGatewayIngressPort } from '../../src/runtime/port-finder';

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

  it('keeps the Cloud-issued identity when CSS_BASE_URL points at the local gateway', () => {
    expect(resolveCanonicalRuntimeBaseUrl(
      'https://node-1.nodes.undefineds.co/',
      'http://127.0.0.1:3000/',
      'http://localhost:3000/',
    )).toBe('https://node-1.nodes.undefineds.co/');
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
    const provisioned = {
      cloudApiEndpoint: 'https://api.undefineds.co/',
      nodeId: 'node-1',
      nodeToken: 'node-token',
    };

    expect(resolveManagedEdgeAgentConfig(provisioned, 3000, 3010, { XPOD_P2P_ENABLED: 'true' })).toEqual({
      signalEndpoint: 'https://api.undefineds.co/v1/signal',
      nodeId: 'node-1',
      nodeToken: 'node-token',
      // Forwarded peer traffic must enter through the ingress listener, which never
      // counts as local; LAN clients still address the gateway listener directly.
      targetBaseUrl: 'http://127.0.0.1:3010/',
      lanBaseUrl: 'http://127.0.0.1:3000/',
      p2pEnabled: true,
    });

    // The settings page owns the signal service and the on/off decision.
    expect(resolveManagedEdgeAgentConfig(provisioned, 3000, 3010, {
      XPOD_P2P_ENABLED: 'true',
      XPOD_P2P_SIGNAL_SERVICE: 'wss://signal.example/',
    })).toMatchObject({
      signalEndpoint: 'wss://signal.example/',
      p2pEnabled: true,
    });

    expect(resolveManagedEdgeAgentConfig(provisioned, 3000, 3010, { XPOD_P2P_ENABLED: 'false' })).toMatchObject({
      signalEndpoint: 'https://api.undefineds.co/v1/signal',
      p2pEnabled: false,
    });

    // Peer-to-peer transport is opt-in: an enabled-by-default data plane is what the
    // audit flagged as unsafe to publish.
    expect(resolveManagedEdgeAgentConfig(provisioned, 3000, 3010, {})).toMatchObject({ p2pEnabled: false });

    expect(resolveManagedEdgeAgentConfig(provisioned, 3000)).toMatchObject({
      targetBaseUrl: 'http://127.0.0.1:3000/',
      lanBaseUrl: 'http://127.0.0.1:3000/',
    });

    expect(resolveManagedEdgeAgentConfig({}, 3000)).toBeUndefined();
  });

  it('points the settings API at the same env file the CLI loaded', async() => {
    const { resolveXpodEnvPath } = await import('../../src/runtime/user-env');
    const resolved = resolveXpodEnvPath('/tmp/accept/custom.env', {});
    // The API persists to XPOD_ENV_PATH; the CLI must publish the file it actually read so
    // a deployment started with `-e custom.env` does not save settings into a dead file.
    expect(resolved).toBe('/tmp/accept/custom.env');
  });
});

describe('tunnel origin port', () => {
  const previousCredential = process.env.XPOD_TUNNEL_PROFILE_SAKURA_TOKEN;

  afterEach(() => {
    if (previousCredential === undefined) {
      delete process.env.XPOD_TUNNEL_PROFILE_SAKURA_TOKEN;
    } else {
      process.env.XPOD_TUNNEL_PROFILE_SAKURA_TOKEN = previousCredential;
    }
    vi.unstubAllGlobals();
  });

  it('is the Gateway tunnel entry: predictable, and never the Gateway port itself', async () => {
    // The listener a console forwards to. The Gateway's own port grants local trust to
    // loopback callers, so tunnelled traffic must not land there.
    const port = await resolveIngressPort({ tunnelProfiles: [], tunnelActiveProfileId: 'none' }, 5737);
    expect(port).not.toBe(5737);
    expect(port).toBe(await findGatewayIngressPort(5737));
  });

  it('keeps the Gateway port when a console forwards somewhere else', async () => {
    process.env.XPOD_TUNNEL_PROFILE_SAKURA_TOKEN = 'access-key:29212252';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify([{ id: 29212252, local_ip: '127.0.0.1', local_port: 3599 }]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    // The console value is reported (as a warning to update it), never adopted: moving the
    // gate to match a console would put tunnelled traffic on the trusted listener.
    const port = await resolveIngressPort({
      tunnelProfiles: [ { id: 'sakura', provider: 'sakura_frp', credentialEnvKey: 'XPOD_TUNNEL_PROFILE_SAKURA_TOKEN' } ],
      tunnelActiveProfileId: 'sakura',
    }, 5737);
    expect(port).toBe(await findGatewayIngressPort(5737));
  });
});
