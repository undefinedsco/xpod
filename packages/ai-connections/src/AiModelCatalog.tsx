import { type ReactNode } from 'react'
import {
  Input,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from '@undefineds.co/shared-ui'
import {
  AudioLines,
  Box,
  Boxes,
  Brain,
  FileText,
  Globe,
  Image as ImageIcon,
  Pause,
  Pencil,
  Play,
  Search,
  Trash2,
  Video,
  Zap,
} from 'lucide-react'
import { AiCopyButton } from './AiCopyButton'
import { AiRowAction } from './AiRowAction'

/**
 * Presentation of a model catalog, shared by the provider pages and the Xpod
 * keys page: both list models, so the search box, the inline placeholder and the
 * model rows must stay one implementation.
 */

/**
 * Every capability a model row can show, and the glyph that carries it.
 *
 * This is the single definition of the vocabulary: a row renders a glyph for
 * every token it is given, so a token without an entry here would leave a hole.
 * `modelIconTokens` therefore filters through it. The two lists used to be
 * maintained separately, which is how `embedding` and the non-image input
 * modalities (`pdf`, `audio`, `video`) reached the row with nothing to draw.
 */
export const MODEL_CAPABILITY_PRESENTATION = {
  image: { icon: ImageIcon, label: '视觉识别', className: 'text-green-500' },
  pdf: { icon: FileText, label: '文档输入', className: 'text-teal-500' },
  audio: { icon: AudioLines, label: '音频输入', className: 'text-cyan-500' },
  video: { icon: Video, label: '视频输入', className: 'text-indigo-500' },
  web: { icon: Globe, label: '联网搜索', className: 'text-blue-500' },
  tool_call: { icon: Box, label: '函数调用', className: 'text-orange-500' },
  reasoning: { icon: Brain, label: '推理', className: 'text-purple-500' },
  embedding: { icon: Boxes, label: '向量模型', className: 'text-sky-500' },
  fast: { icon: Zap, label: '快速模型', className: 'text-amber-500' },
} as const

export type ModelCapabilityToken = keyof typeof MODEL_CAPABILITY_PRESENTATION

export function isPresentedCapability(token: string): token is ModelCapabilityToken {
  return Object.prototype.hasOwnProperty.call(MODEL_CAPABILITY_PRESENTATION, token)
}

/**
 * Capability glyph shown beside a model name.
 *
 * Each glyph owns its `TooltipProvider` on purpose. Radix keeps one "pointer in
 * transit" flag per provider and every trigger inside it ignores pointer moves
 * while that flag is set, so a glyph whose tooltip is mid-transit would silently
 * swallow the next hover of any other tooltip in the same provider - including
 * the ⓘ next to the provider name. Isolating the glyphs keeps that state local.
 */
export function CapabilityIcon({ type }: { type: string }) {
  if (!isPresentedCapability(type)) return null
  const capability = MODEL_CAPABILITY_PRESENTATION[type]

  const Icon = capability.icon
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={capability.label}
            className="flex cursor-help items-center justify-center rounded-sm opacity-80 transition-opacity hover:opacity-100 focus:outline-none focus-visible:opacity-100"
          >
            <Icon aria-hidden="true" className={cn('h-3.5 w-3.5', capability.className)} />
          </button>
        </TooltipTrigger>
        <TooltipContent>{capability.label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * Capability tokens for one model row.
 *
 * Both surfaces that list models fold the same two sources, and both used to
 * build the list inline. Duplicates are folded too: a model whose catalog entry
 * declares an `image` input modality *and* `imageInput: true` describes one
 * capability, but the two sources would render it twice under one React key.
 *
 * Tokens outside the vocabulary are dropped here rather than handed to a glyph
 * that would render nothing, so a row never carries a mark it cannot show.
 */
export function modelIconTokens(model: {
  inputModalities?: readonly string[]
  capabilities?: readonly string[]
}): ModelCapabilityToken[] {
  return [...new Set([
    ...(model.inputModalities ?? []).filter((modality) => modality !== 'text'),
    ...(model.capabilities ?? []),
  ])].filter(isPresentedCapability)
}

/**
 * The id a model is listed under, however the Pod stored it.
 *
 * A Pod persists a picked model as the resource it selected, so an entry can
 * arrive with that resource reference where the model id belongs - typically a
 * pinned selection whose document moved to another offering
 * (`…/settings/providers/openai-official-subscription.ttl#gpt-6-astra`). The
 * fragment names the model and the document only says where it is stored, so a
 * reference folds down to the id it names instead of listing that model twice,
 * once as `GPT-6-Astra` and once as a URL-shaped row.
 *
 * `@undefineds.co/models` owns this rule for Pod reads (`normalizeAIConfigModelId`
 * in its `ai-config` module); the catalog repeats just the identity both lists
 * fold on, because this package carries no Pod schema.
 */
export function modelCatalogId(model: { id: string }): string {
  const fragmentIndex = model.id.lastIndexOf('#')
  return fragmentIndex >= 0 ? model.id.slice(fragmentIndex + 1) : model.id
}

/** Fold one entry onto the model id both surfaces list it under. */
export function withCatalogModelId<T extends { id: string }>(model: T): T {
  const id = modelCatalogId(model)
  return id === model.id ? model : { ...model, id }
}

/**
 * Turns one model in a list on or off.
 *
 * A checkbox reads as "pick some of these" and says nothing about what picking
 * does. This is a state with a consequence - the model joins the account's
 * models, or it is withdrawn from the models list endpoint - so it uses the same
 * affordance the credential rows already use for 启用/停用, and names the action.
 */
export function AiModelEnableToggle({
  enabled,
  disabled = false,
  label,
  onToggle,
}: {
  enabled: boolean
  disabled?: boolean
  /** The model name; the action verb is added around it. */
  label: string
  onToggle(): void
}) {
  return (
    <AiRowAction
      label={`${enabled ? '停用' : '启用'} ${label}`}
      disabled={disabled}
      onClick={onToggle}
    >
      {enabled
        ? <Pause aria-hidden="true" className="h-3.5 w-3.5" />
        : <Play aria-hidden="true" className="h-3.5 w-3.5" />}
    </AiRowAction>
  )
}

/** Magnifier-prefixed model search, sat on the right of a model list header. */
export function AiModelSearchInput({ value, onChange }: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="relative w-full sm:w-auto">
      <Search aria-hidden="true" className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="搜索模型..."
        className="h-8 w-full bg-background pl-8 text-xs sm:w-[232px]"
        autoComplete="off"
        data-lpignore="true"
        data-1p-ignore
      />
    </div>
  )
}

/** Inline placeholder used when a model list has nothing to show. */
export function AiModelEmptyPanel({ tone, children }: {
  tone?: 'destructive'
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      {tone === 'destructive' ? <p className="text-destructive">{children}</p> : children}
    </div>
  )
}

/**
 * One model row, as every list of models renders it.
 *
 * This is the component both surfaces use. They used to assemble `AiModelTile`
 * themselves - each with its own leading control, its own badges and its own
 * spacing - which is exactly how one list drifted away from the other. A caller
 * supplies the model, the switch state and any per-row extras; the row itself
 * is decided here.
 */
export function AiModelRow({
  label,
  modelId,
  iconTokens = [],
  enabled,
  toggleDisabled = false,
  onToggle,
  onEdit,
  onDelete,
  unavailable = false,
  badges,
}: {
  label: string
  modelId?: string
  iconTokens?: string[]
  /** The model is on: it is joined to the account and published to clients. */
  enabled: boolean
  toggleDisabled?: boolean
  /** Omit for a list that cannot be switched. */
  onToggle?: () => void
  onEdit?: () => void
  onDelete?: () => void
  unavailable?: boolean
  badges?: ReactNode
}) {
  // The action order is the credential rows' order - edit, 启用/停用, delete - so
  // the same gesture sits in the same place wherever a row is switched on or off.
  const hasActions = Boolean(onToggle || onEdit || onDelete)
  return (
    <AiModelTile
      label={label}
      modelId={modelId}
      iconTokens={iconTokens}
      selected={enabled}
      unavailable={unavailable}
      badges={badges}
      actions={hasActions ? (
        <div className="flex shrink-0 items-center gap-1">
          {onEdit ? (
            <AiRowAction label={`编辑 ${label}`} disabled={toggleDisabled} onClick={onEdit}>
              <Pencil aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
            </AiRowAction>
          ) : null}
          {onToggle ? (
            <AiModelEnableToggle
              enabled={enabled}
              disabled={toggleDisabled}
              label={label}
              onToggle={onToggle}
            />
          ) : null}
          {onDelete ? (
            <AiRowAction label={`删除 ${label}`} disabled={toggleDisabled} onClick={onDelete}>
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
            </AiRowAction>
          ) : null}
        </div>
      ) : undefined}
    />
  )
}

/**
 * One model row. `leading` carries the provider page's selection checkbox and
 * `actions` its edit/delete buttons; a read-only list passes neither.
 */
export function AiModelTile({
  label,
  modelId,
  iconTokens = [],
  badges,
  leading,
  actions,
  selected = false,
  unavailable = false,
}: {
  label: string
  modelId?: string
  iconTokens?: string[]
  badges?: ReactNode
  leading?: ReactNode
  actions?: ReactNode
  selected?: boolean
  unavailable?: boolean
}) {
  return (
    <div
      className={cn(
        'group flex items-center gap-3 rounded-lg border bg-card p-3 transition-all duration-200 hover:border-border/60 hover:bg-accent/30',
        selected ? 'border-primary/40 bg-primary/[0.03]' : 'border-border/40',
        unavailable && 'opacity-75',
      )}
    >
      {leading}
      <div className="shrink-0 rounded bg-muted/50 p-2 text-muted-foreground transition-colors group-hover:text-primary">
        <Box aria-hidden="true" className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground/90">{label}</span>
          <div className="flex items-center gap-1">
            {iconTokens.map((token) => <CapabilityIcon key={token} type={token} />)}
          </div>
          {badges}
        </div>
        {modelId && modelId !== label ? (
          <div className="mt-0.5 flex items-center gap-1.5">
            <code className="max-w-[300px] truncate font-mono text-[10px] text-muted-foreground opacity-70">{modelId}</code>
            <AiCopyButton
              value={modelId}
              label={`${label} ID`}
              title="复制 ID"
              variant="ghost"
              size="icon"
              className="h-4 w-4 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100"
              iconClassName="h-3 w-3"
              copiedIconClassName="text-primary"
            />
          </div>
        ) : null}
      </div>
      {actions}
    </div>
  )
}
