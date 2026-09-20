import { Button } from '@undefineds.co/shared-ui'
import { ExternalLink, Loader2, Plus } from 'lucide-react'
import type {
  AiConnectionsMode,
  AiProviderAuthorizationMethod,
  AiProviderOffering,
} from './ai-connections-client'
import { connectModeForMethod, isLocalMethod, isOAuthMode } from './authorization-methods'

/**
 * The offering's own entries, one button per declared `authorizationMethod`.
 *
 * A method that is implemented but unavailable in this deployment still gets its
 * button, greyed at the same spec as its neighbours so the row keeps one line,
 * with the reason as its tooltip. Nothing explains itself in a second row: the
 * entry's own state is the message, and a list of internal reasons underneath
 * the row reflows the buttons around it. Methods this build has not implemented
 * never reach here - the server omits them.
 */
export function AiAuthorizationActions({
  methods,
  offering,
  busy,
  disabled,
  onBeginOffering,
  onCreateLocalCredential,
}: {
  methods: AiProviderAuthorizationMethod[]
  offering: AiProviderOffering
  busy: boolean
  disabled: boolean
  onBeginOffering?: (offering: AiProviderOffering, mode: AiConnectionsMode, method?: AiProviderAuthorizationMethod) => void
  onCreateLocalCredential?: (offering: AiProviderOffering, method?: AiProviderAuthorizationMethod) => Promise<void>
}) {
  if (methods.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2">
      {methods.map((method) => {
        const connectMode = connectModeForMethod(method)
        const unavailable = method.lifecycle === 'unavailable'
        // An entry without a label is not one the offering asked for; the
        // button is named by the method itself, never by a provider default.
        if (!method.label) return null
        if (isOAuthMode(connectMode)) {
          return (
            <Button
              key={method.id}
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              title={unavailable ? method.reason : undefined}
              disabled={busy || disabled || unavailable || !onBeginOffering}
              onClick={() => onBeginOffering?.(offering, connectMode, method)}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
              {method.label}
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
              title={unavailable
                ? method.reason
                : '导入当前设备已有登录态，不会发起新的浏览器授权。'}
              disabled={busy || disabled || unavailable || !onCreateLocalCredential}
              onClick={() => void onCreateLocalCredential?.(offering, method)}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              {method.label}
            </Button>
          )
        }
        return null
      })}
    </div>
  )
}
