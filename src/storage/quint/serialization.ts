/**
 * Term serialization utilities
 * 
 * - Subject, Predicate, Graph: use n3's termToId/termFromId
 * - Object: use fpstring encoding for numeric literals (sortable)
 */

import { termToId as n3TermToId, termFromId as n3TermFromId, DataFactory } from 'n3';
import type { Term, Quad, Literal } from '@rdfjs/types';

// Re-export n3's functions for non-object terms
export const termToId = (term: any): string => n3TermToId(term);
export const termFromId = (id: string): any => n3TermFromId(id, DataFactory);

// ============================================
// XSD numeric types
// ============================================

const XSD = 'http://www.w3.org/2001/XMLSchema#';

export const NUMERIC_TYPES = new Set([
  `${XSD}integer`,
  `${XSD}decimal`,
  `${XSD}float`,
  `${XSD}double`,
  `${XSD}nonPositiveInteger`,
  `${XSD}negativeInteger`,
  `${XSD}long`,
  `${XSD}int`,
  `${XSD}short`,
  `${XSD}byte`,
  `${XSD}nonNegativeInteger`,
  `${XSD}unsignedLong`,
  `${XSD}unsignedInt`,
  `${XSD}unsignedShort`,
  `${XSD}unsignedByte`,
  `${XSD}positiveInteger`,
]);

export const DATETIME_TYPE = `${XSD}dateTime`;

// ============================================
// fpstring encoding (from quadstore)
// ============================================

function fpJoin(encodingCase: number, exponent: number, mantissa: number): string {
  let r = '' + encodingCase;
  if (exponent < 10) {
    r += '00' + exponent;
  } else if (exponent < 100) {
    r += '0' + exponent;
  } else {
    r += exponent;
  }
  r += mantissa.toFixed(17);
  return r;
}

const FP_ZERO = fpJoin(3, 0, 0);
const FP_NEG_INF = fpJoin(0, 0, 0);
const FP_POS_INF = fpJoin(6, 0, 0);
const FP_NAN = fpJoin(7, 0, 0);

/**
 * Encode a number to a sortable string (fpstring format)
 * String comparison of encoded values preserves numeric ordering
 */
export function fpEncode(stringOrNumber: string | number): string {
  let mantissa = typeof stringOrNumber !== 'number'
    ? parseFloat(stringOrNumber)
    : stringOrNumber;

  if (Number.isNaN(mantissa)) return FP_NAN;
  if (mantissa === -Infinity) return FP_NEG_INF;
  if (mantissa === Infinity) return FP_POS_INF;
  if (mantissa === 0) return FP_ZERO;

  let exponent = 0;
  let sign = 0;

  if (mantissa < 0) {
    sign = 1;
    mantissa *= -1;
  }

  while (mantissa >= 10) {
    mantissa /= 10;
    exponent += 1;
  }
  while (mantissa < 1) {
    mantissa *= 10;
    exponent -= 1;
  }

  if (sign === 1) {
    if (exponent >= 0) {
      return fpJoin(1, 999 - exponent, 10 - mantissa);
    } else {
      return fpJoin(2, exponent * -1, 10 - mantissa);
    }
  } else {
    if (exponent < 0) {
      return fpJoin(4, 999 + exponent, mantissa);
    } else {
      return fpJoin(5, exponent, mantissa);
    }
  }
}

// ============================================
// Object serialization with fpstring
// ============================================

// Separator that won't appear in valid RDF data (same as quadstore)
export const SEP = '\u0000';

/**
 * Serialize object term with fpstring encoding for numeric literals
 * 
 * Format for numeric literals:
 *   N<SEP><fpstring><SEP><datatype><SEP><original_value>
 * 
 * Format for dateTime:
 *   D<SEP><fpstring><SEP><original_value>
 * 
 * Other terms use n3 format
 */
export function serializeObject(term: any): string {
  if (term.termType !== 'Literal') {
    return n3TermToId(term);
  }

  const lit = term as Literal;
  const datatype = lit.datatype?.value;

  // Numeric literal
  if (datatype && NUMERIC_TYPES.has(datatype)) {
    const encoded = fpEncode(lit.value);
    return `N${SEP}${encoded}${SEP}${datatype}${SEP}${lit.value}`;
  }

  // DateTime literal
  if (datatype === DATETIME_TYPE) {
    const timestamp = new Date(lit.value).valueOf();
    const encoded = fpEncode(timestamp);
    return `D${SEP}${encoded}${SEP}${lit.value}`;
  }

  // Other literals: use n3 format
  return n3TermToId(term);
}

/**
 * Deserialize object from storage format
 */
export function deserializeObject(str: string): any {
  // Numeric literal: N<SEP><fpstring><SEP><datatype><SEP><original_value>
  if (str.startsWith(`N${SEP}`)) {
    const parts = str.split(SEP);
    const datatype = parts[2];
    const value = parts[3];
    return DataFactory.literal(value, DataFactory.namedNode(datatype));
  }

  // DateTime literal: D<SEP><fpstring><SEP><original_value>
  if (str.startsWith(`D${SEP}`)) {
    const parts = str.split(SEP);
    const value = parts[2];
    return DataFactory.literal(value, DataFactory.namedNode(DATETIME_TYPE));
  }

  // Other terms: n3 format
  return n3TermFromId(str, DataFactory);
}

// ============================================
// Quad <-> Row conversion
// ============================================

/**
 * Serialize a Quad to row data for database storage
 */
export function quadToRow(quad: Quad, vector?: number[]): {
  graph: string;
  subject: string;
  predicate: string;
  object: string;
  vector: string | null;
} {
  return {
    graph: n3TermToId(quad.graph as any),
    subject: n3TermToId(quad.subject as any),
    predicate: n3TermToId(quad.predicate as any),
    object: serializeObject(quad.object),
    vector: vector ? JSON.stringify(vector) : null,
  };
}

/**
 * Deserialize row data to Quad
 */
export function rowToQuad(row: {
  graph: string;
  subject: string;
  predicate: string;
  object: string;
}): Quad {
  return DataFactory.quad(
    n3TermFromId(row.subject, DataFactory) as any,
    n3TermFromId(row.predicate, DataFactory) as any,
    deserializeObject(row.object) as any,
    n3TermFromId(row.graph, DataFactory) as any,
  ) as any;
}

/**
 * Parse vector from JSON string
 */
export function parseVector(vectorStr: string | null): number[] | undefined {
  if (!vectorStr) return undefined;
  return JSON.parse(vectorStr);
}
