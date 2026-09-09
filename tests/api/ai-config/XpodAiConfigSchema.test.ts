import { describe, expect, it } from 'vitest';
import { xpodAiConfigResource, XPOD_AI } from '../../../src/api/ai-config/XpodAiConfigSchema';

describe('xpodAiConfigResource', () => {
  it('owns only Xpod indexing and backend policy on the shared config subject', () => {
    expect(xpodAiConfigResource.getType()).toBe(XPOD_AI.IndexPolicy);
    expect(xpodAiConfigResource.buildId({ id: 'config' })).toBe('config.ttl#config');
    expect(xpodAiConfigResource.config.base).toBe('/settings/ai/');
    expect(Object.keys(xpodAiConfigResource.columns)).toEqual([
      'id',
      'ftsEnabled',
      'vectorEnabled',
      'progressiveIndexingEnabled',
      'automaticIndexing',
      'refreshAfterSourceUpdate',
      'removeAfterSourceDeletion',
      'textBackend',
      'vectorBackend',
      'previousModel',
      'migrationStatus',
      'migrationProgress',
    ]);
    expect(xpodAiConfigResource.columns.ftsEnabled.getPredicate()).toBe(XPOD_AI.ftsEnabled);
    expect(xpodAiConfigResource.columns.vectorBackend.getPredicate()).toBe(XPOD_AI.vectorBackend);
    expect(xpodAiConfigResource.columns.migrationStatus.getPredicate()).toBe(XPOD_AI.migrationStatus);
  });
});
