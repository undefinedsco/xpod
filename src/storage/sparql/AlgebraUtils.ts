/**
 * AlgebraUtils - SPARQL algebra tree traversal utilities
 * 
 * Provides helper functions for working with SPARQL algebra trees:
 * - Variable extraction
 * - Term extraction from expressions
 * - Literal value extraction
 */

import type { Term, Variable } from '@rdfjs/types';
import type { Algebra } from 'sparqlalgebrajs';

/**
 * Extract variable name from an expression
 * Returns the variable name (without ?) if it's a variable, null otherwise
 */
export function extractVariable(expr: Algebra.Expression): string | null {
  if (expr.expressionType === 'term' && expr.term.termType === 'Variable') {
    return expr.term.value;
  }
  return null;
}

/**
 * Extract variable name from STR(?var) expression
 * Handles both direct variable and STR() wrapped variable
 */
export function extractStrVariable(expr: Algebra.Expression): string | null {
  // Direct variable
  const direct = extractVariable(expr);
  if (direct) return direct;
  
  // STR(?var)
  if (expr.expressionType === 'operator') {
    const opExpr = expr as Algebra.OperatorExpression;
    if (opExpr.operator === 'str' && opExpr.args.length === 1) {
      return extractVariable(opExpr.args[0]);
    }
  }
  return null;
}

/**
 * Extract literal value from an expression
 * Returns the string value if it's a literal, null otherwise
 */
export function extractLiteralValue(expr: Algebra.Expression): string | null {
  if (expr.expressionType === 'term' && expr.term.termType === 'Literal') {
    return expr.term.value;
  }
  return null;
}

/**
 * Extract literal with datatype from an expression
 */
export function extractLiteral(expr: Algebra.Expression): { value: string; datatype?: string } | null {
  if (expr.expressionType === 'term' && expr.term.termType === 'Literal') {
    const lit = expr.term as any;
    return {
      value: lit.value,
      datatype: lit.datatype?.value
    };
  }
  return null;
}

/**
 * Extract a term from an expression
 */
export function extractTerm(expr: Algebra.Expression): Term | null {
  if (expr.expressionType === 'term') {
    return expr.term;
  }
  return null;
}

/**
 * Extract all variables from a pattern
 */
export function extractVariables(pattern: Algebra.Pattern): Variable[] {
  const vars: Variable[] = [];
  const seen = new Set<string>();
  
  for (const pos of ['subject', 'predicate', 'object', 'graph'] as const) {
    const term = pattern[pos];
    if (term && term.termType === 'Variable' && !seen.has(term.value)) {
      seen.add(term.value);
      vars.push(term);
    }
  }
  
  return vars;
}

/**
 * Check if a variable is used in a pattern position
 */
export function isVariableInPattern(varName: string, pattern: Algebra.Pattern): boolean {
  for (const pos of ['subject', 'predicate', 'object', 'graph'] as const) {
    const term = pattern[pos];
    if (term && term.termType === 'Variable' && term.value === varName) {
      return true;
    }
  }
  return false;
}

/**
 * Get the position of a variable in a pattern
 */
export function getVariablePosition(varName: string, pattern: Algebra.Pattern): 'subject' | 'predicate' | 'object' | 'graph' | null {
  for (const pos of ['subject', 'predicate', 'object', 'graph'] as const) {
    const term = pattern[pos];
    if (term && term.termType === 'Variable' && term.value === varName) {
      return pos;
    }
  }
  return null;
}
