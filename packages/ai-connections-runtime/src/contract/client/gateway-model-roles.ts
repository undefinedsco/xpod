/** Platform routing roles published by the Gateway, independent of Pod model resources. */
export const PLATFORM_MODEL_ROLES = {
  smart: { id: 'linx' },
  fast: { id: 'linx-lite' },
} as const

/** Match only the Gateway's published bare IDs or its existing protocol namespace. */
export function matchesPlatformModelRole(modelId: string, role: keyof typeof PLATFORM_MODEL_ROLES): boolean {
  const normalized = modelId.toLowerCase()
  const id = PLATFORM_MODEL_ROLES[role].id
  return normalized === id || normalized === `undefineds/${id}`
}
