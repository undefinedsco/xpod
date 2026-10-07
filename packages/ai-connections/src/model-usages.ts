import type { AiConnectionsModelUsage } from '@undefineds.co/extension-sdk/web'

/** Compare resource identities, never an upstream ID shared by several resources. */
export function modelUsageLabels(resourceIds: readonly string[], usages: readonly AiConnectionsModelUsage[]): string[] {
  const ids = new Set(resourceIds)
  return [...new Set(usages.filter(usage => ids.has(usage.resourceId)).map(usage => usage.label))]
}
