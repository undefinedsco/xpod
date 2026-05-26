import { termToId } from 'n3';
import type { Quad } from '@rdfjs/types';
import type { QuintStore } from '../quint/types';
import type { RdfPatternQuery, RdfShadowDiff, RdfShadowScanResult } from './types';
import { RdfQuadIndex } from './RdfQuadIndex';

export class RdfShadowComparator {
  public constructor(
    private readonly primary: RdfQuadIndex,
    private readonly compatibility: QuintStore,
  ) {}

  public async compareScan(query: RdfPatternQuery): Promise<RdfShadowScanResult> {
    const primaryResult = this.primary.scan(query.pattern, query.options);
    const compatibilityResult = await this.compatibility.get(query.pattern, query.options);
    const diff = diffQuads(primaryResult.quads, compatibilityResult);
    const orderedMatch = orderedQuadKeys(primaryResult.quads).join('\n') === orderedQuadKeys(compatibilityResult).join('\n');
    return {
      matched: diff.missingFromPrimary.length === 0 && diff.extraInPrimary.length === 0,
      orderedMatch,
      primary: primaryResult.quads,
      compatibility: compatibilityResult,
      diff,
      metrics: primaryResult.metrics,
    };
  }
}

function orderedQuadKeys(quads: Quad[]): string[] {
  return quads.map(canonicalQuadKey);
}

export function diffQuads(primary: Quad[], compatibility: Quad[]): RdfShadowDiff {
  const primarySet = new Set(primary.map(canonicalQuadKey));
  const compatibilitySet = new Set(compatibility.map(canonicalQuadKey));
  return {
    missingFromPrimary: Array.from(compatibilitySet).filter((key) => !primarySet.has(key)).sort(),
    extraInPrimary: Array.from(primarySet).filter((key) => !compatibilitySet.has(key)).sort(),
  };
}

export function canonicalQuadKey(quad: Quad): string {
  return [
    termToId(quad.graph as any),
    termToId(quad.subject as any),
    termToId(quad.predicate as any),
    termToId(quad.object as any),
  ].join('\u001f');
}
