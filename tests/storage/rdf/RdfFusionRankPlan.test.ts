import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { describeFusionRankPlan } from '../../../src/storage/rdf/RdfFusionRankPlan';
import type { RdfQuery } from '../../../src/storage/rdf/types';

const { literal, namedNode } = DataFactory;

const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';

function fusionQuery(orderBy?: RdfQuery['orderBy']): RdfQuery {
  return {
    patterns: [],
    textSearch: [{
      query: 'managed runtime',
      scope: {
        workspace: 'https://pod.example/alice/projects/demo/',
        accessBasePath: 'https://pod.example/alice/projects/demo/',
        allowedSources: ['https://pod.example/alice/projects/demo/fusion.md'],
      },
      source: 'source',
      score: 'textScore',
    }],
    vectorSearch: [{
      embedding: [1, 0],
      vectorModel: 'test-embed',
      scope: {
        workspace: 'https://pod.example/alice/projects/demo/',
        accessBasePath: 'https://pod.example/alice/projects/demo/',
        allowedSources: ['https://pod.example/alice/projects/demo/fusion.md'],
      },
      source: 'source',
      score: 'vectorScore',
    }],
    binds: [{
      variable: 'fusionScore',
      expression: {
        type: 'add',
        expressions: [
          {
            type: 'multiply',
            expressions: [
              { type: 'numericValue', expression: { type: 'variable', variable: 'textScore' } },
              { type: 'term', term: literal('0.55', namedNode(XSD_DECIMAL)) },
            ],
          },
          {
            type: 'multiply',
            expressions: [
              { type: 'numericValue', expression: { type: 'variable', variable: 'vectorScore' } },
              { type: 'term', term: literal('0.45', namedNode(XSD_DECIMAL)) },
            ],
          },
        ],
      },
    }],
    select: ['source', 'fusionScore'],
    ...(orderBy
      ? { orderBy }
      : {}),
  };
}

describe('describeFusionRankPlan', () => {
  it('only reports hard filters before rank when fused score is the rank key', () => {
    expect(describeFusionRankPlan(fusionQuery())).not.toContain(
      'FusionHardFiltersBeforeRank(path,acl,output:?fusionScore)',
    );
    expect(describeFusionRankPlan(fusionQuery([{ variable: 'source' }]))).not.toContain(
      'FusionHardFiltersBeforeRank(path,acl,output:?fusionScore)',
    );
    expect(describeFusionRankPlan(fusionQuery([
      { variable: 'source' },
      { variable: 'fusionScore', direction: 'desc' },
    ]))).not.toContain(
      'FusionHardFiltersBeforeRank(path,acl,output:?fusionScore)',
    );
    expect(describeFusionRankPlan(fusionQuery([{ variable: 'fusionScore', direction: 'desc' }]))).toContain(
      'FusionHardFiltersBeforeRank(path,acl,output:?fusionScore)',
    );
  });
});
