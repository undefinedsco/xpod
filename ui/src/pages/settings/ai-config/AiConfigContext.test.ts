import { describe, expect, test } from 'bun:test';
import { mergeModelCatalog, modelsForAssignment, toAiConfigModelOptions } from './AiConfigContext';

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

  test('offers an embedding model the Pod catalog holds even when routing publishes it not', () => {
    // 只选了聊天模型的账号，路由投影里没有向量模型；Pod 目录里有。embedding
    // 角色必须能看到它，否则这个 Pod 会因为“没选过向量模型”而丢掉索引能力。
    const options = toAiConfigModelOptions(mergeModelCatalog([
      { id: 'openai.ttl#gpt-5', provider: 'openai', displayName: 'GPT-5', modelType: 'chat' },
      { id: 'openai.ttl#text-embedding-3-small', provider: 'openai', modelType: 'embedding', capabilities: ['embedding'] },
    ], [
      { id: 'gpt-5', provider: 'openai', displayName: 'GPT-5', capabilities: ['chat', 'tool_call', 'reasoning'] },
    ]));

    expect(options.map((option) => option.id)).toEqual(['gpt-5', 'text-embedding-3-small']);
    expect(modelsForAssignment(options, 'embeddingModel').map((option) => option.id))
      .toEqual(['text-embedding-3-small']);
    // 同一模型的两种来源折成一条：投影的能力标记与 Pod 的类型都在。
    expect(options[0]?.capabilities).toEqual(['chat', 'tool_call', 'reasoning']);
    expect(options[0]?.ref.endsWith('providers/openai.ttl#gpt-5')).toBe(true);
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
