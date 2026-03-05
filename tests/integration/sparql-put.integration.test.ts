import { describe, it, expect } from 'vitest';
import { setupAccount } from './helpers/solidAccount';

const RUN = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = RUN ? describe : describe.skip;

suite('SPARQL PUT compatibility', () => {
  it('SPARQL endpoint can query PUT-written turtle data', async () => {
    const BASE = (process.env.CSS_BASE_URL || 'http://localhost:5739').replace(/\/$/, '');
    const account = await setupAccount(BASE, 'sparqltest');
    expect(account).not.toBeNull();
    const { podUrl, clientId, clientSecret, issuer } = account!;

    const tokenRes = await fetch(`${issuer.replace(/\/$/, '')}/.oidc/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'webid' }),
    });
    const { access_token: token } = await tokenRes.json();
    expect(token).toBeTruthy();

    // Create containers
    for (const path of ['.data/', '.data/chat/', '.data/chat/default/', '.data/chat/default/2026/', '.data/chat/default/2026/03/', '.data/chat/default/2026/03/03/']) {
      await fetch(`${podUrl}${path}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/turtle', 'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' },
        body: '',
      });
    }

    // PUT turtle file
    const msgUrl = `${podUrl}.data/chat/default/2026/03/03/messages.ttl`;
    const turtle = `@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix meeting: <http://www.w3.org/ns/pim/meeting#> .
@prefix udfs: <https://undefineds.co/ns#> .
@prefix sioc: <http://rdfs.org/sioc/ns#> .

<#msg-1> a meeting:Message ;
  udfs:threadId "thread-test-1" ;
  sioc:content "Hello world" .
`;
    const putRes = await fetch(msgUrl, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/turtle' },
      body: turtle,
    });
    console.log('PUT status:', putRes.status);
    expect([200, 201, 204]).toContain(putRes.status);

    const sparqlUrl = `${podUrl}.data/chat/-/sparql`;

    // Test 1: GRAPH ?g pattern
    const q1 = `SELECT ?s ?t WHERE { GRAPH ?g { ?s a <http://www.w3.org/ns/pim/meeting#Message> . OPTIONAL { ?s <https://undefineds.co/ns#threadId> ?t } } }`;
    const r1 = await fetch(sparqlUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/sparql-query', 'Accept': 'application/sparql-results+json' },
      body: q1,
    });
    const d1 = await r1.json();
    console.log('GRAPH ?g results:', d1.results?.bindings?.length ?? 0, 'rows');
    console.log('GRAPH ?g bindings:', JSON.stringify(d1.results?.bindings));

    // Test 2: no GRAPH pattern
    const q2 = `SELECT ?s ?t WHERE { ?s a <http://www.w3.org/ns/pim/meeting#Message> . OPTIONAL { ?s <https://undefineds.co/ns#threadId> ?t } }`;
    const r2 = await fetch(sparqlUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/sparql-query', 'Accept': 'application/sparql-results+json' },
      body: q2,
    });
    const d2 = await r2.json();
    console.log('No GRAPH results:', d2.results?.bindings?.length ?? 0, 'rows');
    console.log('No GRAPH bindings:', JSON.stringify(d2.results?.bindings));

    // At least one pattern should find the data
    const total = (d1.results?.bindings?.length ?? 0) + (d2.results?.bindings?.length ?? 0);
    expect(total).toBeGreaterThan(0);
  }, 30000);
});
