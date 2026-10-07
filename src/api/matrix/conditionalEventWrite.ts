/**
 * Conditional first-writer insert for Matrix events.
 *
 * The ORM's ordinary `insert(...).values(...)` is an unconditional PATCH: two API processes writing
 * the same logical `(roomId, eventId)` both succeed and leave competing scalar values under one
 * subject (see `docs/issues/drizzle-solid-matrix-atomicity.md`). The installed public ORM can
 * serialize the row to SPARQL, and its public dialect can POST an update to the Pod's scoped SPARQL
 * sidecar with the caller's authenticated transport. This module turns that into one conditional
 * `INSERT WHERE`:
 *
 * - all ORM-generated triples are gathered into ONE target document graph (the candidate day
 *   document for the event), because the guard's `NOT EXISTS` must look across the room's daily
 *   documents but the write lands in exactly one of them;
 * - the WHERE anchors the room's canonical Chat document and shares `?parent` with a `NOT EXISTS`
 *   that checks for a Message with the same parent and the same canonical fragment across the room's
 *   date graphs;
 * - the variable existence graph is left for the server to enumerate (`VALUES ?existingGraph`)
 *   under its scope write lock, so the inventory cannot change between condition and commit.
 *
 * No Turtle is hand-written and no AST is built by string-splitting: the ORM produces the triples and
 * sparqljs produces the query.
 */
import { Parser, Generator } from 'sparqljs';
import { DataFactory } from 'n3';

/** The slice of the ORM/dialect this bridge calls, kept structural so tests can stub it. */
export interface ConditionalWriteDatabase {
  insert: (table: unknown) => { values: (row: Record<string, unknown>) => { toSPARQL: () => { query: string } } };
  getDialect: () => {
    executeOnResource: (
      endpoint: string,
      query: { type: string; query: string; prefixes: Record<string, string> },
      options: { mode: string; endpoint: string },
    ) => Promise<unknown>;
  };
}

export interface ConditionalEventWriteInput {
  insertQuery: string;
  /** The message resource IRI including its fragment, from `messageResource.buildIri`. */
  messageIri: string;
  /** The room's canonical Chat IRI including its fragment, from `roomChatIri`. */
  chatIri: string;
  /** The room directory IRI (the chat document's container). */
  roomDirectory: string;
  chatType: string;
  messageType: string;
  parentPredicate: string;
}

export interface ConditionalEventWrite {
  query: string;
  /** The one day document the winning triples land in. */
  document: string;
  fragment: string;
  /** The scoped SPARQL sidecar endpoint the POST goes to. */
  endpoint: string;
}

/** Whether this database can express an authenticated scoped conditional insert. */
export function canWriteConditionally(db: unknown): boolean {
  const candidate = db as Partial<ConditionalWriteDatabase> | undefined;
  if (!candidate || typeof candidate.insert !== 'function' || typeof candidate.getDialect !== 'function') {
    return false;
  }
  try {
    return typeof candidate.getDialect().executeOnResource === 'function';
  } catch {
    return false;
  }
}

/** All triples the ORM emitted, regardless of how it grouped them by subject or graph. */
function collectInsertTriples(parsed: unknown): unknown[] {
  const triples: unknown[] = [];
  const collect = (patterns: unknown[] | undefined): void => {
    for (const pattern of patterns ?? []) {
      const entry = pattern as { type?: string; triples?: unknown[]; patterns?: unknown[] };
      if (entry.type === 'bgp') {
        triples.push(...entry.triples ?? []);
      } else if (entry.type === 'graph') {
        if (Array.isArray(entry.patterns)) {
          collect(entry.patterns);
        } else {
          triples.push(...entry.triples ?? []);
        }
      }
    }
  };
  const updates = (parsed as { updates?: Array<{ insert?: unknown[] }> }).updates ?? [];
  for (const update of updates) {
    collect(update.insert);
  }
  return triples;
}

/**
 * Build the conditional insert from the ORM's own serialization of the row.
 *
 * The `INSERT` target graph is the candidate day document; the `WHERE` anchors the canonical Chat
 * document and checks for an existing Message with the same parent and fragment inside a variable
 * graph that the server fills with the current inventory.
 */
export function buildConditionalEventWrite(input: ConditionalEventWriteInput): ConditionalEventWrite {
  const parsed = new Parser().parse(input.insertQuery) as { updates?: Array<Record<string, unknown>> };
  const triples = collectInsertTriples(parsed);
  if (triples.length === 0) {
    throw new Error('ORM produced no triples for the event row');
  }
  const message = new URL(input.messageIri);
  const fragment = message.hash;
  message.hash = '';
  const document = message.href;
  const chat = new URL(input.chatIri);
  chat.hash = '';
  const chatDocument = chat.href;
  const roomScope = input.roomDirectory.endsWith('/') ? input.roomDirectory : `${input.roomDirectory}/`;
  const endpoint = `${roomScope}-/sparql`;

  const guard = new Parser().parse(`INSERT { GRAPH <${document}> { <urn:xpod:placeholder> a <urn:xpod:placeholder> } } WHERE {
    GRAPH <${chatDocument}> { ?parent a <${input.chatType}> }
    FILTER(?parent = <${input.chatIri}>)
    FILTER NOT EXISTS {
      GRAPH ?existingGraph {
        ?existing a <${input.messageType}> ;
          <${input.parentPredicate}> ?parent
      }
      FILTER(STRSTARTS(STR(?existingGraph), ${JSON.stringify(roomScope)}))
      FILTER(STRENDS(STR(?existing), ${JSON.stringify(fragment)}))
    }
  }`) as { updates: Array<Record<string, unknown>> };
  guard.updates[0].insert = [
    { type: 'graph', name: DataFactory.namedNode(document), triples },
  ];
  const query = new Generator().stringify(guard as never);
  return { query, document, fragment, endpoint };
}

/**
 * POST the conditional insert with the ORM's authenticated transport.
 *
 * A `204` means the request was accepted, not that this candidate won: a `WHERE` that does not match
 * performs no insert and still succeeds. The caller must hydrate the committed row and compare
 * semantics.
 */
export async function executeConditionalEventWrite(
  db: ConditionalWriteDatabase,
  write: ConditionalEventWrite,
): Promise<void> {
  await db.getDialect().executeOnResource(
    write.endpoint,
    { type: 'INSERT', query: write.query, prefixes: {} },
    { mode: 'sparql', endpoint: write.endpoint },
  );
}
