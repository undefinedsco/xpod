import type {
  AiConfigCapabilities,
  AiConfigLifecycleSnapshot,
  AiConfigModelAssignment,
  AiConfigPolicy,
  AiConfigRebuildTarget,
} from '../../../api/ai-config';

/**
 * Model-assignment decisions, kept out of `ModelAssignmentsPanel.tsx` so that
 * file only exports components: fast refresh cannot preserve state when a module
 * also exports plain functions.
 */

export interface EmbeddingModelSwitch {
  from?: string
  to?: string
}

/**
 * The embedding assignment a user just changed, if any.
 *
 * Only the embedding model invalidates derived vectors, so it is the one
 * assignment whose save has to warn about - and wait for - a rebuild.
 */
export function embeddingModelSwitch(
  values: Partial<Record<AiConfigModelAssignment, string | null>>,
  config?: AiConfigPolicy,
): EmbeddingModelSwitch | undefined {
  // An absent key means "this form never touched the embedding row"; an explicit
  // value - including the null that restores the default - is a switch and has
  // to be confirmed, because it changes which vectors the index holds.
  const next = values.embeddingModel
  if (next === undefined) return undefined
  const current = config?.models?.embeddingModel ?? ''
  return (next ?? '') === current ? undefined : { from: current || undefined, to: next || undefined }
}

/**
 * Whether a rebuild is queued or running right now.
 *
 * A second model switch while the index is being rebuilt would invalidate the
 * rebuild that is already in flight, so the embedding row stays locked until the
 * queue drains. `scheduling` covers the moment between the click and the first
 * lifecycle snapshot.
 */
export function rebuildInFlight(
  lifecycle?: AiConfigLifecycleSnapshot,
  scheduling = false,
): boolean {
  if (scheduling) return true
  const phase = rebuildStatusFrom(lifecycle)?.phase
  return phase === 'queued' || phase === 'running'
}

/** The rebuild target a deployment can run for a model switch. */
export function rebuildTargetForCapabilities(
  capabilities?: AiConfigCapabilities,
): AiConfigRebuildTarget | undefined {
  const targets = capabilities?.rebuildTargets ?? []
  if (targets.includes('vector')) return 'vector'
  if (targets.includes('all')) return 'all'
  return undefined
}

export interface RebuildStatus {
  phase: 'queued' | 'running' | 'succeeded' | 'failed'
  pending: number
  progress?: number
  target?: string
  error?: string
}

/**
 * What to show about the newest rebuild.
 *
 * `pending` is the queue depth the API reports, and the newest job carries the
 * outcome; a page that just scheduled one shows it queued until the queue moves.
 */
export function rebuildStatusFrom(lifecycle?: AiConfigLifecycleSnapshot): RebuildStatus | undefined {
  if (!lifecycle) return undefined
  const newest = lifecycle.recent[0]
  if (!newest) {
    return lifecycle.pending > 0 ? { phase: 'queued', pending: lifecycle.pending } : undefined
  }
  if (newest.status === 'queued' && lifecycle.pending <= 0) return undefined
  return {
    phase: newest.status,
    pending: lifecycle.pending,
    target: newest.target,
    ...(newest.progress !== undefined ? { progress: newest.progress } : {}),
    ...(newest.error ? { error: newest.error } : {}),
  }
}
