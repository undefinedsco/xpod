import { useId, useState, type ReactNode } from 'react'
import { AlertCircle, AlertTriangle, ChevronRight, Loader2, Plus, X } from 'lucide-react'
import { cn } from './utils'

export type LoginBadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger'

export interface LoginBadge {
  label: string
  tone: LoginBadgeTone
}

export interface LoginProviderOption {
  id: string
  label: string
  subtitle?: string
  badge?: LoginBadge
  actionLabel?: string
  disabled?: boolean
  connecting?: boolean
}

const badgeToneClassNames: Record<LoginBadgeTone, string> = {
  neutral: 'border-border/60 bg-muted/40 text-muted-foreground',
  primary: 'border-primary/20 bg-primary/5 text-primary',
  success: 'border-green-500/20 bg-green-500/10 text-green-600',
  warning: 'border-amber-500/20 bg-amber-500/10 text-amber-600',
  danger: 'border-destructive/20 bg-destructive/10 text-destructive',
}

export function LoginCardShell({
  children,
  ariaLabel,
  overlayClassName,
  cardClassName,
  cardSize = 'compact',
}: {
  children: ReactNode
  ariaLabel: string
  overlayClassName?: string
  cardClassName?: string
  cardSize?: 'compact' | 'auto'
}) {
  const baseCardClassName = cardSize === 'auto'
    ? 'w-[280px] overflow-hidden rounded-xl border border-border/50 bg-card flex flex-col'
    : 'w-[280px] h-[400px] overflow-hidden rounded-xl border border-border/50 bg-card flex flex-col'

  return (
    <div
      className={cn('fixed inset-0 z-[999] flex items-center justify-center bg-black/50', overlayClassName)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-login-card-size={cardSize}
        className={cn(baseCardClassName, cardClassName)}
      >
        {children}
      </div>
    </div>
  )
}

export function LoginErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null | undefined
  onDismiss?: () => void
}) {
  if (!error) return null
  return (
    <div role="alert" className="mx-5 mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
      <p className="flex-1 text-xs leading-relaxed text-destructive">{error}</p>
      {onDismiss ? (
        <button
          type="button"
          aria-label="关闭错误提示"
          onClick={onDismiss}
          className="shrink-0 cursor-pointer text-destructive/60 hover:text-destructive"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

export function LoginAvatar({
  name,
  avatarUrl,
  size = 'lg',
  marker,
}: {
  name: string
  avatarUrl?: string
  size?: 'md' | 'lg'
  marker?: ReactNode
}) {
  const sizeClassName = size === 'lg' ? 'h-16 w-16 text-xl' : 'h-10 w-10 text-sm'
  return (
    <div className="relative shrink-0">
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={name}
          className={cn(sizeClassName, 'rounded-full border border-border/50 object-cover')}
        />
      ) : (
        <div
          aria-hidden="true"
          className={cn(sizeClassName, 'flex items-center justify-center rounded-full border border-border/50 bg-muted font-semibold text-muted-foreground')}
        >
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
      {marker ? (
        <div className="absolute -bottom-1 -right-1">{marker}</div>
      ) : null}
    </div>
  )
}

export function LoginRestoringView({
  accountName,
  avatarUrl,
  label = '正在恢复登录状态...',
}: {
  accountName?: string
  avatarUrl?: string
  label?: string
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6" role="status">
      {accountName ? (
        <>
          <LoginAvatar name={accountName} avatarUrl={avatarUrl} size="lg" />
          <p className="text-sm font-medium text-foreground">{accountName}</p>
        </>
      ) : null}
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

export function LoginConnectingView({
  title = '正在连接',
  detail = '请稍候...',
  providerLabel,
  providerHost,
  onCancel,
}: {
  title?: string
  detail?: string
  providerLabel?: string
  providerHost?: string
  onCancel?: () => void
}) {
  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-8 text-center" role="status">
        <Loader2 className="mb-4 h-8 w-8 animate-spin text-primary" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
        {providerLabel || providerHost ? (
          <div className="mt-4 w-full max-w-[18rem] rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
            {providerLabel ? (
              <p className="truncate text-xs font-medium text-foreground">{providerLabel}</p>
            ) : null}
            {providerHost ? (
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{providerHost}</p>
            ) : null}
          </div>
        ) : null}
      </div>
      {onCancel ? (
        <div className="shrink-0 px-5 pb-5">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 w-full cursor-pointer rounded-md text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            取消
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function LoginAccountView({
  name,
  avatarUrl,
  bindingLabel,
  expired = false,
  expiredTitle = '会话已过期',
  expiredDescription,
  enterLabel = '进入',
  switchLabel = '切换账号',
  error,
  onDismissError,
  onEnter,
  onSwitchAccount,
}: {
  name: string
  avatarUrl?: string
  bindingLabel?: string
  expired?: boolean
  expiredTitle?: string
  expiredDescription?: string
  enterLabel?: string
  switchLabel?: string
  error?: string | null
  onDismissError?: () => void
  onEnter: () => void
  onSwitchAccount?: () => void
}) {
  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-5 py-8">
        {expired ? (
          <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/5 px-2.5 py-1 text-[11px] font-medium text-primary">
            <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
            {expiredTitle}
          </div>
        ) : null}
        <LoginAvatar name={name} avatarUrl={avatarUrl} size="lg" />
        <div className="space-y-1 text-center">
          <p className="text-base font-semibold text-foreground">{name}</p>
          {bindingLabel ? <p className="text-xs text-muted-foreground">{bindingLabel}</p> : null}
        </div>
        {expired && expiredDescription ? (
          <p className="max-w-[18rem] text-center text-xs leading-5 text-muted-foreground">{expiredDescription}</p>
        ) : null}
      </div>

      {!expired ? <LoginErrorBanner error={error} onDismiss={onDismissError} /> : null}

      <div className="shrink-0 space-y-2 px-5 pb-5 pt-2">
        <button
          type="button"
          onClick={onEnter}
          className="h-9 w-full cursor-pointer rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {enterLabel}
        </button>
        {onSwitchAccount ? (
          <button
            type="button"
            onClick={onSwitchAccount}
            className="h-9 w-full cursor-pointer rounded-md text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            {switchLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function normalizeLoginProviderUrl(value: string): string {
  const trimmed = value.trim()
  const candidate = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`
  const parsed = new URL(candidate)
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    throw new Error('Unsupported provider URL')
  }
  return candidate
}

export function LoginFailureView({
  title = '登录未完成',
  description,
  primaryLabel = '重试登录',
  onPrimary,
  secondaryLabel,
  onSecondary,
}: {
  title?: string
  description?: string | null
  primaryLabel?: string
  onPrimary: () => void
  secondaryLabel?: string
  onSecondary?: () => void
}) {
  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 pb-5 pt-7 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-6 w-6 text-destructive" aria-hidden="true" />
        </div>
        <p className="text-base font-semibold text-foreground">{title}</p>
        {description ? (
          <p className="max-w-[19rem] text-sm leading-6 text-muted-foreground" role="alert">
            {description}
          </p>
        ) : null}
      </div>
      <div className="shrink-0 space-y-2 px-4 pb-5">
        <button
          type="button"
          onClick={onPrimary}
          className="h-9 w-full cursor-pointer rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {primaryLabel}
        </button>
        {secondaryLabel && onSecondary ? (
          <button
            type="button"
            onClick={onSecondary}
            className="h-9 w-full cursor-pointer rounded-md border border-border/60 bg-muted/30 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
          >
            {secondaryLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function LoginStorageConflictView({
  eyebrow,
  accountName,
  avatarUrl,
  description,
  expectedLabel = '当前空间应写入',
  expectedValue,
  actualLabel = '账号当前绑定',
  actualValue,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
}: {
  eyebrow: string
  accountName: string
  avatarUrl?: string
  description: string
  expectedLabel?: string
  expectedValue: string
  actualLabel?: string
  actualValue?: string
  primaryLabel?: string
  onPrimary?: () => void
  secondaryLabel: string
  onSecondary: () => void
}) {
  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="shrink-0 px-5 pb-4 pt-6">
        <p className="text-center text-[11px] font-medium tracking-wide text-muted-foreground/70">
          {eyebrow}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-center justify-center gap-3 px-5 pb-4">
        <LoginAvatar name={accountName} avatarUrl={avatarUrl} size="lg" />
        <p className="text-base font-semibold text-foreground">{accountName}</p>
        <p className="max-w-[19rem] text-center text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>

      <div className="mx-4 space-y-3 rounded-lg border border-border/60 bg-muted/25 p-4">
        <StorageDetail label={expectedLabel} value={expectedValue} />
        <StorageDetail label={actualLabel} value={actualValue ?? '未绑定'} />
      </div>

      <div className="mt-auto space-y-2 px-4 pb-4 pt-5">
        {primaryLabel && onPrimary ? (
          <button
            type="button"
            onClick={onPrimary}
            className="h-9 w-full cursor-pointer rounded-md border border-border/60 bg-muted/30 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
          >
            {primaryLabel}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onSecondary}
          className="h-9 w-full cursor-pointer rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {secondaryLabel}
        </button>
      </div>
    </div>
  )
}

function StorageDetail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground/70">{label}</p>
      <div className="mt-1 break-all rounded-lg border border-border/50 bg-background/70 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        {value}
      </div>
    </div>
  )
}

export function LoginProviderListView({
  title = '更多选项',
  providers,
  error,
  addLabel = '添加登录方式',
  addPlaceholder = 'https://pod.example.com',
  connectingId,
  onBack,
  onConnect,
  onAddProvider,
  onDismissError,
}: {
  title?: string
  providers: LoginProviderOption[]
  error?: string | null
  addLabel?: string
  addPlaceholder?: string
  connectingId?: string
  onBack?: () => void
  onConnect: (providerId: string) => void
  onAddProvider?: (url: string) => void
  onDismissError?: () => void
}) {
  const [isAdding, setIsAdding] = useState(false)
  const [customUrl, setCustomUrl] = useState('')
  const [customUrlError, setCustomUrlError] = useState<string | null>(null)
  const errorId = useId()

  const handleAdd = () => {
    if (!customUrl.trim() || !onAddProvider) return
    try {
      const normalized = normalizeLoginProviderUrl(customUrl)
      onAddProvider(normalized)
      setCustomUrl('')
      setCustomUrlError(null)
      setIsAdding(false)
    } catch {
      setCustomUrlError('请输入有效的 http(s) 地址。')
    }
  }

  return (
    <div className="flex h-full flex-1 flex-col px-5 py-5">
      {onBack ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            aria-label="返回"
            className="-ml-2 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            返回
          </button>
        </div>
      ) : null}
      <h2 className="mt-3 text-base font-semibold text-foreground">{title}</h2>

      <LoginErrorBanner error={error} onDismiss={onDismissError} />

      <div className="mt-4 flex-1 space-y-2 overflow-y-auto">
        {providers.map((provider) => {
          const connecting = connectingId === provider.id || provider.connecting === true
          return (
            <button
              key={provider.id}
              type="button"
              disabled={provider.disabled || connecting}
              onClick={() => onConnect(provider.id)}
              className="w-full cursor-pointer rounded-lg border border-border/60 bg-muted/20 px-3 py-3 text-left transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">{provider.label}</p>
                    {provider.badge ? (
                      <span
                        className={cn(
                          'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                          badgeToneClassNames[provider.badge.tone],
                        )}
                      >
                        {provider.badge.label}
                      </span>
                    ) : null}
                  </div>
                  {provider.subtitle ? (
                    <p className="mt-1 truncate text-xs text-muted-foreground">{provider.subtitle}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {connecting ? (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
                  ) : provider.actionLabel ? (
                    <span className="text-xs font-medium text-primary">{provider.actionLabel}</span>
                  ) : null}
                  <ChevronRight className="h-4 w-4 text-muted-foreground/60" aria-hidden="true" />
                </div>
              </div>
            </button>
          )
        })}
        {providers.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">暂无可用登录方式</p>
        ) : null}
      </div>

      {onAddProvider ? (
        <div className="mt-4 space-y-2">
          {isAdding ? (
            <div className="space-y-2">
              <input
                autoFocus
                type="url"
                aria-label="登录方式地址"
                aria-invalid={customUrlError ? true : undefined}
                aria-describedby={customUrlError ? errorId : undefined}
                placeholder={addPlaceholder}
                value={customUrl}
                onChange={(event) => {
                  setCustomUrl(event.target.value)
                  setCustomUrlError(null)
                }}
                onKeyDown={(event) => event.key === 'Enter' && handleAdd()}
                className="h-9 w-full rounded-lg border border-border/60 bg-background px-3 text-sm focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              {customUrlError ? (
                <p id={errorId} role="alert" className="flex items-center gap-1.5 text-left text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {customUrlError}
                </p>
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={!customUrl.trim()}
                  className="h-8 rounded-md bg-primary text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  连接
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsAdding(false)
                    setCustomUrl('')
                    setCustomUrlError(null)
                  }}
                  className="h-8 rounded-md border border-border/50 text-xs text-muted-foreground hover:text-foreground"
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsAdding(true)}
              className="flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {addLabel}
            </button>
          )}
        </div>
      ) : null}
    </div>
  )
}
