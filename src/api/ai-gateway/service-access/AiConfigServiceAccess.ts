import { resolvePodBaseUrl } from '@undefineds.co/drizzle-solid';
import { aiConfigResource } from '@undefineds.co/models';
import { xpodAiConfigResource } from '../../ai-config/XpodAiConfigSchema';

interface PodResourceLocator {
  config?: { base?: string };
  buildId(value: { id: string }): string;
}

/**
 * Return the exact AI configuration documents Xpod may access in a hosted
 * owner's Pod. Both schema resources intentionally share one document; the
 * duplicate entries keep the shared-model and product-model boundaries
 * explicit at each caller's allowlist.
 */
export function createAiConfigResourceUrls(ownerWebId: string): string[] {
  return [aiConfigResource, xpodAiConfigResource].map((resource) => resourceUrl(ownerWebId, resource));
}

function resourceUrl(ownerWebId: string, resource: PodResourceLocator): string {
  const base = resource.config?.base?.replace(/^\/+|\/+$/gu, '');
  if (!base) {
    throw new Error('AI Config resource is missing a declared base');
  }
  const documentPath = resource.buildId({ id: 'config' }).split('#', 1)[0];
  const podRoot = `${resolvePodBaseUrl(ownerWebId).replace(/\/$/u, '')}/`;
  return new URL(`${base}/${documentPath}`.replace(/^\/+/, ''), podRoot).href;
}
