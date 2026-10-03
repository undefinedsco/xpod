import { toAIModelCapabilityName, toAIModelCapabilityUri } from '@undefineds.co/models';
import type { AiConfigModelAssignment } from '../../api/ai-config';
import type { AiConfigModelOption } from '../settings/ai-config/AiConfigContext';

/** Model vocab owns URI and adapter-name equivalence; the UI only chooses a workload. */
export function podCapabilityNames(capabilities: string[]): string[] {
  return capabilities.map(value => {
    const uri = toAIModelCapabilityUri(value) ?? toAIModelCapabilityUri(value.toLowerCase().replaceAll('-', '_'));
    return uri ? toAIModelCapabilityName(uri) ?? value : value;
  });
}
export function podModelsForAssignment(models: AiConfigModelOption[], assignment: AiConfigModelAssignment): AiConfigModelOption[] {
  const capability = { chatModel: 'chat', ocrModel: 'vision', readerModel: 'document_understanding', embeddingModel: 'embedding', indexerModel: 'indexing', rerankerModel: 'reranking' }[assignment];
  return models.filter(model => podCapabilityNames(model.capabilities).includes(capability));
}

export function eligiblePodEmbeddingModels(models: AiConfigModelOption[], policy?: { restricted: boolean; allowed: Array<{ provider: string; model: string }> }): AiConfigModelOption[] {
  const embeddings = podModelsForAssignment(models, 'embeddingModel');
  return policy?.restricted ? embeddings.filter(model => policy.allowed.some(allowed => allowed.provider === model.owner && allowed.model === model.id)) : embeddings;
}
