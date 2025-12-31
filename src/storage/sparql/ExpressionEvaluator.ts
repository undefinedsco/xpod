/**
 * ExpressionEvaluator - In-memory SPARQL expression evaluation
 * 
 * Evaluates SPARQL expressions that cannot be pushed down to the database.
 * Used for filtering bindings after initial pattern matching.
 */

import type { Term, Variable, Bindings } from '@rdfjs/types';
import type { Algebra } from 'sparqlalgebrajs';
import { DataFactory } from 'rdf-data-factory';

import type { QuintStore, QuintPattern } from '../quint/types';
import { NUMERIC_TYPES } from '../quint/serialization';
import type { PatternBuilder } from './PatternBuilder';

const dataFactory = new DataFactory();

/**
 * Callback for extracting pattern from operation
 */
export type ExtractPatternFn = (operation: Algebra.Operation) => { pattern: Algebra.Pattern; filter: Algebra.Expression | null };

/**
 * ExpressionEvaluator handles in-memory evaluation of SPARQL expressions
 */
export class ExpressionEvaluator {
  constructor(
    private readonly store: QuintStore,
    private readonly patternBuilder: PatternBuilder,
    private readonly extractPatternAndFilter: ExtractPatternFn
  ) {}

  /**
   * Evaluate filter expression tree against candidate bindings
   */
  async evaluateFilterTree(
    expr: Algebra.Expression,
    candidates: Bindings[],
    pattern: Algebra.Pattern
  ): Promise<Bindings[]> {
    if (candidates.length === 0) return [];

    switch (expr.expressionType) {
      case 'operator':
        return this.evaluateOperator(expr as Algebra.OperatorExpression, candidates, pattern);
      case 'existence':
        return this.evaluateExistence(expr as Algebra.ExistenceExpression, candidates, pattern);
      case 'term':
        const termExpr = expr as Algebra.TermExpression;
        return this.effectiveBooleanValue(termExpr.term) ? candidates : [];
      default:
        return candidates; // Unknown: be permissive
    }
  }

  /**
   * Evaluate operator expression
   */
  private async evaluateOperator(
    expr: Algebra.OperatorExpression,
    candidates: Bindings[],
    pattern: Algebra.Pattern
  ): Promise<Bindings[]> {
    const op = expr.operator.toLowerCase();

    // Logical AND
    if (op === '&&') {
      let result = candidates;
      for (const arg of expr.args) {
        result = await this.evaluateFilterTree(arg, result, pattern);
      }
      return result;
    }

    // Logical OR
    if (op === '||') {
      const resultSets = await Promise.all(
        expr.args.map(arg => this.evaluateFilterTree(arg, candidates, pattern))
      );
      return this.unionBindings(resultSets);
    }

    // Logical NOT
    if (op === '!') {
      const positives = await this.evaluateFilterTree(expr.args[0], candidates, pattern);
      const positiveKeys = new Set(positives.map(b => this.getBindingKey(b)));
      return candidates.filter(b => !positiveKeys.has(this.getBindingKey(b)));
    }

    // Other operators: evaluate each binding individually
    return candidates.filter(b => this.evaluateSingleBinding(expr, b));
  }

  /**
   * Union multiple binding sets
   */
  private unionBindings(sets: Bindings[][]): Bindings[] {
    const seen = new Set<string>();
    const result: Bindings[] = [];
    for (const set of sets) {
      for (const binding of set) {
        const key = this.getBindingKey(binding);
        if (!seen.has(key)) {
          seen.add(key);
          result.push(binding);
        }
      }
    }
    return result;
  }

  /**
   * Evaluate EXISTS/NOT EXISTS
   */
  private async evaluateExistence(
    expr: Algebra.ExistenceExpression,
    candidates: Bindings[],
    _pattern: Algebra.Pattern
  ): Promise<Bindings[]> {
    const results: Bindings[] = [];
    for (const binding of candidates) {
      const exists = await this.checkExists(expr.input, binding);
      if (expr.not ? !exists : exists) {
        results.push(binding);
      }
    }
    return results;
  }

  private async checkExists(subOperation: Algebra.Operation, binding: Bindings): Promise<boolean> {
    const { pattern: subPattern } = this.extractPatternAndFilter(subOperation);
    const quintPattern = this.patternBuilder.buildExistsPattern(subPattern, binding);
    const results = await this.store.get(quintPattern, { limit: 1 });
    return results.length > 0;
  }

  /**
   * Evaluate single binding against operator
   */
  evaluateSingleBinding(expr: Algebra.OperatorExpression, binding: Bindings): boolean {
    const op = expr.operator.toLowerCase();

    // Comparison
    if (['=', '!=', '<', '>', '<=', '>='].includes(op)) {
      const left = this.getTermValue(expr.args[0], binding);
      const right = this.getTermValue(expr.args[1], binding);
      if (left === null || right === null) return false;
      return this.compareTerms(left, right, op);
    }

    // BOUND
    if (op === 'bound') {
      const varExpr = expr.args[0];
      if (varExpr.expressionType === 'term') {
        const term = (varExpr as Algebra.TermExpression).term;
        if (term.termType === 'Variable') {
          return binding.get(term as Variable) !== undefined;
        }
      }
      return false;
    }

    // String functions
    if (op === 'strstarts') {
      const str = this.getStringValue(expr.args[0], binding);
      const prefix = this.getStringValue(expr.args[1], binding);
      return str !== null && prefix !== null && str.startsWith(prefix);
    }
    if (op === 'strends') {
      const str = this.getStringValue(expr.args[0], binding);
      const suffix = this.getStringValue(expr.args[1], binding);
      return str !== null && suffix !== null && str.endsWith(suffix);
    }
    if (op === 'contains') {
      const str = this.getStringValue(expr.args[0], binding);
      const substr = this.getStringValue(expr.args[1], binding);
      return str !== null && substr !== null && str.includes(substr);
    }
    if (op === 'regex') {
      const str = this.getStringValue(expr.args[0], binding);
      const pattern = this.getStringValue(expr.args[1], binding);
      if (str === null || pattern === null) return false;
      try {
        const flags = expr.args[2] ? this.getStringValue(expr.args[2], binding) || '' : '';
        return new RegExp(pattern, flags).test(str);
      } catch {
        return false;
      }
    }

    // Type checking functions
    if (op === 'isiri' || op === 'isuri') {
      const term = this.getTermValue(expr.args[0], binding);
      return term !== null && term.termType === 'NamedNode';
    }
    if (op === 'isblank') {
      const term = this.getTermValue(expr.args[0], binding);
      return term !== null && term.termType === 'BlankNode';
    }
    if (op === 'isliteral') {
      const term = this.getTermValue(expr.args[0], binding);
      return term !== null && term.termType === 'Literal';
    }
    if (op === 'isnumeric') {
      const term = this.getTermValue(expr.args[0], binding);
      if (term?.termType === 'Literal') {
        const lit = term as any;
        return lit.datatype && NUMERIC_TYPES.has(lit.datatype.value);
      }
      return false;
    }

    // LANGMATCHES
    if (op === 'langmatches') {
      const langExpr = expr.args[0] as Algebra.OperatorExpression;
      if (langExpr.expressionType === 'operator' && langExpr.operator.toLowerCase() === 'lang') {
        const term = this.getTermValue(langExpr.args[0], binding);
        if (term?.termType === 'Literal') {
          const lit = term as any;
          const lang = lit.language || '';
          const pattern = this.getStringValue(expr.args[1], binding);
          if (pattern === '*') return lang.length > 0;
          if (pattern) return lang.toLowerCase() === pattern.toLowerCase();
        }
      }
      return false;
    }

    // IN / NOT IN
    if (op === 'in') {
      const value = this.getTermValue(expr.args[0], binding);
      if (value === null) return false;
      for (let i = 1; i < expr.args.length; i++) {
        if (this.compareTerms(value, this.getTermValue(expr.args[i], binding), '=')) return true;
      }
      return false;
    }
    if (op === 'notin') {
      const value = this.getTermValue(expr.args[0], binding);
      if (value === null) return true;
      for (let i = 1; i < expr.args.length; i++) {
        if (this.compareTerms(value, this.getTermValue(expr.args[i], binding), '=')) return false;
      }
      return true;
    }

    return true; // Unknown: be permissive
  }

  // ============================================================
  // Helper Methods
  // ============================================================

  getTermValue(expr: Algebra.Expression, binding: Bindings): Term | null {
    if (expr.expressionType === 'term') {
      const termExpr = expr as Algebra.TermExpression;
      if (termExpr.term.termType === 'Variable') {
        return binding.get(termExpr.term as Variable) || null;
      }
      return termExpr.term;
    }
    if (expr.expressionType === 'operator') {
      const opExpr = expr as Algebra.OperatorExpression;
      const op = opExpr.operator.toLowerCase();
      
      // STR function
      if (op === 'str') {
        const inner = this.getTermValue(opExpr.args[0], binding);
        if (inner) return dataFactory.literal(inner.value);
      }
      
      // STRLEN function - returns integer
      if (op === 'strlen') {
        const str = this.getStringValue(opExpr.args[0], binding);
        if (str !== null) {
          return dataFactory.literal(
            str.length.toString(),
            dataFactory.namedNode('http://www.w3.org/2001/XMLSchema#integer')
          );
        }
      }
      
      // Numeric functions
      if (op === 'abs') {
        const val = this.getNumericValue(opExpr.args[0], binding);
        if (val !== null) {
          return dataFactory.literal(
            Math.abs(val).toString(),
            dataFactory.namedNode('http://www.w3.org/2001/XMLSchema#decimal')
          );
        }
      }
      if (op === 'round') {
        const val = this.getNumericValue(opExpr.args[0], binding);
        if (val !== null) {
          return dataFactory.literal(
            Math.round(val).toString(),
            dataFactory.namedNode('http://www.w3.org/2001/XMLSchema#decimal')
          );
        }
      }
      if (op === 'floor') {
        const val = this.getNumericValue(opExpr.args[0], binding);
        if (val !== null) {
          return dataFactory.literal(
            Math.floor(val).toString(),
            dataFactory.namedNode('http://www.w3.org/2001/XMLSchema#decimal')
          );
        }
      }
      if (op === 'ceil') {
        const val = this.getNumericValue(opExpr.args[0], binding);
        if (val !== null) {
          return dataFactory.literal(
            Math.ceil(val).toString(),
            dataFactory.namedNode('http://www.w3.org/2001/XMLSchema#decimal')
          );
        }
      }
    }
    return null;
  }

  getNumericValue(expr: Algebra.Expression, binding: Bindings): number | null {
    const term = this.getTermValue(expr, binding);
    if (term?.termType === 'Literal') {
      const val = parseFloat(term.value);
      if (!isNaN(val)) return val;
    }
    return null;
  }

  getStringValue(expr: Algebra.Expression, binding: Bindings): string | null {
    const term = this.getTermValue(expr, binding);
    return term?.value ?? null;
  }

  compareTerms(left: Term | null, right: Term | null, op: string): boolean {
    if (left === null || right === null) return false;
    
    if (left.termType === 'Literal' && right.termType === 'Literal') {
      const leftLit = left as any;
      const rightLit = right as any;
      
      if (this.isNumericLiteral(leftLit) && this.isNumericLiteral(rightLit)) {
        const l = parseFloat(leftLit.value), r = parseFloat(rightLit.value);
        switch (op) {
          case '=': return l === r;
          case '!=': return l !== r;
          case '<': return l < r;
          case '>': return l > r;
          case '<=': return l <= r;
          case '>=': return l >= r;
        }
      }
      
      const cmp = leftLit.value.localeCompare(rightLit.value);
      switch (op) {
        case '=': return cmp === 0;
        case '!=': return cmp !== 0;
        case '<': return cmp < 0;
        case '>': return cmp > 0;
        case '<=': return cmp <= 0;
        case '>=': return cmp >= 0;
      }
    }
    
    switch (op) {
      case '=': return left.value === right.value;
      case '!=': return left.value !== right.value;
      default: return false;
    }
  }

  isNumericLiteral(lit: any): boolean {
    return lit.datatype && NUMERIC_TYPES.has(lit.datatype.value);
  }

  effectiveBooleanValue(term: Term): boolean {
    if (term.termType === 'Literal') {
      const lit = term as any;
      if (lit.datatype?.value === 'http://www.w3.org/2001/XMLSchema#boolean') {
        return lit.value === 'true';
      }
      return lit.value.length > 0;
    }
    return true;
  }

  getBindingKey(binding: Bindings): string {
    const parts: string[] = [];
    binding.forEach((value: Term, key: Variable) => {
      parts.push(`${key.value}=${value.value}`);
    });
    return parts.sort().join('|');
  }
}
