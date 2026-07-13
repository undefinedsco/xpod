import type {
  RdfBindExpression,
  RdfQuery,
  RdfQueryBind,
} from './types';

export function describeFusionRankPlan(query: RdfQuery): string[] {
  const textScores = (query.textSearch ?? [])
    .map((pattern) => pattern.score)
    .filter((score): score is string => typeof score === 'string' && score.length > 0);
  const vectorScores = (query.vectorSearch ?? [])
    .map((pattern) => pattern.score)
    .filter((score): score is string => typeof score === 'string' && score.length > 0);
  if (textScores.length === 0 || vectorScores.length === 0) {
    return [];
  }

  for (const bind of query.binds ?? []) {
    const variables = bindExpressionVariables(bind.expression);
    const textScore = textScores.find((score) => variables.has(score));
    const vectorScore = vectorScores.find((score) => variables.has(score));
    if (!textScore || !vectorScore) {
      continue;
    }

    const plan = [
      `FusionRankInputs(text:?${textScore},vector:?${vectorScore},output:?${bind.variable})`,
    ];
    const weights = describeFusionRankWeights(bind, textScore, vectorScore);
    if (weights) {
      plan.push(weights);
    }
    const tieBreaker = describeFusionRankTieBreaker(query, bind.variable);
    if (tieBreaker) {
      plan.push(tieBreaker);
    }
    const hardFilters = describesFusionRank(query, bind.variable)
      ? describeFusionHardFiltersBeforeRank(query, bind.variable)
      : undefined;
    if (hardFilters) {
      plan.push(hardFilters);
    }
    return plan;
  }

  return [];
}

function describeFusionRankWeights(
  bind: RdfQueryBind,
  textScore: string,
  vectorScore: string,
): string | undefined {
  const weights = fusionRankWeights(bind.expression, textScore, vectorScore);
  if (!weights) {
    return undefined;
  }
  return `FusionRankWeights(text:${weights.text},vector:${weights.vector},output:?${bind.variable})`;
}

function describeFusionRankTieBreaker(query: RdfQuery, outputVariable: string): string | undefined {
  const orderBy = query.orderBy ?? [];
  const outputOrderIndex = orderBy.findIndex((entry) => entry.variable === outputVariable);
  if (outputOrderIndex < 0) {
    return undefined;
  }

  const tieBreakers = orderBy.slice(outputOrderIndex + 1);
  if (tieBreakers.length === 0) {
    return undefined;
  }

  return `FusionRankTieBreaker(${tieBreakers
    .map((entry) => `${entry.direction ?? 'asc'}:?${entry.variable}`)
    .join(',')})`;
}

function describesFusionRank(query: RdfQuery, outputVariable: string): boolean {
  return query.orderBy?.[0]?.variable === outputVariable;
}

function describeFusionHardFiltersBeforeRank(query: RdfQuery, outputVariable: string): string | undefined {
  const kinds = fusionHardFilterKinds(query);
  if (kinds.length === 0) {
    return undefined;
  }
  return `FusionHardFiltersBeforeRank(${[...kinds, `output:?${outputVariable}`].join(',')})`;
}

function fusionHardFilterKinds(query: RdfQuery): string[] {
  const scopes = [
    ...(query.textSearch ?? []).map((pattern) => pattern.scope),
    ...(query.vectorSearch ?? []).map((pattern) => pattern.scope),
  ].filter((scope): scope is NonNullable<typeof scope> => scope !== undefined);

  const kinds: string[] = [];
  if (scopes.some((scope) => (
    !!scope.workspace || !!scope.sourcePrefix || !!scope.localPathPrefix
  ))) {
    kinds.push('path');
  }
  if (scopes.some((scope) => (
    !!scope.accessBasePath
      || (scope.allowedSources?.length ?? 0) > 0
      || (scope.deniedSources?.length ?? 0) > 0
      || (scope.deniedSourcePrefixes?.length ?? 0) > 0
  ))) {
    kinds.push('acl');
  }
  return kinds;
}

function fusionRankWeights(
  expression: RdfBindExpression,
  textScore: string,
  vectorScore: string,
): { text: string; vector: string } | undefined {
  if (expression.type !== 'add') {
    return undefined;
  }

  let textWeight: string | undefined;
  let vectorWeight: string | undefined;
  for (const item of expression.expressions) {
    const weighted = fusionRankWeightedTerm(item);
    if (weighted?.variable === textScore) {
      textWeight = weighted.weight;
    } else if (weighted?.variable === vectorScore) {
      vectorWeight = weighted.weight;
    }
  }
  return textWeight && vectorWeight
    ? { text: textWeight, vector: vectorWeight }
    : undefined;
}

function fusionRankWeightedTerm(
  expression: RdfBindExpression,
): { variable: string; weight: string } | undefined {
  if (expression.type !== 'multiply') {
    return undefined;
  }

  let variable: string | undefined;
  let weight: string | undefined;
  for (const item of expression.expressions) {
    variable ??= bindScoreVariable(item);
    weight ??= numericTermLiteral(item);
  }
  return variable && weight ? { variable, weight } : undefined;
}

function bindScoreVariable(expression: RdfBindExpression): string | undefined {
  if (expression.type === 'variable') {
    return expression.variable;
  }
  if (expression.type === 'numericValue' && expression.expression.type === 'variable') {
    return expression.expression.variable;
  }
  return undefined;
}

function numericTermLiteral(expression: RdfBindExpression): string | undefined {
  if (
    expression.type === 'term'
    && expression.term.termType === 'Literal'
    && Number.isFinite(Number(expression.term.value))
  ) {
    return expression.term.value;
  }
  return undefined;
}

function bindExpressionVariables(expression: RdfBindExpression, variables = new Set<string>()): Set<string> {
  switch (expression.type) {
    case 'term':
      return variables;
    case 'variable':
    case 'stringValue':
    case 'stringLength':
      variables.add(expression.variable);
      return variables;
    case 'lowerCase':
    case 'upperCase':
    case 'numericValue':
    case 'iri':
      return bindExpressionVariables(expression.expression, variables);
    case 'coalesce':
    case 'add':
    case 'multiply':
    case 'concat':
      for (const item of expression.expressions) {
        bindExpressionVariables(item, variables);
      }
      return variables;
    case 'if':
      bindExpressionVariables(expression.then, variables);
      bindExpressionVariables(expression.else, variables);
      return variables;
    case 'substring':
      bindExpressionVariables(expression.expression, variables);
      bindExpressionVariables(expression.start, variables);
      if (expression.length) {
        bindExpressionVariables(expression.length, variables);
      }
      return variables;
    case 'strdt':
      bindExpressionVariables(expression.lexical, variables);
      bindExpressionVariables(expression.datatype, variables);
      return variables;
    case 'strlang':
      bindExpressionVariables(expression.lexical, variables);
      bindExpressionVariables(expression.language, variables);
      return variables;
    default: {
      const exhaustive: never = expression;
      void exhaustive;
      return variables;
    }
  }
}
