/**
 * Real native runtime fresh-read check (acceptance).
 *
 * Boots the normal self-hosted local Xpod/Pod stack and binds ONLY the QLever
 * runtime command to the canonical packaged host-native runtime for THIS host.
 * That binding is an explicit test input, because both integration runners
 * otherwise inject a fake QLever command for every suite
 * (`createFakeQleverRuntimeCommand()` in run-integration-lite-local.ts and
 * run-integration-full.ts). A fake runtime can prove the HTTP path but never
 * SQLite/WAL freshness, so this case must name the real binary.
 *
 * The runtime must be the packaged artifact for the SAME OS as the SQLite
 * writer. A Linux container reading a Darwin-written SQLite file over a Docker
 * bind mount is NOT a valid boundary (the WAL is not coherent across that
 * mount), which is why the binding is a host-native command instead.
 *
 * Acceptance shape, in ONE live process with one native runtime process:
 *   create directory resource -> PATCH .meta -> read the facet
 *   -> PATCH the value -> read again
 *   -> DELETE the resource -> read again (empty)
 * with no restart, no checkpoint, no timed refresh, and no database
 * manipulation in between.
 *
 * Selection follows the existing integration idiom: skipped unless
 * `XPOD_RUN_INTEGRATION_TESTS=true`. Inside an integration run the real runtime
 * is REQUIRED, bound explicitly by the caller; a missing or unusable runtime
 * FAILS this suite. It never skips inside the gate, never falls back to the
 * fake runtime, and never weakens the assertion.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { XpodTestStack } from '../helpers/XpodTestStack';
import {
  resolveNativeQleverRuntimeBinding,
  type NativeQleverRuntimeCommand,
} from '../helpers/qleverRuntime';
import { loginWithClientCredentials, setupAccount, type AccountSetup, type ClientCredentialsSolidSession } from './helpers/solidAccount';

const run = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = run ? describe : describe.skip;
const FOAF_NAME = 'http://xmlns.com/foaf/0.1/name';
const SUCCESS = new Set([ 200, 201, 202, 204, 205, 207 ]);

function assertSuccess(response: Response, step: string): void {
  if (!SUCCESS.has(response.status)) {
    throw new Error(`${step} failed with ${response.status}`);
  }
}

suite('fresh metadata read on the packaged host-native runtime', () => {
  const stack = new XpodTestStack();
  let runtimeRoot: string | undefined;
  let native: NativeQleverRuntimeCommand | undefined;
  let account: AccountSetup;
  let session: ClientCredentialsSolidSession;
  let containerUrl: string;

  beforeAll(async () => {
    native = resolveNativeQleverRuntimeBinding();
    if (!existsSync(native.runtime)) {
      throw new Error(`Packaged QLever runtime is missing at ${native.runtime}`);
    }

    runtimeRoot = await mkdtemp(path.resolve('.test-data/explicit-metadata-native-'));
    await stack.start('local', {
      transport: 'port', open: false, apiOpen: false, logLevel: 'error', runtimeRoot,
      env: { XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: native.command },
    });
    const created = await setupAccount(stack.baseUrl, 'metadata-native');
    expect(created, 'account/Pod creation must succeed').not.toBeNull();
    account = created!;
    session = await loginWithClientCredentials(account);
    containerUrl = new URL(`agents/${randomUUID()}/`, account.podUrl).href;

    const create = await session.fetch(containerUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle',
        'If-None-Match': '*',
        Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      },
      body: '',
    });
    assertSuccess(create, 'create agent container');
    const patch = await session.fetch(`${containerUrl}.meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: `INSERT DATA { <${containerUrl}> <${FOAF_NAME}> "Fresh Native Agent" }`,
    });
    assertSuccess(patch, 'patch container metadata');
  }, 180_000);

  afterAll(async () => {
    await stack.stop();
    native?.cleanup();
    if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
  }, 60_000);

  const readFacet = async(step: string): Promise<string[]> => {
    const endpoint = new URL('agents/-/sparql', account.podUrl);
    endpoint.searchParams.set('query', `SELECT ?name WHERE { GRAPH <meta:${containerUrl}> { <${containerUrl}> <${FOAF_NAME}> ?name } }`);
    const response = await session.fetch(endpoint.href, { signal: AbortSignal.timeout(30_000) });
    expect(response.status, `${step}: ${await response.clone().text()}`).toBe(200);
    const json = await response.json() as { results: { bindings: Array<Record<string, { value: string }>> } };
    return json.results.bindings.map((row) => row.name?.value);
  };

  /** Exactly the processes this suite started; a restart per query would add lines. */
  const runtimeInvocations = (): number => {
    if (!native || !existsSync(native.ledger)) {
      return 0;
    }
    return readFileSync(native.ledger, 'utf8').split('\n').filter((line) => line.trim().length > 0).length;
  };

  // The counterexample that fails when the reader is stale: the very first read
  // after the write, in this same live process, must already be fresh.
  it('reads the just-written facet in the same live process', async () => {
    expect(await readFacet('after create+PATCH'), 'facet read immediately after PATCH').toEqual([ 'Fresh Native Agent' ]);
    expect(runtimeInvocations(), 'one native runtime process served the write and the read').toBe(1);
  }, 60_000);

  // Replacement must be visible too, not just the first insert.
  it('reads the replacement value after a second PATCH', async () => {
    const patch = await session.fetch(`${containerUrl}.meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: `DELETE { <${containerUrl}> <${FOAF_NAME}> ?n } `
        + `INSERT { <${containerUrl}> <${FOAF_NAME}> "Fresh Native Agent v2" } `
        + `WHERE { <${containerUrl}> <${FOAF_NAME}> ?n }`,
    });
    assertSuccess(patch, 'patch container metadata v2');
    expect(await readFacet('after update PATCH'), 'facet read immediately after replacement').toEqual([ 'Fresh Native Agent v2' ]);
    expect(runtimeInvocations(), 'the same native runtime process served the update').toBe(1);
  }, 60_000);

  // Deletion must be visible in the same process, closing the WAL/snapshot hole.
  it('reports absence after the resource is deleted', async () => {
    const response = await session.fetch(containerUrl, { method: 'DELETE' });
    assertSuccess(response, 'delete agent container');
    expect(await readFacet('after DELETE'), 'facet read immediately after delete').toEqual([]);
    expect(runtimeInvocations(), 'the same native runtime process served the delete').toBe(1);
  }, 60_000);
});
