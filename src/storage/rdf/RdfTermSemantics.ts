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

/**
 * Completes the numeric ORDER BY relation where SPARQL value comparison is
 * unordered: Xpod and QLever place NaN after every other numeric value.
 * All non-NaN comparisons stay owned by the query evaluator.
 */
export function compareRdfNumericNaNOrder(left: Term | undefined, right: Term | undefined): -1 | 0 | 1 | undefined {
  if (!isRdfNumericLiteral(left) || !isRdfNumericLiteral(right)) {
    return undefined;
  }
  const leftNaN = isRdfNaNTerm(left);
  const rightNaN = isRdfNaNTerm(right);
  if (!leftNaN && !rightNaN) {
    return undefined;
  }
  if (leftNaN === rightNaN) {
    return 0;
  }
  return leftNaN ? 1 : -1;
}

function isRdfNumericLiteral(term: Term | undefined): term is Term & { termType: 'Literal' } {
  return term?.termType === 'Literal' && isRdfNumericDatatype(term.datatype.value);
}

function isRdfNaNTerm(term: Term & { termType: 'Literal' }): boolean {
  const datatype = term.datatype.value;
  return term.value === 'NaN'
    && (datatype === 'http://www.w3.org/2001/XMLSchema#double'
      || datatype === 'http://www.w3.org/2001/XMLSchema#float');
}
