#!/usr/bin/env bun
/**
 * Reports which tunnel clients this deployment can actually run (audit N16).
 *
 * The release artifacts deliberately do not carry ngrok's agent or the natfrp frpc fork (neither
 * is ours to redistribute), so "the tunnel provider is configured" and "the tunnel can start" are
 * different facts. This probe prints, per provider, where its client would come from — an explicit
 * path, a bundled binary, or PATH — and what to install when it is missing.
 *
 * Usage: bun scripts/check-tunnel-clients.ts [--require ngrok,cloudflare] [--json]
 */
import path from 'node:path';
import {
  redistributePolicyNote,
  resolveAllTunnelClients,
  type ResolvedTunnelClient,
} from '../src/tunnel/TunnelClientResolver';
import { TUNNEL_PROVIDERS, type TunnelProviderId } from '../src/tunnel/TunnelProviderCatalog';

interface ProbeRow {
  provider: TunnelProviderId;
  label: string;
  binary: string;
  source: ResolvedTunnelClient['source'] | 'unresolved';
  command: string;
  installHint: string;
  redistributable: boolean;
  /** Whether the client is usable without extra installation (explicit/bundled/PATH hit). */
  ready: boolean;
}

function probe(): ProbeRow[] {
  const resolved = resolveAllTunnelClients({ packageRoot: path.resolve(import.meta.dir, '..') });
  return TUNNEL_PROVIDERS.map((descriptor) => {
    const entry = resolved.find((candidate) => candidate.provider === descriptor.id);
    const client = entry?.resolved;
    // The resolver already resolved a PATH hit to an absolute path; this probe must not keep
    // its own second opinion about what is on PATH.
    const resolvedPath = client?.resolvedPath;
    const source: ProbeRow['source'] = client
      ? (client.source === 'path' && !resolvedPath ? 'unresolved' : client.source)
      : 'unresolved';
    return {
      provider: descriptor.id,
      label: descriptor.label,
      binary: descriptor.client.binary,
      source,
      command: resolvedPath ?? client?.command ?? descriptor.client.binary,
      installHint: descriptor.client.installHint,
      redistributable: descriptor.client.redistributable,
      ready: Boolean(client) && source !== 'unresolved',
    };
  });
}

function parseArgs(argv: string[]): { require: Set<string>; json: boolean } {
  const required = new Set<string>();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--require') {
      for (const value of (argv[++index] ?? '').split(',')) {
        const trimmed = value.trim();
        if (trimmed) {
          required.add(trimmed);
        }
      }
    } else if (arg === '--json') {
      json = true;
    }
  }
  return { require: required, json };
}

function main(argv: string[]): number {
  const options = parseArgs(argv);
  const rows = probe();

  if (options.json) {
    console.log(JSON.stringify({ rows, policy: redistributePolicyNote() }, null, 2));
  } else {
    console.log('tunnel clients:');
    for (const row of rows) {
      const mark = row.ready ? 'ok  ' : 'MISS';
      console.log(`  [${mark}] ${row.provider.padEnd(11)} ${row.binary.padEnd(12)} ${row.source.padEnd(10)} ${row.command}`);
      if (!row.ready) {
        console.log(`         -> ${row.installHint}`);
      }
    }
    console.log(`policy: ${redistributePolicyNote()}`);
    console.log('plugin directory: <package root>/vendor/tunnel-clients/ 见 docs/tunnel-clients.md');
  }

  const missingRequired = [ ...options.require ].filter((provider) => {
    const row = rows.find((candidate) => candidate.provider === provider);
    return !row || !row.ready;
  });
  if (missingRequired.length > 0) {
    console.error(`missing required tunnel client(s): ${missingRequired.join(', ')}`);
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
