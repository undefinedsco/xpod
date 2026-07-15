import type { Quad } from '@rdfjs/types';
import { DataFactory } from 'n3';
import { RdfAccessMode, type RdfAccessScope } from './RdfAccessScope';
import {
  RDF_MODELS_SYNTHETIC_THREAD_COUNT,
  rdfModelsSyntheticPodIri,
} from './models-benchmark';

export type CloudReplacementEngineId = 'rdf3x' | 'qlever';
export type CloudReplacementWorkloadGroup = 'short' | 'large' | 'authorization';

export interface CloudReplacementWorkload {
  id: string;
  group: CloudReplacementWorkloadGroup;
  purpose: string;
  sparql: string;
  sharedSurface: true;
  orderSensitive: boolean;
  concurrencyRepresentative: boolean;
  expectedRows?: number;
  minRows?: number;
  accessScope?: RdfAccessScope;
}

export const CLOUD_REPLACEMENT_GROUP_WEIGHTS = Object.freeze({
  short: 0.60,
  large: 0.30,
  authorization: 0.10,
});

const SPARQL_PREFIXES = [
  'PREFIX sioc: <http://rdfs.org/sioc/ns#>',
  'PREFIX dct: <http://purl.org/dc/terms/>',
  'PREFIX udfs: <https://undefineds.co/ns#>',
  'PREFIX meeting: <http://www.w3.org/ns/pim/meeting#>',
  'PREFIX ai: <https://vocab.xpod.dev/ai#>',
].join('\n');

const QUERY_BODIES = {
  'point-lookup': 'SELECT ?content WHERE { GRAPH ?g { <https://pod.example/alice/.data/chat/default/2026/05/01/messages.ttl#synthetic_0> sioc:content ?content } }',
  'subject-star': 'SELECT ?p ?o WHERE { GRAPH ?g { <https://pod.example/alice/.data/chat/default/2026/05/01/messages.ttl#synthetic_0> ?p ?o } }',
  'latest-message': 'SELECT ?message ?created WHERE { GRAPH ?g { ?message sioc:has_member <https://pod.example/alice/.data/chat/default/index.ttl#thread_1>; dct:created ?created } } ORDER BY DESC(?created) LIMIT 1',
  'keyset-page': 'SELECT ?message ?rank WHERE { GRAPH ?g { ?message udfs:rank ?rank . FILTER(?rank > 100) } } ORDER BY ?rank LIMIT 50',
  'exact-graph': 'SELECT ?message WHERE { GRAPH <https://pod.example/alice/.data/chat/default/2026/05/01/messages.ttl> { ?message a meeting:Message } }',
  'selective-po': 'SELECT ?message WHERE { GRAPH ?g { ?message udfs:score 97; udfs:status "indexed" } }',
  'two-hop-chain': 'SELECT ?message ?chat WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread } GRAPH ?g2 { ?thread sioc:has_parent ?chat } }',
  'four-hop-chain': 'SELECT ?message ?owner WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread } GRAPH ?g2 { ?thread sioc:has_parent ?chat } GRAPH ?g3 { ?chat udfs:workspace ?workspace } GRAPH ?g4 { ?workspace udfs:owner ?owner } }',
  'eight-hop-chain': 'SELECT ?message ?category WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread } GRAPH ?g2 { ?thread sioc:has_parent ?chat } GRAPH ?g3 { ?chat udfs:workspace ?workspace } GRAPH ?g4 { ?workspace udfs:owner ?owner } GRAPH ?g5 { ?owner udfs:provider ?provider } GRAPH ?g6 { ?provider ai:hasModel ?model } GRAPH ?g7 { ?model udfs:capability ?capability } GRAPH ?g8 { ?capability udfs:category ?category } }',
  'message-star': 'SELECT ?message ?thread ?created ?score ?workspace WHERE { GRAPH ?g { ?message sioc:has_member ?thread; dct:created ?created; udfs:score ?score; udfs:workspace ?workspace; udfs:status "indexed" } }',
  'message-snowflake': 'SELECT ?message ?threadCreated ?score WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread; udfs:score ?score } GRAPH ?g2 { ?thread dct:created ?threadCreated; udfs:workspace ?workspace } }',
  'bounded-many-to-many': 'SELECT ?left ?right WHERE { GRAPH ?g1 { ?left sioc:has_member ?thread; udfs:rank ?leftRank } GRAPH ?g2 { ?right sioc:has_member ?thread; udfs:rank ?rightRank } FILTER(?leftRank < 20 && ?rightRank < 20 && ?left != ?right) }',
  'low-selectivity-filter': 'SELECT ?message WHERE { GRAPH ?g { ?message udfs:score ?score . FILTER(?score > 0) } }',
  'medium-selectivity-filter': 'SELECT ?message WHERE { GRAPH ?g { ?message udfs:score ?score . FILTER(?score > 50) } }',
  'high-selectivity-filter': 'SELECT ?message WHERE { GRAPH ?g { ?message udfs:score 97 } }',
  'count-distinct-threads': 'SELECT (COUNT(DISTINCT ?thread) AS ?count) WHERE { GRAPH ?g { ?message sioc:has_member ?thread } }',
  'ordered-top-k': 'SELECT ?message ?score WHERE { GRAPH ?g { ?message udfs:score ?score } } ORDER BY DESC(?score) ?message LIMIT 100',
  'optional-content': 'SELECT ?message ?content WHERE { GRAPH ?g { ?message a meeting:Message . OPTIONAL { ?message sioc:content ?content } } }',
  'union-status-score': 'SELECT DISTINCT ?message WHERE { { GRAPH ?g { ?message udfs:status "indexed" } } UNION { GRAPH ?g { ?message udfs:score 100 } } }',
  'top-thread-aggregate': 'SELECT ?thread (COUNT(?message) AS ?count) WHERE { GRAPH ?g { ?message sioc:has_member ?thread } } GROUP BY ?thread ORDER BY DESC(?count) ?thread LIMIT 20',
} as const;

function query(body: string): string {
  return `${SPARQL_PREFIXES}\n${body}`;
}

function benchmarkQuad(subject: string, predicate: string, object: string, graph: string): Quad {
  return DataFactory.quad(
    DataFactory.namedNode(subject),
    DataFactory.namedNode(predicate),
    DataFactory.namedNode(object),
    DataFactory.namedNode(graph),
  );
}

export function buildCloudReplacementTopology(podCount: number): Quad[] {
  const quads: Quad[] = [];
  for (let podIndex = 0; podIndex < Math.max(1, Math.floor(podCount)); podIndex += 1) {
    const pod = rdfModelsSyntheticPodIri(podIndex);
    const data = `${pod}/.data`;
    const graph = `${data}/chat/default/index.ttl`;
    const chat = `${graph}#this`;
    const workspaceGraph = `${data}/workspaces/default/index.ttl`;
    const workspace = `${workspaceGraph}#this`;
    const owner = `${pod}/profile/card#me`;
    const provider = `${pod}/settings/providers/benchmark.ttl`;
    const model = `${provider}#benchmark-model`;
    const capability = `${provider}#capability-agent`;
    const category = 'urn:xpod-benchmark:category:agent';

    for (let threadIndex = 0; threadIndex < RDF_MODELS_SYNTHETIC_THREAD_COUNT; threadIndex += 1) {
      quads.push(DataFactory.quad(
        DataFactory.namedNode(`${graph}#thread_${threadIndex + 1}`),
        DataFactory.namedNode('http://rdfs.org/sioc/ns#has_parent'),
        DataFactory.namedNode(chat),
        DataFactory.namedNode(graph),
      ));
    }
    quads.push(
      benchmarkQuad(chat, 'https://undefineds.co/ns#workspace', workspace, graph),
      benchmarkQuad(workspace, 'https://undefineds.co/ns#owner', owner, workspaceGraph),
      benchmarkQuad(owner, 'https://undefineds.co/ns#provider', provider, provider),
      benchmarkQuad(provider, 'https://vocab.xpod.dev/ai#hasModel', model, provider),
      benchmarkQuad(model, 'https://undefineds.co/ns#capability', capability, provider),
      benchmarkQuad(capability, 'https://undefineds.co/ns#category', category, provider),
    );
  }
  return quads;
}

export function cloudReplacementWorkloads(): CloudReplacementWorkload[] {
  const aliceChatPrefix = 'https://pod.example/alice/.data/chat/';
  const aliceChatIndex = `${aliceChatPrefix}default/index.ttl`;
  const dayOne = `${aliceChatPrefix}default/2026/05/01/messages.ttl`;
  const deniedDay = `${aliceChatPrefix}default/2026/05/05/messages.ttl`;
  const authorizationScopes: RdfAccessScope[] = [
    {
      basePath: aliceChatPrefix,
      mode: RdfAccessMode.READ,
      principal: 'urn:xpod-benchmark:alice',
      version: 'inherited-prefix',
    },
    {
      basePath: aliceChatPrefix,
      mode: RdfAccessMode.READ,
      principal: 'urn:xpod-benchmark:alice',
      allowedGraphUrls: [ dayOne, aliceChatIndex ],
      version: 'explicit-allow',
    },
    {
      basePath: aliceChatPrefix,
      mode: RdfAccessMode.READ,
      principal: 'urn:xpod-benchmark:alice',
      deniedGraphUrls: [ deniedDay ],
      version: 'explicit-deny',
    },
    {
      basePath: aliceChatPrefix,
      mode: RdfAccessMode.READ,
      principal: 'urn:xpod-benchmark:alice',
      deniedGraphPrefixes: [ `${aliceChatPrefix}default/2026/05/05/` ],
      version: 'scoped-broad-join',
    },
  ];

  return [
    {
      id: 'point-lookup',
      group: 'short',
      purpose: 'Measure a selective message property lookup.',
      sparql: query(QUERY_BODIES['point-lookup']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: true,
      expectedRows: 1,
    },
    {
      id: 'subject-star',
      group: 'short',
      purpose: 'Measure full property expansion for one message.',
      sparql: query(QUERY_BODIES['subject-star']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      expectedRows: 9,
    },
    {
      id: 'latest-message',
      group: 'short',
      purpose: 'Measure latest-message retrieval for one thread.',
      sparql: query(QUERY_BODIES['latest-message']),
      sharedSurface: true,
      orderSensitive: true,
      concurrencyRepresentative: true,
      expectedRows: 1,
    },
    {
      id: 'keyset-page',
      group: 'short',
      purpose: 'Measure an ordered keyset page over message ranks.',
      sparql: query(QUERY_BODIES['keyset-page']),
      sharedSurface: true,
      orderSensitive: true,
      concurrencyRepresentative: false,
      expectedRows: 50,
    },
    {
      id: 'exact-graph',
      group: 'short',
      purpose: 'Measure message lookup within one exact graph.',
      sparql: query(QUERY_BODIES['exact-graph']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'selective-po',
      group: 'short',
      purpose: 'Measure a selective predicate-object conjunction.',
      sparql: query(QUERY_BODIES['selective-po']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'two-hop-chain',
      group: 'large',
      purpose: 'Measure the message-to-thread-to-chat relationship chain.',
      sparql: query(QUERY_BODIES['two-hop-chain']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'four-hop-chain',
      group: 'large',
      purpose: 'Measure the message-to-owner relationship chain.',
      sparql: query(QUERY_BODIES['four-hop-chain']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: true,
      minRows: 1,
    },
    {
      id: 'eight-hop-chain',
      group: 'large',
      purpose: 'Measure the full message-to-capability-category chain.',
      sparql: query(QUERY_BODIES['eight-hop-chain']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: true,
      minRows: 1,
    },
    {
      id: 'message-star',
      group: 'large',
      purpose: 'Measure a broad multi-property message star.',
      sparql: query(QUERY_BODIES['message-star']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'message-snowflake',
      group: 'large',
      purpose: 'Measure a message and thread snowflake join.',
      sparql: query(QUERY_BODIES['message-snowflake']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'bounded-many-to-many',
      group: 'large',
      purpose: 'Measure a bounded many-to-many thread join.',
      sparql: query(QUERY_BODIES['bounded-many-to-many']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'low-selectivity-filter',
      group: 'large',
      purpose: 'Measure a low-selectivity score filter.',
      sparql: query(QUERY_BODIES['low-selectivity-filter']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'medium-selectivity-filter',
      group: 'large',
      purpose: 'Measure a medium-selectivity score filter.',
      sparql: query(QUERY_BODIES['medium-selectivity-filter']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'high-selectivity-filter',
      group: 'large',
      purpose: 'Measure a high-selectivity score filter.',
      sparql: query(QUERY_BODIES['high-selectivity-filter']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'count-distinct-threads',
      group: 'large',
      purpose: 'Measure a distinct thread aggregate over messages.',
      sparql: query(QUERY_BODIES['count-distinct-threads']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: true,
      expectedRows: 1,
    },
    {
      id: 'ordered-top-k',
      group: 'large',
      purpose: 'Measure ordered top-k message retrieval.',
      sparql: query(QUERY_BODIES['ordered-top-k']),
      sharedSurface: true,
      orderSensitive: true,
      concurrencyRepresentative: false,
      expectedRows: 100,
    },
    {
      id: 'optional-content',
      group: 'large',
      purpose: 'Measure optional message content expansion.',
      sparql: query(QUERY_BODIES['optional-content']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'union-status-score',
      group: 'large',
      purpose: 'Measure a union across status and score access paths.',
      sparql: query(QUERY_BODIES['union-status-score']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'top-thread-aggregate',
      group: 'large',
      purpose: 'Measure grouped and stably ordered thread counts.',
      sparql: query(QUERY_BODIES['top-thread-aggregate']),
      sharedSurface: true,
      orderSensitive: true,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'authorization-inherited-prefix',
      group: 'authorization',
      purpose: 'Measure an inherited-prefix scope on the message star workload.',
      sparql: query(QUERY_BODIES['message-star']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
      accessScope: authorizationScopes[0],
    },
    {
      id: 'authorization-explicit-allow',
      group: 'authorization',
      purpose: 'Measure an explicit graph allow on the two-hop workload.',
      sparql: query(QUERY_BODIES['two-hop-chain']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
      accessScope: authorizationScopes[1],
    },
    {
      id: 'authorization-explicit-deny',
      group: 'authorization',
      purpose: 'Measure an explicit graph deny on the distinct-count workload.',
      sparql: query(QUERY_BODIES['count-distinct-threads']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      expectedRows: 1,
      accessScope: authorizationScopes[2],
    },
    {
      id: 'authorization-scoped-broad-join',
      group: 'authorization',
      purpose: 'Measure a denied-prefix scope on the ordered broad workload.',
      sparql: query(QUERY_BODIES['ordered-top-k']),
      sharedSurface: true,
      orderSensitive: true,
      concurrencyRepresentative: true,
      expectedRows: 100,
      accessScope: authorizationScopes[3],
    },
  ];
}
