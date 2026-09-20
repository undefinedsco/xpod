/**
 * What kind of model an upstream `/models` entry is, as Xpod records it.
 *
 * Discovery answers exactly one question the product acts on: is this an
 * embedding model, or is it a chat model? Embedding is the value the embedding
 * allowlist filters on and the one the settings list marks with a glyph, and the
 * Pod stores such a row as `EmbeddingModel`; everything else is a chat model.
 *
 * The vocabulary is deliberately this short. A Pod row's class has to be one the
 * shared schema knows (`toAIModelClassUri` in `@undefineds.co/models`); a third
 * value invented here - `other`, `audio` - makes the AI config write throw
 * `Unsupported AI model class`, so a synced list would stop being writable. Any
 * finer distinction belongs to a model's capabilities, not to this column.
 *
 * Both discovery paths read the same provider payloads - the adapters behind
 * `POST …/models/refresh` (同步模型) and the per-provider discovery adapters
 * behind the selection service - so the rule lives here once and both import it.
 */
export type DiscoveredProviderModelType = 'chat' | 'embedding';

/**
 * Model type for one upstream entry.
 *
 * An explicit field the provider sends wins; otherwise the id is the only
 * evidence available, and embeddings are the one kind that must never be missed:
 * the embedding allowlist filters on this value, so a missed embedding model
 * disappears from model management.
 */
export function inferProviderModelType(
  record: Record<string, unknown>,
  id: string,
): DiscoveredProviderModelType {
  if (explicitProviderModelType(record) === 'embedding') {
    return 'embedding';
  }
  return /(?:embedding|embed)/u.test(id.toLowerCase()) ? 'embedding' : 'chat';
}

/** The kind the provider payload itself declares, when it declares one. */
function explicitProviderModelType(
  record: Record<string, unknown>,
): DiscoveredProviderModelType | undefined {
  for (const value of [record.modelType, record.model_type, record.type, record.object, record.category]) {
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === 'model') {
      continue;
    }
    if (/(?:embedding|embed)/u.test(normalized)) {
      return 'embedding';
    }
  }
  return undefined;
}
