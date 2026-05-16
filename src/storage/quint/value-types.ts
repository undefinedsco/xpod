import { DataFactory } from 'n3';
import type { Term, Literal } from '@rdfjs/types';

import {
  DATETIME_TYPE,
  NUMERIC_TYPES,
  deserializeObject,
  serializeObject,
} from './serialization';

/**
 * Declares what kind of RDF object value a predicate stores.
 *
 * This is schema data, not a query policy. Query capabilities are derived
 * from the declared data type:
 * - text/numeric/dateTime/iri/blankNode/literal with objectKey support
 *   can use exact/prefix/range/order.
 * - longText is stored for DB-side text search/contains and must not fall
 *   back to in-memory scans for range/order semantics.
 */
export type PredicateObjectDataType =
  | 'iri'
  | 'blankNode'
  | 'text'
  | 'longText'
  | 'numeric'
  | 'dateTime'
  | 'literal';

export interface PredicateObjectDataTypes {
  [predicate: string]: PredicateObjectDataType;
}

export interface ObjectIndexFields {
  objectKind: PredicateObjectDataType;
  objectKey: string | null;
  objectText: string | null;
}

export interface ObjectIndexOptions {
  predicate?: string;
  predicateObjectDataTypes?: PredicateObjectDataTypes;
  textMaxBytes?: number;
}

export const DEFAULT_TEXT_MAX_BYTES = 2048;

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

const textEncoder = new TextEncoder();

export function getPredicateObjectDataType(
  predicate: string | undefined,
  predicateObjectDataTypes: PredicateObjectDataTypes | undefined,
): PredicateObjectDataType | undefined {
  if (!predicate || !predicateObjectDataTypes) return undefined;
  return predicateObjectDataTypes[predicate];
}

export function objectIndexFieldsFromTerm(term: Term, options: ObjectIndexOptions = {}): ObjectIndexFields {
  const serialized = serializeObject(term);
  const declaredType = getPredicateObjectDataType(options.predicate, options.predicateObjectDataTypes);
  const textMaxBytes = options.textMaxBytes ?? DEFAULT_TEXT_MAX_BYTES;

  if (term.termType === 'NamedNode') {
    assertDeclaredType(declaredType, 'iri', options.predicate);
    return { objectKind: 'iri', objectKey: serialized, objectText: null };
  }

  if (term.termType === 'BlankNode') {
    assertDeclaredType(declaredType, 'blankNode', options.predicate);
    return { objectKind: 'blankNode', objectKey: serialized, objectText: null };
  }

  if (term.termType !== 'Literal') {
    return { objectKind: 'literal', objectKey: serialized, objectText: null };
  }

  const literal = term as Literal;
  const datatype = literal.datatype?.value;

  if (datatype && NUMERIC_TYPES.has(datatype)) {
    assertDeclaredType(declaredType, 'numeric', options.predicate);
    return { objectKind: 'numeric', objectKey: serialized, objectText: null };
  }

  if (datatype === DATETIME_TYPE) {
    assertDeclaredType(declaredType, 'dateTime', options.predicate);
    return { objectKind: 'dateTime', objectKey: serialized, objectText: null };
  }

  if (!isTextLiteral(literal)) {
    assertDeclaredType(declaredType, 'literal', options.predicate);
    return serializedTextLength(serialized) <= textMaxBytes
      ? { objectKind: 'literal', objectKey: serialized, objectText: literal.value }
      : { objectKind: 'literal', objectKey: null, objectText: literal.value };
  }

  if (declaredType === 'longText') {
    return { objectKind: 'longText', objectKey: null, objectText: literal.value };
  }

  if (declaredType === 'text') {
    if (serializedTextLength(serialized) > textMaxBytes) {
      throw new Error(
        `Predicate ${options.predicate ?? '(unknown)'} is declared as text, but the object exceeds ${textMaxBytes} bytes`,
      );
    }
    return { objectKind: 'text', objectKey: serialized, objectText: literal.value };
  }

  assertDeclaredType(declaredType, 'text', options.predicate);

  return serializedTextLength(serialized) <= textMaxBytes
    ? { objectKind: 'text', objectKey: serialized, objectText: literal.value }
    : { objectKind: 'longText', objectKey: null, objectText: literal.value };
}

export function objectIndexFieldsFromSerialized(
  serialized: string,
  options: ObjectIndexOptions = {},
): ObjectIndexFields {
  return objectIndexFieldsFromTerm(deserializeObject(serialized), options);
}

export function objectIndexFieldsFromOperatorValue(
  value: unknown,
  serialized: string,
  options: ObjectIndexOptions = {},
): ObjectIndexFields {
  if (isTermLike(value)) {
    return objectIndexFieldsFromTerm(value as Term, options);
  }

  const declaredType = getPredicateObjectDataType(options.predicate, options.predicateObjectDataTypes);
  if (declaredType === 'longText') {
    return { objectKind: 'longText', objectKey: null, objectText: String(value) };
  }

  return objectIndexFieldsFromSerialized(serialized, options);
}

export function isObjectValueComparable(fields: ObjectIndexFields): boolean {
  return fields.objectKey !== null && fields.objectKind !== 'longText';
}

export function literalFromPlainText(value: string): Term {
  return DataFactory.literal(value);
}

function isTextLiteral(literal: Literal): boolean {
  const datatype = literal.datatype?.value;
  return !datatype || datatype === XSD_STRING || datatype === RDF_LANG_STRING;
}

function serializedTextLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function assertDeclaredType(
  declaredType: PredicateObjectDataType | undefined,
  actualType: PredicateObjectDataType,
  predicate: string | undefined,
): void {
  if (!declaredType || declaredType === actualType || declaredType === 'literal') return;
  throw new Error(
    `Predicate ${predicate ?? '(unknown)'} is declared as ${declaredType}, but received ${actualType}`,
  );
}

function isTermLike(value: unknown): value is Term {
  return !!value && typeof value === 'object' && 'termType' in value;
}
