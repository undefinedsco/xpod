import { describe, expect, test } from 'bun:test';
import { modelsForAssignment, toAiConfigModelOptions } from './AiConfigContext';

describe('AI Config model options', () => {
  test('reuses AI Connections models while persisting canonical Pod model references', () => {
    expect(toAiConfigModelOptions([
      { id: 'text-embedding-3-small', provider: 'openai', displayName: 'Embedding Small', capabilities: ['embedding'] },
      { id: 'qwen3-vl-plus', provider: 'bailian', capabilities: ['chat', 'vision', 'ocr', 'document-understanding'] },
    ])).toEqual([
      { id: 'text-embedding-3-small', displayName: 'Embedding Small', owner: 'openai', ref: '/settings/providers/openai.ttl#text-embedding-3-small', capabilities: ['embedding'] },
      { id: 'qwen3-vl-plus', displayName: undefined, owner: 'bailian', ref: '/settings/providers/bailian.ttl#qwen3-vl-plus', capabilities: ['chat', 'vision', 'ocr', 'document-understanding'] },
    ]);
  });

  test('filters role choices by capability without treating OCR as a model class', () => {
    const options = toAiConfigModelOptions([
      { id: 'qwen3-vl-plus', provider: 'bailian', capabilities: ['chat', 'vision', 'ocr', 'document-understanding'] },
      { id: 'text-embedding-v4', provider: 'bailian', capabilities: ['embedding'] },
      { id: 'indexer-v1', provider: 'bailian', capabilities: ['indexing'] },
    ]);
    expect(modelsForAssignment(options, 'ocrModel').map((item) => item.id)).toEqual(['qwen3-vl-plus']);
    expect(modelsForAssignment(options, 'readerModel').map((item) => item.id)).toEqual(['qwen3-vl-plus']);
    expect(modelsForAssignment(options, 'embeddingModel').map((item) => item.id)).toEqual(['text-embedding-v4']);
    expect(modelsForAssignment(options, 'indexerModel').map((item) => item.id)).toEqual(['indexer-v1']);
  });
});
