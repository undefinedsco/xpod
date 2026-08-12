import { rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSqliteRuntime } from '../../../src/storage/SqliteRuntime';
import {
  LocalQleverNativeSparqlClient,
  LocalQleverRuntimeError,
  requiresWindowsCommandShell,
  resolveLocalQleverRuntimeCommand,
} from '../../../src/storage/rdf/LocalQleverNativeSparqlClient';
import { createTestDir } from '../../utils/sqlite';
import { createFakeQleverRuntimeCommand } from '../../helpers/qleverRuntime';

const fixture = path.resolve(__dirname, '../../fixtures/fake-qlever-native-runtime.js');

function createClient(mode = 'normal', overrides: {
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
} = {}): LocalQleverNativeSparqlClient {
  return new LocalQleverNativeSparqlClient({
    command: process.execPath,
    args: [ fixture, `--mode=${mode}` ],
    expectedNativeSparqlAbiVersion: 1,
    expectedPhysicalBackendAbiVersion: 7,
    startupTimeoutMs: overrides.startupTimeoutMs ?? 1_000,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 1_000,
  });
}

function seedRuntimeDatabase(databasePath: string): void {
  const database = getSqliteRuntime().openDatabase(databasePath);
  try {
    database.exec(`
      CREATE TABLE rdf_terms (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        datatype_id INTEGER,
        lang TEXT
      );
      CREATE TABLE rdf_quads (
        graph_id INTEGER NOT NULL,
        subject_id INTEGER NOT NULL,
        predicate_id INTEGER NOT NULL,
        object_id INTEGER NOT NULL
      );
      INSERT INTO rdf_terms (id, kind, value, datatype_id, lang) VALUES
        (1, 'iri', 'https://pod.example/a.ttl', NULL, NULL),
        (2, 'iri', 'https://pod.example/a.ttl#subject', NULL, NULL),
        (3, 'iri', 'http://example.org/xpod-smoke#label', NULL, NULL),
        (4, 'literal', 'runtime sparql smoke', NULL, NULL);
      INSERT INTO rdf_quads (graph_id, subject_id, predicate_id, object_id)
      VALUES (1, 2, 3, 4);
    `);
  } finally {
    database.close();
  }
}

describe('LocalQleverNativeSparqlClient', () => {
  it('resolves the packaged runtime command internally with an env-only launcher override', () => {
    expect(resolveLocalQleverRuntimeCommand({} as NodeJS.ProcessEnv))
      .toBe('/opt/xpod/qlever/bin/xpod_qlever_local_runtime');
    expect(resolveLocalQleverRuntimeCommand({
      XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: '/package/qlever/bin/xpod_qlever_local_runtime',
    } as NodeJS.ProcessEnv)).toBe('/package/qlever/bin/xpod_qlever_local_runtime');

    const client = new LocalQleverNativeSparqlClient({
      args: [ '--sqlite-path', ':memory:' ],
      env: {
        XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: '/env/qlever/bin/xpod_qlever_local_runtime',
      },
    });
    expect((client as any).options).toMatchObject({
      command: '/env/qlever/bin/xpod_qlever_local_runtime',
      args: [ '--sqlite-path', ':memory:' ],
    });
  });

  it('treats client env as overrides without hiding the launcher process env', () => {
    const previous = process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND;
    process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND = '/process/qlever/bin/xpod_qlever_local_runtime';
    try {
      const client = new LocalQleverNativeSparqlClient({
        args: [ '--sqlite-path', ':memory:' ],
        env: {},
      });
      expect((client as any).options.command)
        .toBe('/process/qlever/bin/xpod_qlever_local_runtime');
    } finally {
      if (previous === undefined) {
        delete process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND;
      } else {
        process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND = previous;
      }
    }
  });

  it('uses the Windows command shell only for explicit batch launchers', () => {
    expect(requiresWindowsCommandShell('C:\\runtime\\qlever.cmd', 'win32')).toBe(true);
    expect(requiresWindowsCommandShell('C:\\runtime\\qlever.BAT', 'win32')).toBe(true);
    expect(requiresWindowsCommandShell('C:\\runtime\\qlever.exe', 'win32')).toBe(false);
    expect(requiresWindowsCommandShell('/tmp/qlever.cmd', 'linux')).toBe(false);
  });

  it('keeps one ready SQLite runtime and correlates native result envelopes', async () => {
    const client = createClient();
    try {
      const first = await client.query('ASK {}', {
        basePath: 'https://pod.example/',
        sourceUri: 'https://pod.example/a.ttl',
        acceptMediaType: 'application/sparql-results+json',
        accessScope: {
          basePath: 'https://pod.example/',
          mode: 'read',
          resolved: true,
          allowedGraphUrls: [ 'https://pod.example/a.ttl' ],
          allowedSourceUrls: [ 'https://pod.example/source/a.ttl' ],
          deniedSourceUrls: [ 'https://pod.example/source/private.ttl' ],
          deniedSourcePrefixes: [ 'https://pod.example/source/internal/' ],
        },
        vectorQuery: {
          embedding: [ 0.1, 0.2, 0.3 ],
          metric: 'cosine',
          provider: 'cloudflare',
          model: '@cf/baai/bge-small-en-v1.5',
          modelVersion: '2026-08-12',
          inputKind: 'text',
          projectionPolicyVersion: 'rdf-entity-card-v1',
          limit: 7,
          retrievalPointVariable: '?retrieval',
          resourceVariable: '?resource',
          threshold: 0.42,
        },
      });
      const second = await client.query('SELECT * WHERE {}', {
        basePath: 'https://pod.example/',
      });

      expect(JSON.parse(first.body)).toEqual({ boolean: true });
      expect(first.profile).toMatchObject({
        options: {
          basePath: 'https://pod.example/',
          sourceUri: 'https://pod.example/a.ttl',
          accessScope: {
            resolved: true,
            allowedGraphUrls: [ 'https://pod.example/a.ttl' ],
            allowedSourceUrls: [ 'https://pod.example/source/a.ttl' ],
            deniedSourceUrls: [ 'https://pod.example/source/private.ttl' ],
            deniedSourcePrefixes: [ 'https://pod.example/source/internal/' ],
          },
          vectorQuery: {
            embedding: [ 0.1, 0.2, 0.3 ],
            metric: 'cosine',
            provider: 'cloudflare',
            model: '@cf/baai/bge-small-en-v1.5',
            modelVersion: '2026-08-12',
            inputKind: 'text',
            projectionPolicyVersion: 'rdf-entity-card-v1',
            limit: 7,
            retrievalPointVariable: '?retrieval',
            resourceVariable: '?resource',
            threshold: 0.42,
          },
        },
      });
      expect((first.profile as { pid: number }).pid).toBe((second.profile as { pid: number }).pid);
    } finally {
      await client.close();
    }
  });

  it('allows prepareUpdate but refuses persistent direct updates', async () => {
    const client = createClient();
    try {
      await expect(client.query('INSERT DATA { GRAPH <https://pod.example/a.ttl> { <x:a> <x:p> <x:b> } }', {
        basePath: 'https://pod.example/',
        operation: 'execute',
      })).resolves.toMatchObject({
        status: 'error',
        error: 'update_authority_required',
      });
      await expect(client.query('INSERT DATA { GRAPH <https://pod.example/a.ttl> { <x:a> <x:p> <x:b> } }', {
        basePath: 'https://pod.example/',
        operation: 'prepareUpdate',
      })).resolves.toMatchObject({
        status: 'ok',
        mediaType: 'application/vnd.xpod.rdf-prepared-delta+json;version=1',
      });
    } finally {
      await client.close();
    }
  });

  it('lets the protocol fixture read a simple SELECT from the shared SQLite facts', async () => {
    const directory = createTestDir('qlever-fixture-select');
    const databasePath = path.join(directory, 'rdf-index.sqlite');
    const runtimeFixture = createFakeQleverRuntimeCommand();
    seedRuntimeDatabase(databasePath);
    const client = new LocalQleverNativeSparqlClient({
      command: runtimeFixture.command,
      args: [ '--sqlite-path', databasePath ],
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 10_000,
    });
    try {
      const result = await client.query(`
        PREFIX ex: <http://example.org/xpod-smoke#>
        SELECT ?label WHERE { ?subject ex:label ?label . }
      `, {
        basePath: 'https://pod.example/',
        operation: 'queryBindings',
        acceptMediaType: 'application/sparql-results+json',
      });

      expect(JSON.parse(result.body)).toMatchObject({
        head: { vars: [ 'label' ] },
        results: {
          bindings: [ {
            label: { type: 'literal', value: 'runtime sparql smoke' },
          } ],
        },
      });
    } finally {
      await client.close();
      runtimeFixture.cleanup();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('cancels timed out and aborted requests without killing the runtime', async () => {
    const client = createClient('normal', { requestTimeoutMs: 30 });
    try {
      await expect(client.query('SELECT * WHERE { # DELAY\n }', {
        basePath: 'https://pod.example/',
      })).rejects.toMatchObject({ code: 'qlever_request_timeout' });

      const controller = new AbortController();
      const request = client.query('SELECT * WHERE { # DELAY\n }', {
        basePath: 'https://pod.example/',
        timeoutMs: 1_000,
        signal: controller.signal,
      });
      controller.abort(new LocalQleverRuntimeError('qlever_request_aborted', 'test abort'));
      await expect(request).rejects.toMatchObject({ code: 'qlever_request_aborted' });

      await expect(client.query('ASK {}', {
        basePath: 'https://pod.example/',
        timeoutMs: 1_000,
      })).resolves.toMatchObject({ status: 'ok' });
    } finally {
      await client.close();
    }
  });

  it('fails closed on startup ABI mismatch and startup timeout', async () => {
    const mismatch = createClient('invalid-ready');
    await expect(mismatch.start()).rejects.toMatchObject({ code: 'qlever_runtime_protocol_error' });
    await mismatch.close();

    const hung = createClient('hang-startup', { startupTimeoutMs: 30 });
    await expect(hung.start()).rejects.toMatchObject({ code: 'qlever_runtime_unavailable' });
    await hung.close();
  });

  it('fails all pending work on malformed output or unexpected exit', async () => {
    const malformed = createClient();
    await expect(malformed.query('SELECT * WHERE { # MALFORMED\n }', {
      basePath: 'https://pod.example/',
    })).rejects.toMatchObject({ code: 'qlever_runtime_protocol_error' });
    await malformed.close();

    const exited = createClient();
    await expect(exited.query('SELECT * WHERE { # EXIT\n }', {
      basePath: 'https://pod.example/',
    })).rejects.toMatchObject({
      code: 'qlever_runtime_unavailable',
      message: expect.stringContaining('deliberate fake runtime exit'),
    });
    await exited.close();
  });

  it('does not restart after explicit close', async () => {
    const client = createClient();
    const result = await client.query('ASK {}', {
      basePath: 'https://pod.example/',
    });
    const pid = (result.profile as { pid: number }).pid;
    await client.close();
    expect(isProcessAlive(pid)).toBe(false);
    await expect(client.query('ASK {}', {
      basePath: 'https://pod.example/',
    })).rejects.toMatchObject({ code: 'qlever_runtime_closed' });
  });

  it('fails fast on invalid vector sideband options before starting the runtime', async () => {
    const client = createClient('hang-startup', { startupTimeoutMs: 30 });
    try {
      await expect(client.query('ASK {}', {
        basePath: 'https://pod.example/',
        vectorQuery: {
          embedding: [ Number.NaN ],
          metric: 'cosine',
          provider: 'cloudflare',
          model: '@cf/baai/bge-small-en-v1.5',
          modelVersion: '2026-08-12',
          inputKind: 'text',
          projectionPolicyVersion: 'rdf-entity-card-v1',
          limit: 7,
          retrievalPointVariable: '?retrieval',
        },
      })).rejects.toThrow('vectorQuery.embedding');
    } finally {
      await client.close();
    }
  });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
