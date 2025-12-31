/**
 * FilterPushdownExtractor - Extract pushdownable conditions from SPARQL FILTER
 * 
 * Analyzes SPARQL FILTER expressions and extracts conditions that can be
 * pushed down to the database layer for efficient query execution.
 * 
 * Supported pushdown operations:
 * - Comparison: =, !=, <, >, <=, >=
 * - String functions: STRSTARTS, STRENDS, CONTAINS, REGEX
 * - Type checking: isIRI, isBlank, isLiteral, isNumeric
 * - Language: LANGMATCHES
 * - Logical: AND, OR (with $in optimization)
 * - Set operations: IN, NOT IN
 * - Existence: BOUND, !BOUND
 */

import type { Algebra } from 'sparqlalgebrajs';
import { DataFactory } from 'rdf-data-factory';

import type { TermOperators } from '../quint/types';
import { fpEncode, NUMERIC_TYPES, DATETIME_TYPE, SEP, serializeObject } from '../quint/serialization';
import { 
  extractVariable, 
  extractStrVariable, 
  extractLiteralValue, 
  extractLiteral, 
  extractTerm,
  isVariableInPattern 
} from './AlgebraUtils';

const dataFactory = new DataFactory();

/**
 * Pushdown filters extracted from SPARQL FILTER clauses
 * Maps variable names to their filter conditions
 */
export interface PushdownFilters {
  [varName: string]: TermOperators;
}

/**
 * Result of extracting pushdown filters from an expression
 */
export interface PushdownResult {
  filters: PushdownFilters;
  remainder: Algebra.Expression | null;
  orBranches?: PushdownFilters[];
  orNonPushdownBranches?: Algebra.Expression[];
}

/**
 * FilterPushdownExtractor extracts pushdownable conditions from FILTER expressions
 */
export class FilterPushdownExtractor {
  /**
   * Extract pushdownable filters from an expression
   * Returns filters that can be pushed down and the remaining expression
   */
  extractPushdownFilters(
    expr: Algebra.Expression,
    pattern: Algebra.Pattern
  ): PushdownResult {
    if (expr.expressionType !== 'operator') {
      // Can't pushdown non-operator expressions
      return { filters: {}, remainder: expr };
    }

    const opExpr = expr as Algebra.OperatorExpression;
    const op = opExpr.operator.toLowerCase();

    // Handle AND: recursively extract from both sides
    if (op === '&&') {
      const filters: PushdownFilters = {};
      const remainders: Algebra.Expression[] = [];

      for (const arg of opExpr.args) {
        const result = this.extractPushdownFilters(arg, pattern);
        // Merge filters
        for (const [varName, ops] of Object.entries(result.filters)) {
          filters[varName] = { ...filters[varName], ...ops };
        }
        if (result.remainder) {
          remainders.push(result.remainder);
        }
      }

      // Combine remainders with AND
      let remainder: Algebra.Expression | null = null;
      if (remainders.length === 1) {
        remainder = remainders[0];
      } else if (remainders.length > 1) {
        remainder = {
          type: 'expression',
          expressionType: 'operator',
          operator: '&&',
          args: remainders,
        } as Algebra.OperatorExpression;
      }

      return { filters, remainder };
    }

    // Handle OR: try to convert to $in or OR branches
    if (op === '||') {
      return this.extractOrPushdown(opExpr, pattern);
    }

    // Try to extract single pushdown condition
    const result = this.tryExtractSinglePushdown(opExpr, pattern);
    if (result) {
      return { filters: result, remainder: null };
    }

    // Can't pushdown
    return { filters: {}, remainder: expr };
  }

  /**
   * Handle OR expression pushdown
   * - Same variable equality: convert to $in
   * - Different variables: create OR branches for separate queries
   * - Mixed (pushdownable + non-pushdownable): orBranches + orNonPushdownBranches
   */
  private extractOrPushdown(
    expr: Algebra.OperatorExpression,
    pattern: Algebra.Pattern
  ): PushdownResult {
    // Flatten OR tree and collect all branches
    const branches: Algebra.Expression[] = [];
    const collectBranches = (e: Algebra.Expression): void => {
      if (e.expressionType === 'operator') {
        const op = e as Algebra.OperatorExpression;
        if (op.operator.toLowerCase() === '||') {
          op.args.forEach(collectBranches);
          return;
        }
      }
      branches.push(e);
    };
    collectBranches(expr);

    // Try to extract pushdown from each branch
    const pushdownable: { filters: PushdownFilters; expr: Algebra.Expression }[] = [];
    const nonPushdownable: Algebra.Expression[] = [];

    for (const branch of branches) {
      if (branch.expressionType === 'operator') {
        const branchFilters = this.tryExtractSinglePushdown(branch as Algebra.OperatorExpression, pattern);
        if (branchFilters && Object.keys(branchFilters).length > 0) {
          pushdownable.push({ filters: branchFilters, expr: branch });
          continue;
        }
      }
      nonPushdownable.push(branch);
    }

    // If nothing pushdownable, return as remainder
    if (pushdownable.length === 0) {
      return { filters: {}, remainder: expr };
    }

    // Check if all are same-variable equality (can use $in)
    const inResult = this.tryConvertToIn(pushdownable);
    if (inResult && nonPushdownable.length === 0) {
      return { filters: inResult, remainder: null };
    }

    // Different variables or mixed: use OR branches
    const orBranches = pushdownable.map(p => p.filters);
    
    // Non-pushdownable branches need OR semantics (not AND), so use orNonPushdownBranches
    return { 
      filters: {}, 
      remainder: null, 
      orBranches,
      orNonPushdownBranches: nonPushdownable.length > 0 ? nonPushdownable : undefined
    };
  }

  /**
   * Try to convert same-variable equalities to $in
   */
  private tryConvertToIn(
    branches: { filters: PushdownFilters; expr: Algebra.Expression }[]
  ): PushdownFilters | null {
    // Check if all branches are single-variable equality
    const varValues = new Map<string, string[]>();
    
    for (const { filters } of branches) {
      const keys = Object.keys(filters);
      if (keys.length !== 1) return null;
      
      const varName = keys[0];
      const ops = filters[varName];
      const opKeys = Object.keys(ops);
      
      if (opKeys.length !== 1 || !('$eq' in ops)) return null;
      
      if (!varValues.has(varName)) {
        varValues.set(varName, []);
      }
      varValues.get(varName)!.push(ops.$eq as string);
    }

    // Must be single variable
    if (varValues.size !== 1) return null;

    const [varName, values] = [...varValues.entries()][0];
    return { [varName]: { $in: values } };
  }

  /**
   * Try to extract pushdown filter from a single operator expression
   */
  tryExtractSinglePushdown(
    expr: Algebra.OperatorExpression,
    pattern: Algebra.Pattern
  ): PushdownFilters | null {
    const op = expr.operator.toLowerCase();
    const filters: PushdownFilters = {};

    // Comparison: =, !=, <, >, <=, >=
    if (['=', '!=', '<', '>', '<=', '>='].includes(op) && expr.args.length === 2) {
      const result = this.extractComparison(expr, op);
      if (result) {
        // Only pushdown if the variable is in the pattern
        if (isVariableInPattern(result.varName, pattern)) {
          filters[result.varName] = { [result.op]: result.value };
          return filters;
        }
      }
    }

    // STRSTARTS, STRENDS, CONTAINS
    // Database stores serialized literals like "Alice" (with quotes)
    // So we adjust the search pattern accordingly:
    // - STRSTARTS('A') -> $startsWith: '"A' (add leading quote)
    // - STRENDS('e') -> $endsWith: 'e"' (add trailing quote)
    // - CONTAINS('x') -> $contains: 'x' (quotes don't affect middle content)
    if (['strstarts', 'strends', 'contains'].includes(op) && expr.args.length === 2) {
      const varName = extractStrVariable(expr.args[0]);
      const value = extractLiteralValue(expr.args[1]);
      if (varName && value && isVariableInPattern(varName, pattern)) {
        if (op === 'strstarts') {
          filters[varName] = { $startsWith: '"' + value };
        } else if (op === 'strends') {
          filters[varName] = { $endsWith: value + '"' };
        } else {
          filters[varName] = { $contains: value };
        }
        return filters;
      }
    }

    // REGEX
    if (op === 'regex' && expr.args.length >= 2) {
      const varName = extractStrVariable(expr.args[0]);
      const regexPattern = extractLiteralValue(expr.args[1]);
      if (varName && regexPattern && isVariableInPattern(varName, pattern)) {
        filters[varName] = { $regex: regexPattern };
        return filters;
      }
    }

    // IN
    if (op === 'in' && expr.args.length >= 1) {
      const varName = extractVariable(expr.args[0]);
      if (varName && isVariableInPattern(varName, pattern)) {
        const values: string[] = [];
        for (let i = 1; i < expr.args.length; i++) {
          const lit = extractLiteral(expr.args[i]);
          if (lit) {
            values.push(this.serializeExactValue(lit.value, lit.datatype));
          }
        }
        if (values.length > 0) {
          filters[varName] = { $in: values };
          return filters;
        }
      }
    }

    // NOT IN
    if (op === 'notin' && expr.args.length >= 1) {
      const varName = extractVariable(expr.args[0]);
      if (varName && isVariableInPattern(varName, pattern)) {
        const values: string[] = [];
        for (let i = 1; i < expr.args.length; i++) {
          const lit = extractLiteral(expr.args[i]);
          if (lit) {
            values.push(this.serializeExactValue(lit.value, lit.datatype));
          }
        }
        if (values.length > 0) {
          filters[varName] = { $notIn: values };
          return filters;
        }
      }
    }

    // BOUND
    if (op === 'bound' && expr.args.length === 1) {
      const varName = extractVariable(expr.args[0]);
      if (varName && isVariableInPattern(varName, pattern)) {
        filters[varName] = { $isNull: false };
        return filters;
      }
    }

    // !BOUND
    if (op === '!' && expr.args.length === 1) {
      const inner = expr.args[0];
      if (inner.expressionType === 'operator') {
        const innerOp = inner as Algebra.OperatorExpression;
        if (innerOp.operator.toLowerCase() === 'bound' && innerOp.args.length === 1) {
          const varName = extractVariable(innerOp.args[0]);
          if (varName && isVariableInPattern(varName, pattern)) {
            filters[varName] = { $isNull: true };
            return filters;
          }
        }
      }
    }

    // Type checking functions
    // isiri/isuri: In Solid, IRIs are http:// or https://
    if ((op === 'isiri' || op === 'isuri') && expr.args.length === 1) {
      const varName = extractVariable(expr.args[0]);
      if (varName && isVariableInPattern(varName, pattern)) {
        filters[varName] = { $startsWith: 'http' };
        return filters;
      }
    }

    // isblank: Blank nodes start with _:
    if (op === 'isblank' && expr.args.length === 1) {
      const varName = extractVariable(expr.args[0]);
      if (varName && isVariableInPattern(varName, pattern)) {
        filters[varName] = { $startsWith: '_:' };
        return filters;
      }
    }

    // isliteral: Literals start with " (or N\0 for numeric, D\0 for datetime)
    if (op === 'isliteral' && expr.args.length === 1) {
      const varName = extractVariable(expr.args[0]);
      if (varName && isVariableInPattern(varName, pattern)) {
        // Match strings starting with ", N (numeric), or D (datetime)
        filters[varName] = { $regex: '^["ND]' };
        return filters;
      }
    }

    // isnumeric: Our numeric literals start with N\0
    if (op === 'isnumeric' && expr.args.length === 1) {
      const varName = extractVariable(expr.args[0]);
      if (varName && isVariableInPattern(varName, pattern)) {
        filters[varName] = { $startsWith: 'N\0' };
        return filters;
      }
    }

    // LANGMATCHES(LANG(?x), "en") - language tagged literals end with @lang"
    // Serialization format: "value"@en
    if (op === 'langmatches' && expr.args.length === 2) {
      const langExpr = expr.args[0] as Algebra.Expression;
      const langPattern = expr.args[1];
      
      // First arg should be LANG(?var)
      if (langExpr.expressionType === 'operator' && 
          (langExpr as Algebra.OperatorExpression).operator === 'lang' &&
          (langExpr as Algebra.OperatorExpression).args.length === 1) {
        const varName = extractVariable((langExpr as Algebra.OperatorExpression).args[0]);
        
        if (varName && isVariableInPattern(varName, pattern)) {
          // Get the language pattern
          if (langPattern.termType === 'Literal') {
            const lang = langPattern.value.toLowerCase();
            if (lang === '*') {
              // Match any language tagged literal - ends with @something"
              // Use regex to match @[a-z]+" pattern at end
              filters[varName] = { $regex: '@[a-zA-Z]+"$' };
            } else {
              // Match specific language - ends with @lang"
              filters[varName] = { $endsWith: `@${lang}"` };
            }
            return filters;
          }
        }
      }
    }

    return null;
  }

  /**
   * Extract comparison operator info
   */
  private extractComparison(
    expr: Algebra.OperatorExpression,
    op: string
  ): { varName: string; op: string; value: string } | null {
    const [left, right] = expr.args;

    // ?var op literal
    const leftVar = extractVariable(left);
    const rightLiteral = extractLiteral(right);
    if (leftVar && rightLiteral) {
      const filterOp = this.mapComparisonOp(op);
      const value = this.serializeForComparison(rightLiteral.value, rightLiteral.datatype, filterOp);
      return { varName: leftVar, op: filterOp, value };
    }

    // literal op ?var (reverse)
    const leftLiteral = extractLiteral(left);
    const rightVar = extractVariable(right);
    if (leftLiteral && rightVar) {
      const reversedOp = this.reverseComparisonOp(op);
      const filterOp = this.mapComparisonOp(reversedOp);
      const value = this.serializeForComparison(leftLiteral.value, leftLiteral.datatype, filterOp);
      return { varName: rightVar, op: filterOp, value };
    }

    // ?var = <namedNode>
    const leftVarForTerm = extractVariable(left);
    const rightTerm = extractTerm(right);
    if (leftVarForTerm && rightTerm && (op === '=' || op === '!=')) {
      const filterOp = op === '=' ? '$eq' : '$ne';
      return { varName: leftVarForTerm, op: filterOp, value: serializeObject(rightTerm) };
    }

    return null;
  }

  private mapComparisonOp(op: string): string {
    const map: Record<string, string> = {
      '=': '$eq', '!=': '$ne', '<': '$lt', '>': '$gt', '<=': '$lte', '>=': '$gte'
    };
    return map[op] || '$eq';
  }

  private reverseComparisonOp(op: string): string {
    const map: Record<string, string> = {
      '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '!=': '!='
    };
    return map[op] || op;
  }

  /**
   * Serialize value for comparison
   * 
   * Range comparison handling:
   * - $gt, $lte: Use fpstring + max suffix to be >= all values with same fpstring
   * - $lt, $gte: Use fpstring only (prefix), stored values are always > prefix
   * - $eq, $ne: Use exact serialization
   */
  serializeForComparison(value: string, datatype: string | undefined, filterOp: string): string {
    // Exact match uses full serialization
    if (filterOp === '$eq' || filterOp === '$ne') {
      return this.serializeExactValue(value, datatype);
    }
    
    // Range comparison
    if (datatype && NUMERIC_TYPES.has(datatype)) {
      const fpValue = `N${SEP}${fpEncode(value)}`;
      // $gt and $lte need max suffix to compare correctly
      if (filterOp === '$gt' || filterOp === '$lte') {
        return fpValue + SEP + '\uffff';
      }
      // $lt and $gte use prefix only
      return fpValue;
    }
    
    if (datatype === DATETIME_TYPE) {
      const fpValue = `D${SEP}${fpEncode(new Date(value).valueOf())}`;
      if (filterOp === '$gt' || filterOp === '$lte') {
        return fpValue + SEP + '\uffff';
      }
      return fpValue;
    }
    
    // For non-numeric types, use exact value (string comparison)
    return this.serializeExactValue(value, datatype);
  }

  serializeExactValue(value: string, datatype?: string): string {
    const lit = datatype 
      ? dataFactory.literal(value, dataFactory.namedNode(datatype))
      : dataFactory.literal(value);
    return serializeObject(lit);
  }
}
