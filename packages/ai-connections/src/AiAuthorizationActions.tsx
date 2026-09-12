import { Button } from '@undefineds.co/shared-ui'
import { ExternalLink, Loader2, Plus } from 'lucide-react'
import type {
  AiConnectionsMode,
  AiProviderAuthorizationMethod,
  AiProviderOffering,
} from './ai-connections-client'
import { connectModeForMethod, isLocalMethod, isOAuthMode } from './authorization-methods'

export function AiAuthorizationActions({
  methods,
  offering,
  hasCredentials,
  busy,
  disabled,
  onBeginOffering,
  onCreateLocalCredential,
}: {
  methods: AiProviderAuthorizationMethod[]
  offering: AiProviderOffering
  hasCredentials: boolean
  busy: boolean
  disabled: boolean
  onBeginOffering?: (offering: AiProviderOffering, mode: AiConnectionsMode, method?: AiProviderAuthorizationMethod) => void
  onCreateLocalCredential?: (offering: AiProviderOffering, method?: AiProviderAuthorizationMethod) => Promise<void>
}) {
  if (methods.length === 0) return null
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {methods.map((method) => {
          const connectMode = connectModeForMethod(method)
          if (isOAuthMode(connectMode)) {
            return (
              <Button
                key={method.id}
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                disabled={busy || disabled || !onBeginOffering}
                onClick={() => onBeginOffering?.(offering, connectMode, method)}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                {method.label || (hasCredentials ? '添加账号' : '登录')}
              </Button>
            )
          }
          if (isLocalMethod(method)) {
            return (
              <Button
                key={method.id}
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                title="导入当前设备已有登录态，不会发起新的浏览器授权。"
                disabled={busy || disabled || !onCreateLocalCredential}
                onClick={() => void onCreateLocalCredential?.(offering, method)}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                {method.label || '已有登录态'}
              </Button>
            )
          }
          return null
        })}
      </div>
    </div>
  )
}
