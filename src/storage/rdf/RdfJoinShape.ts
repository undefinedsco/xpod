import type { Term } from '@rdfjs/types';
import { isTerm, type QuintPattern } from '../quint/types';
import type { RdfQueryPatternKey } from './types';

export interface RdfJoinShapePattern {
  pattern: QuintPattern;
  variables: Partial<Record<RdfQueryPatternKey, string>>;
}

export function rdfSubjectStarJoinPlanMarker(prefix: string, patterns: readonly RdfJoinShapePattern[]): string[] {
  const subjectKey = rdfSubjectStarJoinKey(patterns);
  return subjectKey ? [`${prefix}(${subjectKey};patterns:${patterns.length})`] : [];
}

export function rdfSubjectStarJoinKey(patterns: readonly RdfJoinShapePattern[]): string | undefined {
  if (patterns.length < 3) {
    return undefined;
  }
  const subjectKey = rdfSubjectKey(patterns[0]);
  if (!subjectKey) {
    return undefined;
  }
  return patterns.every((pattern) => rdfSubjectKey(pattern) === subjectKey) ? subjectKey : undefined;
}

function rdfSubjectKey(pattern: RdfJoinShapePattern): string | undefined {
  const variableName = pattern.variables.subject;
  if (variableName) {
    return `?${variableName}`;
  }
  const subject = pattern.pattern.subject;
  return subject && isTerm(subject) ? rdfTermKey(subject) : undefined;
}

function rdfTermKey(term: Term): string {
  return `${term.termType}:${term.value}`;
}
