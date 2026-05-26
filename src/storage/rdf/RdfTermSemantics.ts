import type { Term } from '@rdfjs/types';

export const RDF_NUMERIC_DATATYPES = [
  'http://www.w3.org/2001/XMLSchema#integer',
  'http://www.w3.org/2001/XMLSchema#decimal',
  'http://www.w3.org/2001/XMLSchema#double',
  'http://www.w3.org/2001/XMLSchema#float',
  'http://www.w3.org/2001/XMLSchema#long',
  'http://www.w3.org/2001/XMLSchema#int',
  'http://www.w3.org/2001/XMLSchema#short',
  'http://www.w3.org/2001/XMLSchema#byte',
  'http://www.w3.org/2001/XMLSchema#nonNegativeInteger',
  'http://www.w3.org/2001/XMLSchema#nonPositiveInteger',
  'http://www.w3.org/2001/XMLSchema#positiveInteger',
  'http://www.w3.org/2001/XMLSchema#negativeInteger',
  'http://www.w3.org/2001/XMLSchema#unsignedLong',
  'http://www.w3.org/2001/XMLSchema#unsignedInt',
  'http://www.w3.org/2001/XMLSchema#unsignedShort',
  'http://www.w3.org/2001/XMLSchema#unsignedByte',
] as const;

export function isRdfNumericDatatype(datatype: string): boolean {
  return RDF_NUMERIC_DATATYPES.includes(datatype as typeof RDF_NUMERIC_DATATYPES[number]);
}

export function isFiniteNumericLexical(value: string | number): boolean {
  return Number.isFinite(Number(value));
}

export function rdfNumericValue(value: string | number): number {
  return Number(value);
}

export function isRdfNumericTerm(term: Term): boolean {
  return term.termType === 'Literal'
    && isRdfNumericDatatype(term.datatype.value)
    && isFiniteNumericLexical(term.value);
}
