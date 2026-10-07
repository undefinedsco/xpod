import { describe, expect, it } from 'vitest';
import { AI_MODEL_CAPABILITY } from '@undefineds.co/models';
import { eligiblePodEmbeddingModels, podCapabilityNames, podModelsForAssignment } from './model-options';

describe('Pod model capability projection', () => {
  const model = (id: string, capabilities: string[]) => ({ id, owner: 'example', ref: id, capabilities });
  it('accepts canonical visual capability URIs and excludes OCR-only models', () => {
    const models = [model('vision-uri', [AI_MODEL_CAPABILITY.vision]), model('vision-name', ['vision']), model('ocr-only', [AI_MODEL_CAPABILITY.ocr])];
    expect(podModelsForAssignment(models, 'ocrModel').map(item => item.id)).toEqual(['vision-uri', 'vision-name']);
  });
  it('filters cloud candidates by the server policy while retaining all local models', () => {
    const candidates = [model('managed', ['embedding']), model('custom', ['embedding'])];
    const allowed = [{ provider: 'example', model: 'managed' }];
    expect(eligiblePodEmbeddingModels(candidates, { restricted: true, allowed }).map(item => item.id)).toEqual(['managed']);
    expect(eligiblePodEmbeddingModels(candidates, { restricted: false, allowed })).toEqual(candidates);
  });
  it('recognizes canonical embedding and document classes capabilities', () => {
    const models = [model('embed', [AI_MODEL_CAPABILITY.embedding]), model('reader', [AI_MODEL_CAPABILITY.document_understanding]), model('legacy-reader', ['document-understanding'])];
    expect(podModelsForAssignment(models, 'embeddingModel').map(item => item.id)).toEqual(['embed']);
    expect(podModelsForAssignment(models, 'readerModel').map(item => item.id)).toEqual(['reader', 'legacy-reader']);
    expect(podCapabilityNames([AI_MODEL_CAPABILITY.embedding])).toEqual(['embedding']);
  });
});
