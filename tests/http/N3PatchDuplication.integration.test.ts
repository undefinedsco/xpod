/**
 * N3 PATCH String Literal Duplication Bug Test
 *
 * Bug Report: When N3 PATCH inserts contain 4+ triples, string literals get duplicated.
 * Only string/typed literals are affected, not integers or URIs.
 *
 * This test reproduces the bug to determine if it's caused by:
 * 1. xpod's SQLUp batch merging logic
 * 2. CSS upstream issue
 *
 * Run:
 *   XPOD_RUN_INTEGRATION_TESTS=true yarn test tests/http/N3PatchDuplication.integration.test.ts --run
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Session } from '@inrupt/solid-client-authn-node';
import { config as loadEnv } from 'dotenv';
import { resolveSolidIntegrationConfig } from './utils/integrationEnv';
import { resolvePodBase } from './utils/pod';

loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.local' });

const { webId, oidcIssuer } = resolveSolidIntegrationConfig();
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const tokenType = process.env.SOLID_TOKEN_TYPE === 'Bearer' ? 'Bearer' : 'DPoP';
const shouldRun = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true' && clientId && clientSecret && oidcIssuer && webId;
const suite = shouldRun ? describe : describe.skip;

const SUCCESS = new Set([200, 201, 202, 204, 205, 207]);

async function assertSuccess(response: Response, step: string): Promise<void> {
  if (!SUCCESS.has(response.status)) {
    const text = await response.clone().text();
    throw new Error(`${step} failed with status ${response.status}: ${text}`);
  }
}

suite('N3 PATCH String Literal Duplication Bug', () => {
  let podBase: string;
  let containerUrl: string;
  let session: Session;
  let doFetch: typeof fetch;

  async function getTriples(resourceUrl: string): Promise<string[]> {
    const res = await doFetch(resourceUrl, {
      method: 'GET',
      headers: { accept: 'text/turtle' },
    });
    await assertSuccess(res, 'get resource');
    const body = await res.text();
    return body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('@prefix') && !line.startsWith('#'));
  }

  async function countOccurrences(resourceUrl: string, pattern: string): Promise<number> {
    const res = await doFetch(resourceUrl, {
      method: 'GET',
      headers: { accept: 'text/turtle' },
    });
    await assertSuccess(res, 'get resource');
    const body = await res.text();
    const regex = new RegExp(pattern, 'g');
    const matches = body.match(regex);
    const count = matches ? matches.length : 0;
    console.log(`[DEBUG] Count '${pattern}': ${count}`);
    return count;
  }

  beforeAll(async () => {
    session = new Session();
    session = new Session();
    await session.login({
      clientId: clientId!,
      clientSecret: clientSecret!,
      oidcIssuer,
      tokenType,
    });
    doFetch = session.fetch.bind(session);

    podBase = await resolvePodBase(doFetch, webId!, assertSuccess, oidcIssuer);
    containerUrl = new URL('n3-patch-test/', podBase).toString();

    // Ensure container exists
    const headContainer = await doFetch(containerUrl, { method: 'HEAD' });
    if (headContainer.status === 404) {
      const createContainer = await doFetch(containerUrl, {
        method: 'PUT',
        headers: {
          'content-type': 'text/turtle',
          'link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
        },
        body: '',
      });
      await assertSuccess(createContainer, 'create container');
    }
  });

  afterAll(async () => {
    await doFetch?.(containerUrl, { method: 'DELETE' }).catch(() => undefined);
    if (session?.info.isLoggedIn) {
      await session.logout().catch(() => undefined);
    }
  });

  it('N3 PATCH with 4+ string literal triples should NOT duplicate values', async () => {
    const resourceUrl = new URL('bug-test-4triples.ttl', containerUrl).toString();

    // Create empty resource first
    const createRes = await doFetch(resourceUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle' },
      body: '',
    });
    await assertSuccess(createRes, 'create resource');

    // N3 PATCH with 4 triples containing string literals (bug trigger condition)
    const n3Patch = `
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix schema: <https://schema.org/> .
@prefix ex: <http://example.org/> .

<> a solid:InsertDeletePatch ;
   solid:inserts {
     <${resourceUrl}> schema:name "Test Name" .
     <${resourceUrl}> schema:description "Test Description" .
     <${resourceUrl}> ex:field1 "Value 1" .
     <${resourceUrl}> ex:field2 "Value 2" .
   } .
`.trim();

    const patchRes = await doFetch(resourceUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'text/n3' },
      body: n3Patch,
    });
    await assertSuccess(patchRes, 'n3 patch');

    // Check for duplicates
    const nameCount = await countOccurrences(resourceUrl, '"Test Name"');
    const descCount = await countOccurrences(resourceUrl, '"Test Description"');
    const field1Count = await countOccurrences(resourceUrl, '"Value 1"');
    const field2Count = await countOccurrences(resourceUrl, '"Value 2"');

    console.log(`Occurrence counts: name=${nameCount}, desc=${descCount}, field1=${field1Count}, field2=${field2Count}`);

    // Each value should appear exactly once
    expect(nameCount).toBe(1);
    expect(descCount).toBe(1);
    expect(field1Count).toBe(1);
    expect(field2Count).toBe(1);

    // Cleanup
    await doFetch(resourceUrl, { method: 'DELETE' }).catch(() => undefined);
  });

  it('N3 PATCH with 5 string literal triples should NOT duplicate values', async () => {
    const resourceUrl = new URL('bug-test-5triples.ttl', containerUrl).toString();

    // Create empty resource first
    const createRes = await doFetch(resourceUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle' },
      body: '',
    });
    await assertSuccess(createRes, 'create resource');

    // N3 PATCH with 5 triples
    const n3Patch = `
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix schema: <https://schema.org/> .
@prefix ex: <http://example.org/> .

<> a solid:InsertDeletePatch ;
   solid:inserts {
     <${resourceUrl}> schema:name "Name Five" .
     <${resourceUrl}> schema:description "Desc Five" .
     <${resourceUrl}> ex:a "A Value" .
     <${resourceUrl}> ex:b "B Value" .
     <${resourceUrl}> ex:c "C Value" .
   } .
`.trim();

    const patchRes = await doFetch(resourceUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'text/n3' },
      body: n3Patch,
    });
    await assertSuccess(patchRes, 'n3 patch');

    // Check for duplicates
    const triples = await getTriples(resourceUrl);
    console.log('Retrieved triples:', triples);

    const nameCount = await countOccurrences(resourceUrl, '"Name Five"');
    const descCount = await countOccurrences(resourceUrl, '"Desc Five"');

    console.log(`5-triple test: name=${nameCount}, desc=${descCount}`);

    expect(nameCount).toBe(1);
    expect(descCount).toBe(1);

    // Cleanup
    await doFetch(resourceUrl, { method: 'DELETE' }).catch(() => undefined);
  });

  it('N3 PATCH with 3 triples should work correctly (control test)', async () => {
    const resourceUrl = new URL('bug-test-3triples.ttl', containerUrl).toString();

    // Create empty resource first
    const createRes = await doFetch(resourceUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle' },
      body: '',
    });
    await assertSuccess(createRes, 'create resource');

    // N3 PATCH with only 3 triples (should work per bug report)
    const n3Patch = `
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix schema: <https://schema.org/> .

<> a solid:InsertDeletePatch ;
   solid:inserts {
     <${resourceUrl}> schema:name "Control Name" .
     <${resourceUrl}> schema:description "Control Desc" .
     <${resourceUrl}> schema:url <https://example.org/> .
   } .
`.trim();

    const patchRes = await doFetch(resourceUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'text/n3' },
      body: n3Patch,
    });
    await assertSuccess(patchRes, 'n3 patch');

    const nameCount = await countOccurrences(resourceUrl, '"Control Name"');
    const descCount = await countOccurrences(resourceUrl, '"Control Desc"');

    console.log(`3-triple control test: name=${nameCount}, desc=${descCount}`);

    expect(nameCount).toBe(1);
    expect(descCount).toBe(1);

    // Cleanup
    await doFetch(resourceUrl, { method: 'DELETE' }).catch(() => undefined);
  });

  it('PUT with 4+ triples should NOT duplicate (control test)', async () => {
    const resourceUrl = new URL('bug-test-put.ttl', containerUrl).toString();

    // PUT with 4 triples - should work per bug report (PUT unaffected)
    const turtle = `
@prefix schema: <https://schema.org/> .
@prefix ex: <http://example.org/> .

<${resourceUrl}> schema:name "PUT Name" ;
                 schema:description "PUT Description" ;
                 ex:field1 "PUT Value 1" ;
                 ex:field2 "PUT Value 2" .
`.trim();

    const putRes = await doFetch(resourceUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle' },
      body: turtle,
    });
    await assertSuccess(putRes, 'put resource');

    const nameCount = await countOccurrences(resourceUrl, '"PUT Name"');
    const descCount = await countOccurrences(resourceUrl, '"PUT Description"');

    console.log(`PUT control test: name=${nameCount}, desc=${descCount}`);

    expect(nameCount).toBe(1);
    expect(descCount).toBe(1);

    // Cleanup
    await doFetch(resourceUrl, { method: 'DELETE' }).catch(() => undefined);
  });

  it('N3 PATCH with integer values should NOT duplicate (control test)', async () => {
    const resourceUrl = new URL('bug-test-integers.ttl', containerUrl).toString();

    // Create empty resource first
    const createRes = await doFetch(resourceUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle' },
      body: '',
    });
    await assertSuccess(createRes, 'create resource');

    // N3 PATCH with integers (should work per bug report - integers unaffected)
    const n3Patch = `
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<> a solid:InsertDeletePatch ;
   solid:inserts {
     <${resourceUrl}> ex:count1 1 .
     <${resourceUrl}> ex:count2 2 .
     <${resourceUrl}> ex:count3 3 .
     <${resourceUrl}> ex:count4 4 .
   } .
`.trim();

    const patchRes = await doFetch(resourceUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'text/n3' },
      body: n3Patch,
    });
    await assertSuccess(patchRes, 'n3 patch');

    // Check that integers are not duplicated
    const body = await (await doFetch(resourceUrl, { headers: { accept: 'text/turtle' } })).text();
    console.log('Integer test body:', body);

    // Count occurrences of the integer values
    const count1Matches = (body.match(/(?:ex:|http:\/\/example\.org\/)count1>?\s+1/g) || []).length;
    const count4Matches = (body.match(/(?:ex:|http:\/\/example\.org\/)count4>?\s+4/g) || []).length;

    console.log(`Integer test: count1=${count1Matches}, count4=${count4Matches}`);

    expect(count1Matches).toBe(1);
    expect(count4Matches).toBe(1);

    // Cleanup
    await doFetch(resourceUrl, { method: 'DELETE' }).catch(() => undefined);
  });

  it('Multiple sequential N3 PATCH operations should NOT cause duplicates', async () => {
    const resourceUrl = new URL('bug-test-sequential.ttl', containerUrl).toString();

    // Create resource with initial data
    const createRes = await doFetch(resourceUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle' },
      body: `@prefix schema: <https://schema.org/> . <${resourceUrl}> schema:name "Initial" .`,
    });
    await assertSuccess(createRes, 'create resource');

    // First patch - add 4 triples
    const patch1 = `
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .

<> a solid:InsertDeletePatch ;
   solid:inserts {
     <${resourceUrl}> ex:seq1 "Seq 1" .
     <${resourceUrl}> ex:seq2 "Seq 2" .
     <${resourceUrl}> ex:seq3 "Seq 3" .
     <${resourceUrl}> ex:seq4 "Seq 4" .
   } .
`.trim();

    const patch1Res = await doFetch(resourceUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'text/n3' },
      body: patch1,
    });
    await assertSuccess(patch1Res, 'first patch');

    // Second patch - add more triples
    const patch2 = `
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .

<> a solid:InsertDeletePatch ;
   solid:inserts {
     <${resourceUrl}> ex:seq5 "Seq 5" .
     <${resourceUrl}> ex:seq6 "Seq 6" .
     <${resourceUrl}> ex:seq7 "Seq 7" .
     <${resourceUrl}> ex:seq8 "Seq 8" .
   } .
`.trim();

    const patch2Res = await doFetch(resourceUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'text/n3' },
      body: patch2,
    });
    await assertSuccess(patch2Res, 'second patch');

    // Check for duplicates
    const triples = await getTriples(resourceUrl);
    console.log('Sequential patch triples:', triples);

    const seq1Count = await countOccurrences(resourceUrl, '"Seq 1"');
    const seq4Count = await countOccurrences(resourceUrl, '"Seq 4"');
    const seq5Count = await countOccurrences(resourceUrl, '"Seq 5"');
    const seq8Count = await countOccurrences(resourceUrl, '"Seq 8"');

    console.log(`Sequential test: seq1=${seq1Count}, seq4=${seq4Count}, seq5=${seq5Count}, seq8=${seq8Count}`);

    expect(seq1Count).toBe(1);
    expect(seq4Count).toBe(1);
    expect(seq5Count).toBe(1);
    expect(seq8Count).toBe(1);

    // Cleanup
    await doFetch(resourceUrl, { method: 'DELETE' }).catch(() => undefined);
  });
});
