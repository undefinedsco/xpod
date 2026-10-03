import { describe, expect, test } from 'bun:test';
import { aiModelResource } from '@undefineds.co/models';
import { aiConfigModelRef } from '@undefineds.co/models/ai-config';
import { mergeModelCatalog, modelsForAssignment, toAiConfigModelOptions } from './AiConfigContext';

const POD_URL = 'https://storage.example/alice/';
const canonicalRef = (provider: string, model: string) => aiModelResource.buildIri(POD_URL, { id: aiModelResource.parseRef(aiConfigModelRef(provider, model))!.resourceId });

describe('AI Config model options', () => {
  test('derives class capabilities when discovery supplies only the model class', () => {
    const options = toAiConfigModelOptions([{ id: 'embedding', provider: 'example', modelType: 'embedding' }, { id: 'reader', provider: 'example', modelType: 'document_understanding' }, { id: 'declared-chat', provider: 'example', modelType: 'chat' }, { id: 'unknown-chat-name', provider: 'example' }], POD_URL);
    expect(options[0].capabilities).toEqual(['embedding']);
    expect(options[1].capabilities).toEqual(['document_understanding']);
    expect(options[2].capabilities).toEqual(['chat']);
    expect(options[3].capabilities).toEqual([]);
    expect(modelsForAssignment(options, 'chatModel').map(option => option.id)).toEqual(['declared-chat']);
  });
  test('reuses AI Connections models while persisting canonical Pod model references', () => {
    expect(toAiConfigModelOptions([
      { id: 'text-embedding-3-small', provider: 'openai', displayName: 'Embedding Small', capabilities: ['embedding'] },
      { id: 'qwen3-vl-plus', provider: 'bailian', capabilities: ['chat', 'vision', 'ocr', 'document-understanding'] },
    ], POD_URL)).toEqual([
      // The reference shape belongs to the models package, so the expectation is derived from it
      // instead of being a second copy that drifts (audit N19).
      { id: 'text-embedding-3-small', displayName: 'Embedding Small', owner: 'openai', ref: canonicalRef('openai', 'text-embedding-3-small'), capabilities: ['embedding'] },
      { id: 'qwen3-vl-plus', displayName: undefined, owner: 'bailian', ref: canonicalRef('bailian', 'qwen3-vl-plus'), capabilities: ['chat', 'vision', 'ocr', 'document-understanding'] },
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
    ]), POD_URL);

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
    ], POD_URL);
    expect(modelsForAssignment(options, 'ocrModel').map((item) => item.id)).toEqual(['qwen3-vl-plus']);
    expect(modelsForAssignment(options, 'readerModel').map((item) => item.id)).toEqual(['qwen3-vl-plus']);
    expect(modelsForAssignment(options, 'embeddingModel').map((item) => item.id)).toEqual(['text-embedding-v4']);
    expect(modelsForAssignment(options, 'indexerModel').map((item) => item.id)).toEqual(['indexer-v1']);
  });
});
