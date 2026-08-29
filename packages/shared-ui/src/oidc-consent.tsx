import { Button } from './button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './card'
import { Label } from './label'
import { ScrollArea } from './scroll-area'
import { Switch } from './switch'
import { controlFocusClass } from './focus'
import { cn } from './utils'

export interface OidcConsentOption {
  id: string
  label: string
  description?: string
  webId?: string
  storageUrl?: string
}

export interface OidcConsentSelection {
  webIdId: string
  storageId?: string
  rememberClient: boolean
}

export interface OidcConsentCopy {
  title: string
  description: string
  webIdLabel: string
  storageLabel: string
  rememberClientLabel: string
  approveLabel: string
  denyLabel: string
  editAccountLabel?: string
  switchAccountLabel?: string
}

export interface OidcConsentViewProps {
  client: { name: string; description?: string; logoUrl?: string }
  webIds?: readonly OidcConsentOption[]
  webIdOptions?: readonly OidcConsentOption[]
  storageOptions?: readonly OidcConsentOption[]
  storages?: readonly OidcConsentOption[]
  selectedWebIdId?: string
  selectedWebId?: string
  selectedStorageId?: string
  selectedStorage?: string
  rememberClient: boolean
  onWebIdChange?: (optionId: string) => void
  onWebIdSelect?: (optionId: string) => void
  onStorageChange?: (optionId: string) => void
  onStorageSelect?: (optionId: string) => void
  onRememberClientChange?: (remember: boolean) => void
  onRememberClient?: (remember: boolean) => void
  onApprove: (selection: OidcConsentSelection) => void | Promise<void>
  onDeny: () => void | Promise<void>
  onEditAccount?: () => void | Promise<void>
  onSwitchAccount?: () => void | Promise<void>
  pending?: boolean
  /** Hide identity internals when the host has already resolved one exact binding. */
  showIdentitySelection?: boolean
  copy: OidcConsentCopy
}

export function OidcConsentView({
  client,
  webIds,
  webIdOptions,
  storageOptions,
  storages,
  selectedWebIdId,
  selectedWebId,
  selectedStorageId,
  selectedStorage,
  rememberClient,
  onWebIdChange,
  onWebIdSelect,
  onStorageChange,
  onStorageSelect,
  onRememberClientChange,
  onRememberClient,
  onApprove,
  onDeny,
  onEditAccount,
  onSwitchAccount,
  pending = false,
  showIdentitySelection = true,
  copy,
}: OidcConsentViewProps) {
  const resolvedWebIds = webIds ?? webIdOptions ?? []
  const resolvedStorages = storageOptions ?? storages ?? []
  const resolvedWebIdId = selectedWebIdId ?? selectedWebId ?? ''
  const resolvedStorageId = selectedStorageId ?? selectedStorage
  const selectedWebIdOption = resolvedWebIds.find((option) => option.id === resolvedWebIdId)
  const selectedStorageOption = resolvedStorages.find((option) => option.id === resolvedStorageId)
  const changeWebId = onWebIdChange ?? onWebIdSelect
  const changeStorage = onStorageChange ?? onStorageSelect
  const changeRememberClient = onRememberClientChange ?? onRememberClient
  const approveDisabled = pending || !selectedWebIdOption || (resolvedStorages.length > 0 && !selectedStorageOption)

  return (
    <Card className="w-full border-border bg-card text-card-foreground">
      <ScrollArea data-testid="oidc-consent-scroll" className="max-h-[min(80vh,42rem)] overflow-y-auto">
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
        <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
          <p className="font-medium text-foreground">{client.name}</p>
          {client.description ? <p className="mt-1 text-sm text-muted-foreground">{client.description}</p> : null}
        </div>
      </CardHeader>
        <CardContent className="space-y-5">
          {showIdentitySelection ? <div className="space-y-2">
            <Label htmlFor="oidc-consent-webid">{copy.webIdLabel}</Label>
            <select
              id="oidc-consent-webid"
              value={resolvedWebIdId}
              disabled={pending || !changeWebId}
              onChange={(event) => changeWebId?.(event.currentTarget.value)}
              className={cn(
                'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground',
                controlFocusClass,
              )}
            >
              {resolvedWebIds.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            {selectedWebIdOption?.description ? <p className="text-sm text-muted-foreground">{selectedWebIdOption.description}</p> : null}
          </div> : null}

          {showIdentitySelection && resolvedStorages.length > 0 ? (
            <div className="space-y-2">
              <Label htmlFor="oidc-consent-storage">{copy.storageLabel}</Label>
              <select
                id="oidc-consent-storage"
                value={resolvedStorageId ?? ''}
                disabled={pending || !changeStorage}
                onChange={(event) => changeStorage?.(event.currentTarget.value)}
                className={cn(
                  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground',
                  controlFocusClass,
                )}
              >
                {resolvedStorages.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              {selectedStorageOption?.description ? <p className="text-sm text-muted-foreground">{selectedStorageOption.description}</p> : null}
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 p-3">
            <Label htmlFor="oidc-consent-remember">{copy.rememberClientLabel}</Label>
            <Switch
              id="oidc-consent-remember"
              aria-label={copy.rememberClientLabel}
              checked={rememberClient}
              disabled={pending || !changeRememberClient}
              onCheckedChange={(checked) => changeRememberClient?.(checked)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Button
              type="button"
              className="w-full"
              disabled={approveDisabled}
              onClick={() => void onApprove({ webIdId: resolvedWebIdId, storageId: resolvedStorageId, rememberClient })}
            >
              {copy.approveLabel}
            </Button>
            <Button type="button" variant="outline" className="w-full" disabled={pending} onClick={() => void onDeny()}>
              {copy.denyLabel}
            </Button>
            {onEditAccount && copy.editAccountLabel ? <Button type="button" variant="ghost" className="w-full" disabled={pending} onClick={() => void onEditAccount()}>{copy.editAccountLabel}</Button> : null}
            {onSwitchAccount && copy.switchAccountLabel ? <Button type="button" variant="ghost" className="w-full" disabled={pending} onClick={() => void onSwitchAccount()}>{copy.switchAccountLabel}</Button> : null}
          </div>
        </CardContent>
      </ScrollArea>
    </Card>
  )
}
