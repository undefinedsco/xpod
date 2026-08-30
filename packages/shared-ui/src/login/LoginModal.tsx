import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2, Plus, X, AlertCircle, ChevronRight, HardDrive, Globe2, ArrowLeft, Link2 } from 'lucide-react'
import { isLocalAccessHostname } from './local-access-url'
import { cn } from '../utils'
import type { LoginModalProps, LoginProviderOption } from './types'
import {
  getProviderDisplayLabel,
} from './presentation'
import { resolveLoginProviderSource } from './provider-model'
import { LoginCardShell } from '../login'
import { formatLoginErrorForUser } from './error-messages'
import { LocalReachabilitySummary } from './LocalReachabilitySummary'

/** LinX product login modal. Xpod does not render this component. */
export function LoginModal(props: LoginModalProps) {
  const { state, storageConflict, view } = props

  if (state === 'authenticated' && !storageConflict) return null

  return (
    <LoginCardShell
      ariaLabel={props.ariaLabel ?? 'Sign in'}
      overlayClassName={props.overlayClassName}
      cardClassName={props.cardClassName}
      cardSize="compact"
    >
      {storageConflict ? (
        <StorageConflictView
          storedAccount={props.storedAccount}
          storageConflict={storageConflict}
          onDismiss={props.onDismissStorageConflict}
          onOpenCurrentSpacePodSetup={props.onOpenCurrentSpacePodSetup}
        />
      ) : state === 'restoring' ? (
        <RestoringView storedAccount={props.storedAccount} />
      ) : state === 'connecting' ? (
        <ConnectingView
          authWindowStatus={props.authWindowStatus}
          connectingProvider={props.connectingProvider}
          onCancel={props.onCancelConnecting}
        />
      ) : view === 'local' ? (
        <LocalOnboardingView
          localOnboarding={props.localOnboarding}
          localProviderSource={props.localProviderSource}
          error={props.error}
          onBack={props.onBackFromLocal}
          onContinue={props.onContinueLocalLogin}
          onSwitchAccount={props.onSwitchAccount}
          onTestConnectivity={props.onTestLocalConnectivity}
          onOpenSettings={props.onOpenLocalSettings}
          onClearError={props.onClearError}
        />
      ) : props.storedAccount ? (
        <AccountView
          storedAccount={props.storedAccount}
          hasRestorableSession={props.hasRestorableSession}
          onContinueStoredAccount={props.onContinueStoredAccount}
          onSwitchAccount={props.onSwitchAccount}
          error={props.error}
          onClearError={props.onClearError}
        />
      ) : (
        <ProviderSelectionView
          providers={props.providers}
          error={props.error}
          localLoginStatus={props.localLoginStatus}
          onConnect={props.onConnect}
          onAddProvider={props.onAddProvider}
          onClearError={props.onClearError}
          brand={props.brand}
          capabilities={props.capabilities}
        />
      )}
    </LoginCardShell>
  )
}

function StorageConflictView({
  storedAccount,
  storageConflict,
  onDismiss,
  onOpenCurrentSpacePodSetup,
}: {
  storedAccount: LoginModalProps['storedAccount']
  storageConflict: NonNullable<LoginModalProps['storageConflict']>
  onDismiss: () => void
  onOpenCurrentSpacePodSetup: () => void
}) {
  const accountName = storedAccount?.displayName || '当前账号'
  const canCreateHere = Boolean(storageConflict.setupUrl ?? storageConflict.managementUrl)
  const isCreatePodSetup = storageConflict.setupKind === 'create-pod'

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="px-5 pt-6 pb-4 shrink-0">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground/70 text-center">
          {isCreatePodSetup ? '需要创建空间' : '空间不匹配'}
        </p>
      </div>

      <div className="px-5 pb-4 flex flex-col items-center justify-center gap-3 shrink-0">
        <AccountAvatar
          name={accountName}
          avatarUrl={storedAccount?.avatarUrl}
          size="lg"
          spaceMarker={resolveStoredAccountSpaceMarker(storedAccount)}
        />
        <p className="text-base font-semibold text-foreground">{accountName}</p>
        <p className="max-w-[19rem] text-center text-sm leading-6 text-muted-foreground">
          {isCreatePodSetup
            ? '这个账号还没有完成当前本地空间的创建。创建完成后即可把数据保存在这里。'
            : '当前账号绑定的是另一个空间。请返回后重新选择正确空间，或先在当前空间完成创建。'}
        </p>
      </div>

      <div className="mx-4 space-y-3 rounded-2xl border border-border/60 bg-muted/25 p-4">
        <StorageDetail label="当前空间应写入" value={storageConflict.expectedStorageUrl} />
        <StorageDetail label="账号当前绑定" value={storageConflict.actualStorageUrl ?? '未绑定'} />
      </div>

      <div className="mt-auto px-4 pb-4 pt-5 space-y-2">
        {canCreateHere ? (
          <button
            type="button"
            onClick={onOpenCurrentSpacePodSetup}
            className="w-full h-10 rounded-xl border border-border/60 bg-muted/30 text-sm font-medium text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
          >
            {isCreatePodSetup ? '创建当前空间' : '在当前空间创建'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          className="w-full h-10 rounded-xl bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
        >
          返回登录并重新选择空间
        </button>
      </div>

      <Footer />
    </div>
  )
}

// ── RestoringView ─────────────────────────────────────────────────────

function RestoringView({ storedAccount }: Pick<LoginModalProps, 'storedAccount'>) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 gap-4">
      {storedAccount ? (
        <>
          <AccountAvatar
            name={storedAccount.displayName}
            avatarUrl={storedAccount.avatarUrl}
            size="lg"
            spaceMarker={resolveStoredAccountSpaceMarker(storedAccount)}
          />
          <p className="text-sm font-medium text-foreground">{storedAccount.displayName}</p>
        </>
      ) : null}
      <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
      <p className="text-xs text-muted-foreground">正在恢复登录状态...</p>
    </div>
  )
}

// ── AccountView（微信式：头像 + 姓名 + 进入） ─────────────────────────

function AccountView({
  storedAccount,
  hasRestorableSession,
  onContinueStoredAccount,
  onSwitchAccount,
  error,
  onClearError,
}: {
  storedAccount: NonNullable<LoginModalProps['storedAccount']>
  hasRestorableSession: boolean
  onContinueStoredAccount: () => void
  onSwitchAccount: () => void
  error: string | null
  onClearError: () => void
}) {
  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="flex-1 px-5 py-8 flex flex-col items-center justify-center gap-4">
        <AccountAvatar
          name={storedAccount.displayName}
          avatarUrl={storedAccount.avatarUrl}
          size="lg"
          spaceMarker={resolveStoredAccountSpaceMarker(storedAccount)}
        />
        <div className="space-y-1 text-center">
          <p className="text-base font-semibold text-foreground">{storedAccount.displayName}</p>
          <p className="text-xs text-muted-foreground">{getRememberedAccountBindingLabel(storedAccount)}</p>
        </div>
      </div>

      <ErrorBanner error={error} onClearError={onClearError} />

      <div className="px-5 pb-5 pt-2 space-y-2 shrink-0">
        <button
          onClick={onContinueStoredAccount}
          className="w-full h-10 rounded-xl bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
        >
          {hasRestorableSession ? `继续使用 ${storedAccount.displayName}` : `重新登录 ${storedAccount.displayName}`}
        </button>
        <button
          onClick={onSwitchAccount}
          className="w-full h-9 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors cursor-pointer"
        >
          切换账号
        </button>
      </div>

      <Footer />
    </div>
  )
}

// ── ProviderSelectionView ─────────────────────────────────────────────

function ProviderSelectionView({
  providers,
  error,
  localLoginStatus,
  onConnect,
  onAddProvider,
  onClearError,
  brand,
  capabilities,
}: {
  providers: LoginProviderOption[]
  error: string | null
  localLoginStatus: LoginModalProps['localLoginStatus']
  onConnect: (providerKey: string) => void
  onAddProvider: (url: string, label?: string) => void
  onClearError: () => void
  brand: ReactNode
  capabilities: LoginModalProps['capabilities']
}) {
  const [view, setView] = useState<'main' | 'providers'>('main')
  const [selectedSpace, setSelectedSpace] = useState<'cloud' | 'local'>('cloud')
  const cloudProvider = providers.find((provider) => resolveLoginProviderSource(provider) === 'cloud')
  const localProvider = providers.find((provider) => resolveLoginProviderSource(provider) === 'local')
  const selectedProvider = selectedSpace === 'local' ? (localProvider ?? cloudProvider) : cloudProvider

  if (view === 'providers') {
    return (
      <ConfiguredProviderList
        providers={providers}
        onConnect={onConnect}
        onAddProvider={onAddProvider}
        onBack={() => setView('main')}
        allowProviderAddition={capabilities?.providerAddition !== false}
      />
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full px-7 py-7 text-center">
      <div className="flex-1 flex flex-col items-center justify-center gap-5">
        {brand ?? (
          <>
            <div className="flex h-14 w-14 items-center justify-center rounded-[18%] border border-border/60 bg-muted/40 shadow-sm">
              <Globe2 className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            </div>
            <div className="space-y-2">
              <h2 className="text-lg font-semibold text-foreground">登录</h2>
            </div>
          </>
        )}

        {capabilities?.storageSelection !== false ? (
          <div className="w-full space-y-2">
            <p className="text-xs font-medium text-muted-foreground">数据保存位置</p>
            <div className="grid grid-cols-2 rounded-xl border border-border/70 bg-muted/30 p-1">
              <button
                type="button"
                onClick={() => setSelectedSpace('cloud')}
                className={segmentClass(selectedSpace === 'cloud')}
              >
                云端
              </button>
              <button
                type="button"
                onClick={() => setSelectedSpace('local')}
                className={segmentClass(selectedSpace === 'local')}
              >
                本机
              </button>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {selectedSpace === 'local' ? '数据保存在这台电脑。' : '数据同步到云端。'}
            </p>
          </div>
        ) : null}

        {localLoginStatus.active ? (
          <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <p className="text-xs text-muted-foreground">正在启动本机空间…</p>
          </div>
        ) : null}
      </div>

      <ErrorBanner error={error} onClearError={onClearError} />

      <div className="shrink-0 space-y-2">
        <button
          type="button"
          disabled={!selectedProvider}
          onClick={() => selectedProvider && onConnect(selectedProvider.id)}
          className="w-full h-11 rounded-xl bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
        >
          继续
        </button>
        {capabilities?.additionalProviders !== false ? (
          <button
            type="button"
            onClick={() => setView('providers')}
            className="w-full h-9 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors cursor-pointer"
          >
            其他账号供应商
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ConfiguredProviderList({
  providers,
  onConnect,
  onAddProvider,
  onBack,
  allowProviderAddition,
}: {
  providers: LoginProviderOption[]
  onConnect: (providerKey: string) => void
  onAddProvider: (url: string, label?: string) => void
  onBack: () => void
  allowProviderAddition: boolean
}) {
  const [selectedProvider, setSelectedProvider] = useState<LoginProviderOption | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [customUrl, setCustomUrl] = useState('')
  const configuredProviders = providers.filter((provider) => resolveLoginProviderSource(provider) === 'custom')

  const handleAdd = () => {
    if (!customUrl.trim()) return
    try {
      const normalized = customUrl.startsWith('http') ? customUrl : `https://${customUrl}`
      new URL(normalized)
      onAddProvider(normalized)
      onConnect(normalized)
      setCustomUrl('')
      setIsAdding(false)
    } catch {
      // Keep the compact modal quiet; validation UX belongs to the provider settings surface.
    }
  }

  if (selectedProvider) {
    return (
      <div className="flex-1 flex flex-col h-full px-7 py-7 text-center">
        <button
          type="button"
          onClick={() => setSelectedProvider(null)}
          className="-ml-2 inline-flex h-8 w-fit items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
        >
          <ArrowLeft className="h-4 w-4" />
          更换供应商
        </button>
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/30">
            <Globe2 className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">使用 {selectedProvider.label} 登录</h2>
            <p className="text-sm text-muted-foreground">此供应商不支持本机空间选择</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onConnect(selectedProvider.id)}
          className="w-full h-11 rounded-xl bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
        >
          继续
        </button>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full px-5 py-5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
          aria-label="返回登录"
        >
          <ArrowLeft className="h-4 w-4" />
          返回
        </button>
      </div>
      <h2 className="mt-3 text-base font-semibold text-foreground">其他账号供应商</h2>
      <div className="mt-4 flex-1 space-y-2 overflow-y-auto">
        {configuredProviders.length === 0 && !isAdding ? (
          <p className="px-3 py-3 text-center text-xs text-muted-foreground">暂无其他已配置供应商</p>
        ) : null}
        {configuredProviders.map((provider) => (
          <button
            key={provider.id}
            type="button"
            onClick={() => setSelectedProvider(provider)}
            className="w-full rounded-xl border border-border/60 bg-muted/20 px-3 py-3 text-left hover:bg-muted/40 transition-colors cursor-pointer"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">{getProviderDisplayLabel(provider)}</p>
                <p className="mt-1 text-xs text-muted-foreground">已配置</p>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground/60" aria-hidden="true" />
            </div>
          </button>
        ))}
      </div>
      <div className="mt-4 space-y-2">
        {isAdding ? (
          <div className="space-y-2">
            <input
              autoFocus
              type="url"
              placeholder="https://pod.example.com"
              value={customUrl}
              onChange={(event) => setCustomUrl(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && handleAdd()}
              className="w-full h-9 px-3 text-sm border border-border/60 rounded-lg bg-background focus:outline-none focus:border-primary/50"
            />
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleAdd}
                disabled={!customUrl.trim()}
                className="h-8 rounded-lg bg-primary text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                连接
              </button>
              <button
                type="button"
                onClick={() => { setIsAdding(false); setCustomUrl('') }}
                className="h-8 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground"
              >
                取消
              </button>
            </div>
          </div>
        ) : allowProviderAddition ? (
          <button
            type="button"
            onClick={() => setIsAdding(true)}
            className="w-full h-9 flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            + 添加供应商
          </button>
        ) : null}
      </div>
    </div>
  )
}

function segmentClass(selected: boolean): string {
  return cn(
    'h-9 rounded-lg text-sm font-medium transition-colors cursor-pointer',
    selected ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
  )
}

// ── ConnectingView ────────────────────────────────────────────────────

function ConnectingView({
  authWindowStatus,
  connectingProvider,
  onCancel,
}: {
  authWindowStatus: LoginModalProps['authWindowStatus']
  connectingProvider: LoginModalProps['connectingProvider']
  onCancel: () => void
}) {
  let title = '正在连接'
  let detail = connectingProvider
    ? '正在打开登录页'
    : '请稍候...'

  if (authWindowStatus.open) {
    title = '等待登录完成'
    detail = '请在登录窗口完成'
  } else if (authWindowStatus.reason === 'completed') {
    title = '正在验证身份'
    detail = connectingProvider?.storageProviderLabel ? '正在进入所选空间' : detail
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-8 text-center">
        <Loader2 className="w-8 h-8 text-primary animate-spin mb-4" />
        <p className="text-sm text-foreground font-medium">{title}</p>
        <p className="text-xs text-muted-foreground mt-1">{detail}</p>
        {connectingProvider ? (
          <div className="mt-4 w-full max-w-[18rem] rounded-2xl border border-border/60 bg-muted/30 px-3 py-2">
            <p className="truncate text-xs font-medium text-foreground">
              {formatProviderLabelForUser(connectingProvider.storageProviderLabel)}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {formatProviderHost(connectingProvider.storageProviderUrl)}
            </p>
          </div>
        ) : null}
      </div>
      <div className="px-5 pb-5 shrink-0">
        <button
          type="button"
          onClick={onCancel}
          className="w-full h-9 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors cursor-pointer"
        >
          换一个空间
        </button>
      </div>
    </div>
  )
}

// ── LocalOnboardingView ──────────────────────────────────────────────

function LocalOnboardingView({
  localOnboarding,
  localProviderSource,
  error,
  onBack,
  onContinue,
  onSwitchAccount,
  onTestConnectivity,
  onOpenSettings,
  onClearError,
}: {
  localOnboarding: LoginModalProps['localOnboarding']
  localProviderSource: LoginModalProps['localProviderSource']
  error: string | null
  onBack: () => void
  onContinue: () => void
  onSwitchAccount: () => void
  onTestConnectivity: () => Promise<void> | void
  onOpenSettings?: () => void
  onClearError: () => void
}) {
  const snapshot = localOnboarding
  const autoProbeKeyRef = useRef<string | null>(null)
  const isStandalone = localProviderSource === 'standalone'
  const productLabel = isStandalone ? '独立空间' : '本机空间'
  const onboardingState = snapshot?.state ?? 'idle'
  const isReady = onboardingState === 'ready'
  const connectivity = !isStandalone ? snapshot?.connectivity : null
  const isLocalNetworkBlocked = Boolean(
    isReady
    && connectivity
    && (connectivity.status === 'failed' || connectivity.status === 'mismatch')
  )
  const isPendingStart = onboardingState === 'space_required' || onboardingState === 'idle'
  const isRepair = onboardingState === 'repair_required'
  const isError = onboardingState === 'error'
  const isStarting = onboardingState === 'starting' || onboardingState === 'checking'
  const progressDetail = getLocalPreparationDetail(onboardingState, snapshot?.progress?.phase)
  const localUrl = snapshot?.localUrl ?? snapshot?.baseUrl ?? null

  useEffect(() => {
    if (!isReady || isStandalone || !snapshot) {
      return
    }

    if (connectivity && connectivity.status !== 'unknown') {
      return
    }

    const probeKey = [
      snapshot.spaceKind ?? '',
      snapshot.localUrl ?? '',
      snapshot.publicUrl ?? '',
    ].join('|')
    if (autoProbeKeyRef.current === probeKey) {
      return
    }

    autoProbeKeyRef.current = probeKey
    void Promise.resolve(onTestConnectivity()).catch(() => undefined)
  }, [
    connectivity?.status,
    isReady,
    isStandalone,
    onTestConnectivity,
    snapshot,
    snapshot?.localUrl,
    snapshot?.publicUrl,
    snapshot?.spaceKind,
  ])

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="px-5 pt-5 pb-3 shrink-0 flex items-center gap-2">
        <button
          onClick={onBack}
          className="-ml-1.5 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
          aria-label="返回空间选择"
        >
          <ArrowLeft className="w-4 h-4" />
          返回
        </button>
        <h2 className="text-lg font-semibold text-foreground">{productLabel}</h2>
      </div>

      <ErrorBanner error={error} onClearError={onClearError} />

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-2">
        <div className="flex min-h-full flex-col justify-center gap-4">
          {(isPendingStart || isStarting) && (
            <div className="flex flex-col items-center gap-3 text-center">
              <Loader2 className="w-6 h-6 text-primary animate-spin" />
              <p className="text-sm font-medium text-foreground">正在准备{productLabel}</p>
              <p className="max-w-[18rem] text-xs leading-5 text-muted-foreground">{progressDetail}</p>
            </div>
          )}

          {isReady && (
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium text-foreground text-center">
                {isLocalNetworkBlocked ? '本机空间入口异常' : `${productLabel} 已准备好`}
              </p>
              {isLocalNetworkBlocked ? (
                <p className="text-xs text-muted-foreground leading-relaxed text-center">
                  {formatLocalStatusMessageForUser(
                    connectivity?.message,
                    '本机入口不可达。请确认本机空间已启动后重试。',
                  )}
                </p>
              ) : null}
              {isStandalone ? (
                <RouteInfoCard title="本机入口" value={localUrl} />
              ) : null}
              {!isStandalone ? (
                <LocalReachabilitySummary connectivity={connectivity} assumeLocalReachable />
              ) : null}
              <button
                onClick={onContinue}
                className="w-full h-10 rounded-xl bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
              >
                {isLocalNetworkBlocked ? '重新检测' : '继续登录'}
              </button>
            </div>
          )}

          {(isRepair || isError) && (
            <LocalUnavailableRecovery
              canOpenSettings={Boolean(snapshot?.canOpenSettings)}
              canRetry={Boolean(snapshot?.canRetry)}
              onRetry={onContinue}
              onOpenSettings={onOpenSettings ?? (() => undefined)}
              onSwitchAccount={onSwitchAccount}
            />
          )}
        </div>
      </div>

      <div className="px-5 pb-5 shrink-0" />

      <Footer />
    </div>
  )
}

function RouteInfoCard({
  title,
  value,
  action,
}: {
  title: string
  value: string | null
  action?: ReactNode
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-muted/25 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground/70">{title}</p>
        {action}
      </div>
      <p className="mt-2 break-all font-mono text-[11px] leading-5 text-foreground">
        {value ?? '正在获取入口'}
      </p>
    </div>
  )
}

function LocalUnavailableRecovery({
  canRetry,
  canOpenSettings,
  onRetry,
  onOpenSettings,
  onSwitchAccount,
}: {
  canRetry: boolean
  canOpenSettings: boolean
  onRetry: () => void
  onOpenSettings: () => void
  onSwitchAccount: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <AlertCircle className="w-6 h-6 text-destructive" />
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">本机空间暂时不可用</p>
        <p className="max-w-[18rem] text-xs leading-5 text-muted-foreground">
          请重试或打开设置检查本机服务。不会自动切换到云端空间。
        </p>
      </div>
      <div className="w-full space-y-2">
        <button
          type="button"
          onClick={onRetry}
          disabled={!canRetry}
          className="w-full h-10 rounded-xl bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
        >
          重试
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          disabled={!canOpenSettings}
          className="w-full h-10 rounded-xl border border-border/60 bg-muted/30 text-sm font-medium text-foreground hover:bg-muted/50 transition-colors disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
        >
          打开设置
        </button>
        <button
          type="button"
          onClick={onSwitchAccount}
          className="w-full h-9 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors cursor-pointer"
        >
          切换账号
        </button>
      </div>
    </div>
  )
}

// ── Shared Components ─────────────────────────────────────────────────

function AccountAvatar({
  name,
  avatarUrl,
  size = 'md',
  spaceMarker = null,
}: {
  name: string
  avatarUrl?: string
  size?: 'md' | 'lg'
  spaceMarker?: SpaceMarkerKind | null
}) {
  const dim = size === 'lg' ? 'w-16 h-16' : 'w-11 h-11'
  const textSize = size === 'lg' ? 'text-2xl' : 'text-sm'
  const radius = 'rounded-[18%]'
  const marker = spaceMarker ? <SpaceMarker kind={spaceMarker} size={size} /> : null

  if (avatarUrl) {
    return (
      <div className={cn(dim, radius, 'relative overflow-hidden shadow-sm')}>
        <img
          src={avatarUrl}
          alt=""
          className="h-full w-full object-cover"
        />
        {marker}
      </div>
    )
  }

  return (
    <div className={cn(dim, radius, 'relative bg-primary/10 flex items-center justify-center shadow-sm')}>
      <span className={cn(textSize, 'font-semibold text-primary')}>
        {name.charAt(0).toUpperCase()}
      </span>
      {marker}
    </div>
  )
}

type SpaceMarkerKind = 'local' | 'standalone'

function SpaceMarker({ kind, size }: { kind: SpaceMarkerKind; size: 'md' | 'lg' }) {
  const isStandalone = kind === 'standalone'
  const Icon = isStandalone ? HardDrive : Link2

  return (
    <span
      data-account-space-marker={kind}
      data-account-local-marker={kind === 'local' ? true : undefined}
      data-account-standalone-marker={kind === 'standalone' ? true : undefined}
      className={cn(
        'absolute flex items-center justify-center border border-white/80 text-white shadow-sm dark:border-zinc-900/80',
        isStandalone ? 'bg-emerald-500' : 'bg-sky-500',
        size === 'lg' ? 'bottom-1 right-1 h-5 w-5 rounded-[7px]' : 'bottom-0.5 right-0.5 h-4 w-4 rounded-[6px]',
      )}
    >
      <Icon className={size === 'lg' ? 'h-3 w-3' : 'h-2.5 w-2.5'} aria-hidden="true" />
    </span>
  )
}

function getLocalPreparationDetail(
  state: NonNullable<LoginModalProps['localOnboarding']>['state'],
  progressPhase: string | undefined,
): string {
  if (state === 'checking') return '正在验证本机空间'
  if (progressPhase === 'register-cloud') return '正在准备登录授权'
  return '正在启动本机服务'
}

function formatLocalStatusMessageForUser(value: string | null | undefined, fallback: string): string {
  return formatLoginErrorForUser(value, fallback)
}

function formatProviderLabelForUser(value: string | undefined): string {
  if (value === 'Cloud') return '云端空间'
  if (value === 'Local') return '本机空间'
  if (value === 'Standalone') return '独立空间'
  return value ?? '所选空间'
}

function ErrorBanner({ error, onClearError }: { error: string | null; onClearError: () => void }) {
  if (!error) return null
  const message = formatLoginErrorForUser(error, '操作失败，请返回上一步后重试。')

  return (
    <div className="mx-4 mb-3 px-3 py-2 bg-destructive/10 rounded-lg flex items-start gap-2 shrink-0">
      <AlertCircle className="w-3.5 h-3.5 text-destructive mt-0.5 shrink-0" />
      <p className="text-xs text-destructive flex-1 leading-relaxed">{message}</p>
      <button
        onClick={onClearError}
        className="text-destructive/60 hover:text-destructive shrink-0 cursor-pointer"
        aria-label="关闭错误提示"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

function Footer() {
  return null
}

function resolveStoredAccountSpaceMarker(account: LoginModalProps['storedAccount']): SpaceMarkerKind | null {
  if (!account) {
    return null
  }

  if (
    account.storageProviderLabel === 'Standalone'
    || account.issuerLabel === 'Standalone'
  ) {
    return 'standalone'
  }

  if (
    account.storageProviderLabel === 'Local'
  ) {
    return 'local'
  }

  if (account.issuerLabel === 'Local') {
    return 'standalone'
  }

  if (
    isStandaloneAccountUrl(account.storageProviderUrl)
    || isStandaloneAccountUrl(account.issuerUrl)
    || isStandaloneAccountUrl(account.webId)
  ) {
    return 'standalone'
  }

  return isManagedLocalAccountUrl(account.storageProviderUrl)
    || isManagedLocalAccountUrl(account.issuerUrl)
    || isManagedLocalAccountUrl(account.webId)
    ? 'local'
    : null
}

function getRememberedAccountBindingLabel(account: NonNullable<LoginModalProps['storedAccount']>): string {
  const issuer = resolveRememberedIssuerLabel(account)
  const marker = resolveStoredAccountSpaceMarker(account)

  if (marker === 'local') return `${issuer} · 本机空间`
  if (marker === 'standalone') return `${issuer} · 独立空间`

  return account.storageProviderLabel ? `${issuer} · ${account.storageProviderLabel}` : issuer
}

function resolveRememberedIssuerLabel(account: NonNullable<LoginModalProps['storedAccount']>): string {
  return account.issuerLabel || '账号'
}

function isStandaloneAccountUrl(url?: string): boolean {
  if (!url) {
    return false
  }

  try {
    const hostname = new URL(url).hostname
    return isLocalAccessHostname(hostname)
  } catch {
    return false
  }
}

function isManagedLocalAccountUrl(url?: string): boolean {
  if (!url) {
    return false
  }

  try {
    const hostname = new URL(url).hostname
    return hostname.endsWith('.undefineds.co') && hostname.startsWith('node-')
  } catch {
    return false
  }
}


function formatProviderHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function StorageDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground/70">
        {label}
      </p>
      <div className="rounded-xl border border-border/50 bg-background/70 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground break-all">
        {value}
      </div>
    </div>
  )
}
