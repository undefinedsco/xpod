const INVALID_IRIREF_CHARACTER = /[<>"{}|^`\\\u0000-\u0020]/u;

export function validateSparqlIri(value: string): string {
  if (INVALID_IRIREF_CHARACTER.test(value)) {
    throw new Error(`Unsafe IRI for SPARQL query: ${value}`);
  }
  return value;
}

export function serializeSparqlIri(value: string): string {
  return `<${validateSparqlIri(value)}>`;
}

export function serializeSparqlString(value: string): string {
  return JSON.stringify(value);
}
