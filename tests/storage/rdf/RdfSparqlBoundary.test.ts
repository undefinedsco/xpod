import { describe, expect, it } from 'vitest';
import {
  DisabledSparqlFeatureError,
  UnsupportedSparqlQueryError,
  assertServerOwnedNativeSparqlQuery,
  sparqlCorrectionForCapability,
} from '../../../src/storage/rdf';

const BASE = 'https://pod.example/alice/';

describe('native SPARQL boundary', () => {
  it('passes server-owned query shapes to QLever without compiling them in TypeScript', () => {
    expect(assertServerOwnedNativeSparqlQuery(`
      SELECT ?message WHERE {
        { SELECT ?message WHERE { ?message a <urn:Message> } }
        OPTIONAL { ?message <urn:content> ?content }
      }
      ORDER BY ?message
      LIMIT 10
    `, BASE)).toBe(false);
  });

  it('allows QLever extension SERVICE endpoints and identifies their use', () => {
    expect(assertServerOwnedNativeSparqlQuery(`
      SELECT * WHERE {
        SERVICE <https://qlever.cs.uni-freiburg.de/textSearch/> {
          ?text <https://qlever.cs.uni-freiburg.de/builtin-functions/contains-word> "pod"
        }
      }
    `, BASE)).toBe(true);
  });

  it('rejects external SERVICE federation', () => {
    expect(() => assertServerOwnedNativeSparqlQuery(`
      SELECT * WHERE { SERVICE <https://remote.example/sparql> { ?s ?p ?o } }
    `, BASE)).toThrow(DisabledSparqlFeatureError);
  });

  it('validates every SERVICE clause after a QLever extension SERVICE', () => {
    expect(() => assertServerOwnedNativeSparqlQuery(`
      SELECT * WHERE {
        SERVICE <https://qlever.cs.uni-freiburg.de/textSearch/> {
          ?text <https://qlever.cs.uni-freiburg.de/builtin-functions/contains-word> "pod"
        }
        SERVICE <https://remote.example/sparql> { ?s ?p ?o }
      }
    `, BASE)).toThrow(DisabledSparqlFeatureError);
  });

  it('rejects FROM and FROM NAMED graphs outside the Pod scope', () => {
    expect(() => assertServerOwnedNativeSparqlQuery(`
      SELECT * FROM <https://remote.example/data.ttl> WHERE { ?s ?p ?o }
    `, BASE)).toThrow(/outside the server-owned Pod scope/);
    expect(() => assertServerOwnedNativeSparqlQuery(`
      SELECT * FROM NAMED <https://remote.example/data.ttl> WHERE { GRAPH ?g { ?s ?p ?o } }
    `, BASE)).toThrow(/outside the server-owned Pod scope/);
  });

  it('returns structured correction data for unsupported capabilities', () => {
    const error = new UnsupportedSparqlQueryError(
      'Native QLever prepared-update support is required',
      { capability: 'sparql.update.authority' },
    );
    expect(error).toMatchObject({
      code: 'rdf.sparql.unsupported_query_shape',
      capability: 'sparql.update.authority',
      correction: {
        primaryAction: 'use_write_api',
        target: 'pod_write_api',
      },
    });
    expect(sparqlCorrectionForCapability('sparql.federation.service')).toMatchObject({
      primaryAction: 'route_external_executor',
      target: 'trusted_client_or_federated_engine',
    });
  });
});
