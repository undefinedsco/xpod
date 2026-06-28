import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import arrayifyStream from 'arrayify-stream';
import jsonld from 'jsonld';
import { Parser } from 'n3';
import { rdfParser } from 'rdf-parse';
import type { Quad } from '@rdfjs/types';
import type { RdfTextChunkInput, RdfTextSourceInput } from './types';
import { normalizeContentType, rdfContentTypeForPath } from './RdfContentTypes';

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

export type TextIndexPolicyRole =
  | 'searchableText'
  | 'displayOnlyText'
  | 'sensitiveText'
  | 'structured'
  | 'relation'
  | 'system';

const SEARCHABLE_TEXT_LOCAL_NAMES = new Set([
  'abstract',
  'acceptance',
  'altlabel',
  'articlebody',
  'body',
  'comment',
  'content',
  'description',
  'label',
  'name',
  'note',
  'preflabel',
  'summary',
  'text',
  'title',
]);

const HEADING_TEXT_LOCAL_NAMES = new Set([
  'altlabel',
  'label',
  'name',
  'preflabel',
  'title',
]);

const STRUCTURED_LOCAL_NAMES = new Set([
  'created',
  'createdat',
  'datecreated',
  'datemodified',
  'modified',
  'modifiedat',
  'order',
  'position',
  'priority',
  'rank',
  'score',
  'status',
]);

const RELATION_LOCAL_NAMES = new Set([
  'author',
  'creator',
  'editor',
  'follows',
  'haspart',
  'ispartof',
  'knows',
  'member',
  'mentions',
  'owner',
  'parent',
  'relatedto',
  'replyto',
]);

const SENSITIVE_LOCAL_NAME_PARTS = [
  'apikey',
  'api_key',
  'accesskey',
  'access_key',
  'authorization',
  'credential',
  'password',
  'privatekey',
  'private_key',
  'proxy',
  'secret',
  'token',
];

const SYSTEM_PREDICATE_PREFIXES = [
  'http://www.w3.org/ns/auth/acl#',
  'http://www.w3.org/ns/solid/acp#',
  'http://www.w3.org/ns/solid/terms#',
  'https://vocab.xpod.dev/credential#',
  'https://vocab.xpod.dev/ai#',
];

export function rdfTextIndexPolicyRole(predicate: string): TextIndexPolicyRole {
  const normalized = predicate.trim().toLowerCase();
  if (!normalized) {
    return 'system';
  }
  if (SYSTEM_PREDICATE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return 'system';
  }

  const localName = rdfPredicateLocalName(normalized).replace(/[-_\s]/g, '');
  if (SENSITIVE_LOCAL_NAME_PARTS.some((part) => localName.includes(part.replace(/[-_\s]/g, '')))) {
    return 'sensitiveText';
  }
  if (SEARCHABLE_TEXT_LOCAL_NAMES.has(localName)) {
    return 'searchableText';
  }
  if (STRUCTURED_LOCAL_NAMES.has(localName)) {
    return 'structured';
  }
  if (RELATION_LOCAL_NAMES.has(localName)) {
    return 'relation';
  }
  return 'displayOnlyText';
}

export function createRdfEntityTextChunks(
  source: RdfTextSourceInput,
  quads: Quad[],
  options: RdfEntityTextProjectionOptions = {},
): RdfTextChunkInput[] {
  const fieldsBySubject = new Map<string, RdfTextProjectionField[]>();
  for (const quad of quads) {
    if (quad.object.termType !== 'Literal' || !isSearchableLiteral(quad.object.datatype.value, quad.object.language)) {
      continue;
    }
    if (quad.predicate.termType !== 'NamedNode') {
      continue;
    }
    const role = rdfTextIndexPolicyRole(quad.predicate.value);
    if (role !== 'searchableText') {
      continue;
    }
    const subject = quad.subject.value;
    const fields = fieldsBySubject.get(subject) ?? [];
    fields.push({
      predicate: quad.predicate.value,
      label: rdfPredicateDisplayLabel(quad.predicate.value),
      value: quad.object.value,
      datatype: quad.object.datatype.value,
      language: quad.object.language,
      policyRole: role,
    });
    fieldsBySubject.set(subject, fields);
  }

  const chunks: RdfTextChunkInput[] = [];
  let ordinal = 0;
  for (const [subject, fields] of [...fieldsBySubject.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const orderedFields = fields.sort((left, right) =>
      left.predicate.localeCompare(right.predicate) || left.value.localeCompare(right.value));
    const cardFields = orderedFields.filter((field) => !isLongRdfTextField(field.value, options.maxFieldBytes));
    const fieldChunkFields = orderedFields.filter((field) => isLongRdfTextField(field.value, options.maxFieldBytes));
    if (cardFields.length > 0) {
      const content = cardFields
        .map((field) => `${field.label}: ${field.value}`)
        .join('\n');
      chunks.push({
        chunkKey: rdfEntityChunkKey(source.source, subject),
        retrievalKind: 'entity-card',
        ordinal: ordinal++,
        level: 0,
        heading: rdfEntityHeading(cardFields),
        path: [],
        content,
        startOffset: 0,
        endOffset: content.length,
        entities: cardFields.map((field) => rdfTextFieldEntity(subject, field)),
      });
    }
    for (const field of fieldChunkFields) {
      const content = `${field.label}: ${field.value}`;
      chunks.push({
        chunkKey: rdfFieldChunkKey(source.source, subject, field.predicate, field.value),
        retrievalKind: 'field-chunk',
        ordinal: ordinal++,
        level: 0,
        heading: rdfEntityHeading(cardFields),
        path: [],
        content,
        startOffset: 0,
        endOffset: content.length,
        entities: [rdfTextFieldEntity(subject, field)],
      });
    }
  }
  return chunks;
}

export async function createRdfEntityTextChunksFromText(
  source: RdfTextSourceInput,
  text: string,
  options: RdfEntityTextProjectionOptions = {},
): Promise<RdfTextChunkInput[]> {
  return createRdfEntityTextChunks(source, await parseRdfTextProjectionQuads(source, text), options);
}

export interface RdfEntityTextProjectionOptions {
  maxFieldBytes?: number;
}

interface RdfTextProjectionField {
  predicate: string;
  label: string;
  value: string;
  datatype: string;
  language: string;
  policyRole: TextIndexPolicyRole;
}

function isLongRdfTextField(value: string, maxFieldBytes: number | undefined): boolean {
  if (maxFieldBytes === undefined || !Number.isFinite(maxFieldBytes)) {
    return false;
  }
  return Buffer.byteLength(value) > Math.max(0, Math.trunc(maxFieldBytes));
}

function rdfEntityHeading(fields: RdfTextProjectionField[]): string | undefined {
  return fields.find((field) =>
    HEADING_TEXT_LOCAL_NAMES.has(rdfPredicateLocalName(field.predicate).toLowerCase().replace(/[-_\s]/g, '')),
  )?.value;
}

function rdfTextFieldEntity(subject: string, field: RdfTextProjectionField): NonNullable<RdfTextChunkInput['entities']>[number] {
  return {
    entity: subject,
    predicate: field.predicate,
    value: field.value,
    datatype: field.datatype,
    language: field.language || undefined,
    policyRole: field.policyRole,
  };
}

export async function parseRdfTextProjectionQuads(source: RdfTextSourceInput, text: string): Promise<Quad[]> {
  const contentType = normalizeContentType(source.contentType) ?? rdfContentTypeForPath(source.localPath ?? source.source) ?? 'text/turtle';
  if (contentType === 'application/ld+json') {
    const nquads = await jsonld.toRDF(JSON.parse(text), {
      base: source.source,
      format: 'application/n-quads',
    }) as string;
    return new Parser({ format: 'application/n-quads', baseIRI: source.source }).parse(nquads);
  }
  if (contentType === 'application/rdf+xml') {
    return arrayifyStream<Quad>(rdfParser.parse(Readable.from([text]), {
      contentType,
      baseIRI: source.source,
    }) as any);
  }
  return new Parser({ format: contentType, baseIRI: source.source }).parse(text);
}

function isSearchableLiteral(datatype: string, language: string): boolean {
  return datatype === XSD_STRING || datatype === RDF_LANG_STRING || Boolean(language);
}

function rdfEntityChunkKey(source: string, subject: string): string {
  return createHash('sha256')
    .update(source)
    .update('\0rdf-entity\0')
    .update(subject)
    .digest('hex')
    .slice(0, 24);
}

function rdfFieldChunkKey(source: string, subject: string, predicate: string, value: string): string {
  return createHash('sha256')
    .update(source)
    .update('\0rdf-field\0')
    .update(subject)
    .update('\0')
    .update(predicate)
    .update('\0')
    .update(value)
    .digest('hex')
    .slice(0, 24);
}

function rdfPredicateDisplayLabel(predicate: string): string {
  const local = rdfPredicateLocalName(predicate);
  return local
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim() || 'text';
}

function rdfPredicateLocalName(predicate: string): string {
  const hash = predicate.lastIndexOf('#');
  const slash = predicate.lastIndexOf('/');
  const colon = predicate.lastIndexOf(':');
  const index = Math.max(hash, slash, colon);
  return index >= 0 ? predicate.slice(index + 1) : predicate;
}
