import type { BlankNode, NamedNode, Quad, Term } from '@rdfjs/types';
import { termToId } from 'n3';

const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LANG_STRING = `${RDF_NS}langString`;
const NC_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/u;

interface PredicateName {
  namespace: string;
  localName: string;
}

export function serializeRdfXml(quads: Quad[]): string {
  const predicateNames = new Map<string, PredicateName>();
  const namespacePrefixes = new Map<string, string>([[RDF_NS, 'rdf']]);

  for (const quad of quads) {
    if (quad.graph.termType !== 'DefaultGraph') {
      throw new Error(`RDF/XML cannot serialize named graph quads: ${quad.graph.value}`);
    }
    if (quad.predicate.termType !== 'NamedNode') {
      throw new Error(`RDF/XML predicate must be a named node: ${termToId(quad.predicate as any)}`);
    }
    const name = splitPredicateIri(quad.predicate.value);
    predicateNames.set(quad.predicate.value, name);
    if (!namespacePrefixes.has(name.namespace)) {
      namespacePrefixes.set(name.namespace, `ns${namespacePrefixes.size}`);
    }
  }

  const blankNodeIds = new Map<string, string>();
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rdf:RDF',
    ...[...namespacePrefixes.entries()]
      .map(([namespace, prefix]) => `  xmlns:${prefix}="${escapeXmlAttribute(namespace)}"`),
    '>',
  ];

  for (const [subject, subjectQuads] of groupBySubject(quads)) {
    lines.push(`  <rdf:Description ${subjectAttribute(subjectQuads[0].subject, blankNodeIds)}>`);
    for (const quad of subjectQuads) {
      const name = predicateNames.get(quad.predicate.value)!;
      const prefix = namespacePrefixes.get(name.namespace)!;
      lines.push(`    ${propertyElement(`${prefix}:${name.localName}`, quad.object, blankNodeIds)}`);
    }
    lines.push('  </rdf:Description>');
  }

  lines.push('</rdf:RDF>', '');
  return lines.join('\n');
}

function groupBySubject(quads: Quad[]): Map<string, Quad[]> {
  const groups = new Map<string, Quad[]>();
  for (const quad of quads) {
    const key = termToId(quad.subject as any);
    const group = groups.get(key);
    if (group) {
      group.push(quad);
    } else {
      groups.set(key, [quad]);
    }
  }
  return groups;
}

function subjectAttribute(subject: Term, blankNodeIds: Map<string, string>): string {
  if (subject.termType === 'NamedNode') {
    return `rdf:about="${escapeXmlAttribute(subject.value)}"`;
  }
  if (subject.termType === 'BlankNode') {
    return `rdf:nodeID="${blankNodeId(subject, blankNodeIds)}"`;
  }
  throw new Error(`RDF/XML subject must be a named node or blank node: ${termToId(subject as any)}`);
}

function propertyElement(
  qname: string,
  object: Term,
  blankNodeIds: Map<string, string>,
): string {
  if (object.termType === 'NamedNode') {
    return `<${qname} rdf:resource="${escapeXmlAttribute(object.value)}"/>`;
  }
  if (object.termType === 'BlankNode') {
    return `<${qname} rdf:nodeID="${blankNodeId(object, blankNodeIds)}"/>`;
  }
  if (object.termType !== 'Literal') {
    throw new Error(`RDF/XML object must be a named node, blank node, or literal: ${termToId(object as any)}`);
  }

  const attributes: string[] = [];
  if (object.language) {
    attributes.push(`xml:lang="${escapeXmlAttribute(object.language)}"`);
  }
  if (
    object.datatype
    && object.datatype.value !== XSD_STRING
    && object.datatype.value !== RDF_LANG_STRING
  ) {
    attributes.push(`rdf:datatype="${escapeXmlAttribute(object.datatype.value)}"`);
  }

  const suffix = attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
  return `<${qname}${suffix}>${escapeXmlText(object.value)}</${qname}>`;
}

function splitPredicateIri(iri: string): PredicateName {
  for (const separator of ['#', '/', ':']) {
    const index = iri.lastIndexOf(separator);
    if (index > -1 && index < iri.length - 1) {
      const namespace = iri.slice(0, index + 1);
      const localName = iri.slice(index + 1);
      if (NC_NAME.test(localName)) {
        return { namespace, localName };
      }
    }
  }
  throw new Error(`RDF/XML predicate IRI cannot be represented as an XML QName: ${iri}`);
}

function blankNodeId(node: BlankNode, blankNodeIds: Map<string, string>): string {
  const existing = blankNodeIds.get(node.value);
  if (existing) {
    return existing;
  }
  const generated = NC_NAME.test(node.value) ? node.value : `b${blankNodeIds.size + 1}`;
  blankNodeIds.set(node.value, generated);
  return generated;
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
