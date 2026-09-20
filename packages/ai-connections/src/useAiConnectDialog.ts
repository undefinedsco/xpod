import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AiConnectAttempt,
  AiConnectionsMode,
  AiProviderAuthorizationMethod,
  AiProviderCredentialSummary,
  AiProviderOffering,
} from '@undefineds.co/ai-connections-core/client'
import { isOAuthMode, isPendingAttempt } from './authorization-methods'

/**
 * Lifecycle of the connect dialog: which offering is being connected, whether the
 * user is creating or editing, and the busy/error state the toolbar and the
 * dialog body share.
 *
 * The toolbar buttons and the dialog are two views of one small state machine, so
 * it lives here rather than in the section: otherwise both sides have to thread
 * five setters and a close handler through their props.
 */
export interface AiConnectDialogController {
  open: boolean
  title: string
  editing?: AiProviderCredentialSummary
  authorizationOfferingId?: string
  error?: string
  saving: boolean
  /** Open the dialog on a blank API key form. */
  beginApiKey(): void
  /** Open the dialog on an existing credential's form. */
  beginEdit(credential: AiProviderCredentialSummary): void
  /** Open the dialog on an authorization that runs outside it. */
  beginAuthorization(
    offering: AiProviderOffering,
    mode: AiConnectionsMode,
    method?: AiProviderAuthorizationMethod,
  ): void
  /** Start the browser-assisted API key flow the dialog reports progress for. */
  beginBrowser(): void
  /** Import the local client's login state, reporting failures inside the dialog. */
  beginLocal(offering: AiProviderOffering, method?: AiProviderAuthorizationMethod): Promise<void>
  /** Report the nested form's busy state so the dialog's own controls stay disabled. */
  setSaving(saving: boolean): void
  close(): void
}

export function useAiConnectDialog({
  attempt,
  onDismissError,
  onBeginOffering,
  onBeginBrowser,
  onCreateLocalCredential,
}: {
  attempt?: AiConnectAttempt
  onDismissError?: () => void
  onBeginOffering?: (offering: AiProviderOffering, mode: AiConnectionsMode, method?: AiProviderAuthorizationMethod) => void
  onBeginBrowser: () => void
  onCreateLocalCredential?: (offering: AiProviderOffering, method?: AiProviderAuthorizationMethod) => Promise<void>
}): AiConnectDialogController {
  const [creatingApiKey, setCreatingApiKey] = useState(false)
  const [editing, setEditing] = useState<AiProviderCredentialSummary>()
  const [authorizationOfferingId, setAuthorizationOfferingId] = useState<string>()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)

  const open = creatingApiKey || Boolean(editing) || Boolean(authorizationOfferingId)
  const close = useCallback(() => {
    setCreatingApiKey(false)
    setAuthorizationOfferingId(undefined)
    setEditing(undefined)
    setError(undefined)
  }, [])

  // An authorization started from the dialog finishes outside it, so the dialog
  // closes on the attempt it was waiting for and not on any later one.
  const completedAttemptRef = useRef(attempt)
  useEffect(() => {
    const previous = completedAttemptRef.current
    completedAttemptRef.current = attempt
    if (open && attempt !== previous && attempt?.status === 'completed') close()
  }, [attempt, open, close])

  /** Every action starts clean: the dialog's own error and the section's. */
  const dismissErrors = useCallback(() => {
    setError(undefined)
    onDismissError?.()
  }, [onDismissError])

  const beginApiKey = useCallback(() => {
    dismissErrors()
    setCreatingApiKey(true)
  }, [dismissErrors])

  const beginBrowser = useCallback(() => {
    dismissErrors()
    onBeginBrowser()
  }, [dismissErrors, onBeginBrowser])

  const beginAuthorization = useCallback((
    offering: AiProviderOffering,
    mode: AiConnectionsMode,
    method?: AiProviderAuthorizationMethod,
  ) => {
    dismissErrors()
    setAuthorizationOfferingId(offering.id)
    onBeginOffering?.(offering, mode, method)
  }, [dismissErrors, onBeginOffering])

  const beginLocal = useCallback(async (
    offering: AiProviderOffering,
    method?: AiProviderAuthorizationMethod,
  ) => {
    if (!onCreateLocalCredential) return
    dismissErrors()
    setSaving(true)
    try {
      await onCreateLocalCredential(offering, method)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接失败，请重试')
    } finally {
      setSaving(false)
    }
  }, [dismissErrors, onCreateLocalCredential])

  // Editing leaves whatever error is already on screen alone: the user opened a
  // form, they did not retry the action that failed.
  const beginEdit = useCallback((credential: AiProviderCredentialSummary) => {
    setEditing(credential)
  }, [])

  return {
    open,
    title: editing ? '编辑连接' : authorizationOfferingId ? '连接账号' : '新建连接',
    ...(editing ? { editing } : {}),
    ...(authorizationOfferingId ? { authorizationOfferingId } : {}),
    ...(error ? { error } : {}),
    saving,
    beginApiKey,
    beginEdit,
    beginAuthorization,
    beginBrowser,
    beginLocal,
    setSaving,
    close,
  }
}
