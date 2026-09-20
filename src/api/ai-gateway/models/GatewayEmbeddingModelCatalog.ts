import type { EmbeddingModelCatalog } from '../../../ai/service/EmbeddingModelPolicy';
import type { ProviderRegistry } from '../providers/ProviderRegistry';

/**
 * Adapts the ai-gateway provider catalog to the embedding policy.
 *
 * Cloud only provides providers that have a non-local offering: a local-daemon
 * provider such as Ollama would otherwise pin Cloud embedding traffic to the
 * Cloud node's own loopback. The endpoint always comes from the catalog
 * descriptor, which the deployment may override at construction time.
 */
export function createGatewayEmbeddingModelCatalog(
  registry: ProviderRegistry,
  deployment: string,
): EmbeddingModelCatalog {
  const providedInDeployment = (providerId: string): boolean =>
    registry.isProvidedInDeployment(providerId, deployment);

  return {
    isManagedEmbeddingModel(provider: string, modelId: string): boolean {
      const providerId = registry.resolveManagedProviderId(provider);
      if (!providerId || !providedInDeployment(providerId)) {
        return false;
      }
      return registry.isManagedEmbeddingModel(providerId, modelId);
    },
    managedEmbeddingBaseUrl(provider: string): string | undefined {
      const providerId = registry.resolveManagedProviderId(provider);
      if (!providerId || !providedInDeployment(providerId)) {
        return undefined;
      }
      return registry.getProvider(providerId)?.defaultBaseUrl;
    },
  };
}
