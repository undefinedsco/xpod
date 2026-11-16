import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import {
  METADATA_GRAPH_PREFIX,
  applyRdfAccessScope,
  isMetadataGraphIri,
  metadataResourceForGraph,
  rdfAccessGraphAllowed,
  rdfReadGraphAllowed,
  rdfVar,
  type RdfAccessScope,
} from '../../../src/storage/rdf';

const { namedNode } = DataFactory;

const POD = 'https://pod.example/alice/';
const CONTAINER = `${POD}agents/key/`;
const META = `${METADATA_GRAPH_PREFIX}${CONTAINER}`;
const DATA = `${POD}agents/data.ttl`;
const SCOPE: RdfAccessScope = {
  basePath: POD,
  mode: 'read',
  principal: 'https://id.example/alice#me',
  version: 'acl-v1',
};

function patternQuery(graph: string) {
  return {
    patterns: [{
      graph: namedNode(graph),
      subject: rdfVar('subject'),
      predicate: rdfVar('predicate'),
      object: rdfVar('object'),
    }],
    select: [ 'subject', 'predicate', 'object' ],
  };
}

describe('metadata facet graph identity', () => {
  it('recognizes exactly one meta: level', () => {
    expect(isMetadataGraphIri(META)).toBe(true);
    expect(metadataResourceForGraph(META)).toBe(CONTAINER);
    expect(isMetadataGraphIri(`${METADATA_GRAPH_PREFIX}${META}`)).toBe(false);
    expect(isMetadataGraphIri(DATA)).toBe(false);
  });

  it('keeps the write predicate literal and metadata-agnostic', () => {
    expect(rdfAccessGraphAllowed(META, SCOPE)).toBe(false);
    expect(rdfAccessGraphAllowed(DATA, SCOPE)).toBe(true);
  });

  it('allows a metadata facet only inside an explicit metadata-namespace scope', () => {
    const metaScope: RdfAccessScope = { ...SCOPE, basePath: `${METADATA_GRAPH_PREFIX}${POD}` };
    expect(rdfReadGraphAllowed(META, metaScope)).toBe(true);
    expect(rdfReadGraphAllowed(`${METADATA_GRAPH_PREFIX}${POD}other/doc.ttl`, metaScope)).toBe(true);
    // An ordinary data-base scope must NOT admit the alias: ASK/CONSTRUCT/subquery
    // paths never perform the per-subject authorization (P1 review finding).
    expect(rdfReadGraphAllowed(META, SCOPE)).toBe(false);
    expect(rdfReadGraphAllowed(`${METADATA_GRAPH_PREFIX}${POD}other/doc.ttl`, SCOPE)).toBe(false);
  });

  it('rejects metadata facets outside the endpoint base and nested aliases', () => {
    const metaScope: RdfAccessScope = { ...SCOPE, basePath: `${METADATA_GRAPH_PREFIX}${POD}` };
    expect(rdfReadGraphAllowed(`${METADATA_GRAPH_PREFIX}https://other.example/x/`, metaScope)).toBe(false);
    expect(rdfReadGraphAllowed(`${METADATA_GRAPH_PREFIX}${METADATA_GRAPH_PREFIX}${CONTAINER}`, metaScope)).toBe(false);
  });

  it('lets a subject deny cover its metadata facet', () => {
    const denied = { ...SCOPE, deniedGraphUrls: [CONTAINER] };
    expect(rdfReadGraphAllowed(META, denied)).toBe(false);
    const named = { ...SCOPE, deniedGraphUrls: [META] };
    expect(rdfReadGraphAllowed(META, named)).toBe(false);
  });

  it('honors both canonical alias denial forms (Root probe)', () => {
    // Scope over meta:<base> denying the plain resource IRI.
    const metaScope: RdfAccessScope = {
      basePath: `${METADATA_GRAPH_PREFIX}${POD}agents/`,
      mode: 'read',
      deniedGraphUrls: [CONTAINER],
    };
    expect(rdfReadGraphAllowed(META, metaScope)).toBe(false);
    // Scope over the data base denying the meta alias.
    const dataScope: RdfAccessScope = {
      basePath: `${POD}agents/`,
      mode: 'read',
      deniedGraphUrls: [META],
    };
    expect(rdfReadGraphAllowed(CONTAINER, dataScope)).toBe(false);
    // The write predicate stays literal: neither denial form widens writes.
    expect(rdfAccessGraphAllowed(META, SCOPE)).toBe(false);
  });

  it('lets a prefix denial on the subject cover the facet', () => {
    const denied = { ...SCOPE, deniedGraphPrefixes: [`${POD}agents/key/`] };
    expect(rdfReadGraphAllowed(META, denied)).toBe(false);
  });

  it('treats an explicit container-shaped metadata graph as exact inside a metadata scope', () => {
    // The facet IRI ends in `/` because its subject is a container; it must not
    // become a prefix that also reaches children.
    expect(META.endsWith('/')).toBe(true);
    const metaScope: RdfAccessScope = { ...SCOPE, basePath: `${METADATA_GRAPH_PREFIX}${POD}` };
    const scoped = applyRdfAccessScope(patternQuery(META), metaScope);
    expect(scoped.patterns?.[0].graph).toEqual(namedNode(META));
    expect(scoped.patterns?.[0].graph).not.toEqual({ $startsWith: META });
  });

  it('keeps an explicit metadata graph impossible in an ordinary data-base scope', () => {
    // Ordinary queries must never see facets, so no rewrite may leave them readable.
    const scoped = applyRdfAccessScope(patternQuery(META), SCOPE);
    expect(scoped.patterns?.[0].graph).toEqual({ $in: [] });
  });

  it('still treats an ordinary container data graph as a prefix', () => {
    const scoped = applyRdfAccessScope(patternQuery(CONTAINER), SCOPE);
    expect(scoped.patterns?.[0].graph).toEqual({ $startsWith: CONTAINER });
  });

  it('rewrites an out-of-base metadata facet to an impossible pattern', () => {
    const scoped = applyRdfAccessScope(
      patternQuery(`${METADATA_GRAPH_PREFIX}https://other.example/x/`),
      SCOPE,
    );
    expect(scoped.patterns?.[0].graph).toEqual({ $in: [] });
  });

  it('amortizes no privilege: an ordinary scope cannot enumerate facets', () => {
    // listGraphs uses the data base; a facet must never appear even when its
    // subject resource is fully readable (P1 finding: ASK/CONSTRUCT could see it).
    const scoped = applyRdfAccessScope(patternQuery(META), {
      ...SCOPE,
      allowedGraphUrls: [ META ],
      deniedGraphUrls: [],
    });
    expect(scoped.patterns?.[0].graph).toEqual({ $in: [] });
    expect(rdfReadGraphAllowed(META, { ...SCOPE, allowedGraphUrls: [ META ] })).toBe(false);
  });

  it('supports the metadata-namespace read base used by the handler', () => {
    const metaScope: RdfAccessScope = {
      basePath: `${METADATA_GRAPH_PREFIX}${POD}`,
      mode: 'read',
    };
    expect(rdfReadGraphAllowed(META, metaScope)).toBe(true);
    expect(rdfReadGraphAllowed(DATA, metaScope)).toBe(false);
  });
});
