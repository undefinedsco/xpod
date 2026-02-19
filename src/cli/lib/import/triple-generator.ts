/**
 * Generate Turtle triples from database rows + TriplesMap definitions.
 *
 * Handles:
 * - rr:template with {column} placeholder expansion (percent-encoded)
 * - rr:column → literal values
 * - rr:constant → fixed values
 * - rr:class → rdf:type triple
 * - rr:datatype → typed literals
 * - rr:language → language-tagged literals
 */

import type { TriplesMap, ObjectMap, Row } from './types';

const XSD = 'http://www.w3.org/2001/XMLSchema#';

/**
 * Percent-encode a value for use in IRI templates (RFC 3986 unreserved chars kept).
 */
function iriEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

/**
 * Expand a template string like "http://example.com/{col}" with row values.
 */
function expandTemplate(template: string, row: Row): string {
  return template.replace(/\{([^}]+)\}/g, (_, col: string) => {
    const val = row[col];
    return val != null ? iriEncode(String(val)) : '';
  });
}

/**
 * Escape a string for use in a Turtle literal (double-quote delimited).
 */
function escapeTurtle(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Format a Turtle object term from an ObjectMap + row data.
 * Returns null if the value is null/undefined.
 */
function formatObject(om: ObjectMap, row: Row): string | null {
  let value: string | null = null;

  if (om.column != null) {
    const raw = row[om.column];
    if (raw == null) return null;
    value = String(raw);
  } else if (om.template != null) {
    value = expandTemplate(om.template, row);
    // Templates produce IRIs
    return `<${value}>`;
  } else if (om.constant != null) {
    value = om.constant;
    // If constant looks like an IRI, wrap in <>
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return `<${value}>`;
    }
  }

  if (value == null) return null;

  // Language-tagged literal
  if (om.language) {
    return `"${escapeTurtle(value)}"@${om.language}`;
  }

  // Typed literal
  if (om.datatype) {
    // Shortcut: xsd:integer / xsd:decimal / xsd:double / xsd:boolean can skip quotes in Turtle
    // but for simplicity we always use the explicit typed form
    return `"${escapeTurtle(value)}"^^<${om.datatype}>`;
  }

  // Plain literal
  return `"${escapeTurtle(value)}"`;
}

/**
 * Generate Turtle triples for a single row.
 * Returns a string of Turtle statements (without prefix declarations).
 */
export function generateTriplesForRow(map: TriplesMap, row: Row): string {
  const subject = `<${expandTemplate(map.subjectMap.template, row)}>`;
  const lines: string[] = [];

  // rdf:type triple
  if (map.subjectMap.class) {
    lines.push(`${subject} a <${map.subjectMap.class}> .`);
  }

  // Predicate-object triples
  for (const pom of map.predicateObjectMaps) {
    const obj = formatObject(pom.objectMap, row);
    if (obj != null) {
      lines.push(`${subject} <${pom.predicate}> ${obj} .`);
    }
  }

  return lines.join('\n');
}

/**
 * Extract a subject "id" from a row (the last path segment of the expanded template).
 * Used for per-row file naming.
 */
export function extractSubjectId(map: TriplesMap, row: Row): string {
  const expanded = expandTemplate(map.subjectMap.template, row);
  // Take the last non-empty path segment or hash fragment
  const hashIdx = expanded.lastIndexOf('#');
  if (hashIdx >= 0) return expanded.slice(hashIdx + 1);
  const segments = expanded.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? 'unknown';
}

/**
 * Build a Turtle prefix header from common namespaces used in the mapping.
 */
export function buildPrefixHeader(maps: TriplesMap[]): string {
  const prefixes = new Map<string, string>();
  prefixes.set('rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#');
  prefixes.set('xsd', XSD);

  // Collect unique namespace prefixes from predicates and classes
  for (const map of maps) {
    if (map.subjectMap.class) {
      addPrefix(prefixes, map.subjectMap.class);
    }
    for (const pom of map.predicateObjectMaps) {
      addPrefix(prefixes, pom.predicate);
      if (pom.objectMap.datatype) addPrefix(prefixes, pom.objectMap.datatype);
    }
  }

  return [...prefixes.entries()]
    .map(([prefix, ns]) => `@prefix ${prefix}: <${ns}> .`)
    .join('\n');
}

/** Try to extract a namespace prefix from a full IRI and add it to the map. */
function addPrefix(prefixes: Map<string, string>, iri: string): void {
  // Common known namespaces
  const known: Record<string, string> = {
    'https://undefineds.co/ns#': 'udfs',
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#': 'rdf',
    'http://www.w3.org/2000/01/rdf-schema#': 'rdfs',
    'http://xmlns.com/foaf/0.1/': 'foaf',
    'https://schema.org/': 'schema',
    'http://www.w3.org/2001/XMLSchema#': 'xsd',
  };

  for (const [ns, prefix] of Object.entries(known)) {
    if (iri.startsWith(ns)) {
      prefixes.set(prefix, ns);
      return;
    }
  }
}
