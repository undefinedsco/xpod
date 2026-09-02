import { Button, Input } from '@undefineds.co/shared-ui'
import type { AppletSlotProps } from '@undefineds.co/extension-sdk/web'
import { Plus, Search } from 'lucide-react'
import { useState } from 'react'
import { AiCustomProviderDialog, type CustomProviderValue } from './AiCustomProviderDialog'
import {
  type AiConnectionsController,
  useProviderSearch,
} from './controller'

export function AiConnectionsHeader({
  controller,
}: AppletSlotProps<AiConnectionsController>) {
  const searchQuery = useProviderSearch(controller)
  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  const [savingCustomProvider, setSavingCustomProvider] = useState(false)
  const [customProviderError, setCustomProviderError] = useState<string | undefined>()

  const saveCustomProvider = async (value: CustomProviderValue) => {
    if (!controller.client) {
      setCustomProviderError('请先登录后再添加自定义 Provider。')
      return
    }
    setSavingCustomProvider(true)
    setCustomProviderError(undefined)
    let createdCredentialId: string | undefined
    try {
      const credential = await controller.client.createApiKeyCredential('custom', value)
      createdCredentialId = credential.id
      await controller.client.discoverModels('custom', {
        offeringId: credential.offeringId,
        credentialId: credential.id,
        compatibility: value.compatibility,
      })
      controller.selectProvider('custom', credential.id)
      await controller.loadProviders()
      setCustomDialogOpen(false)
    } catch (error) {
      if (createdCredentialId) {
        await controller.client.deleteProviderCredential('custom', createdCredentialId).catch(() => undefined)
      }
      setCustomProviderError(error instanceof Error ? error.message : 'AI Connection request failed. Please try again.')
    } finally {
      setSavingCustomProvider(false)
    }
  }

  return (
    <>
      <div className="flex h-full min-w-0 items-center gap-2 px-3">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="搜索 Provider"
            placeholder="搜索 Provider"
            value={searchQuery}
            onChange={(event) => controller.setSearchQuery(event.target.value)}
            className="h-8 border-transparent bg-muted/50 pl-8 text-xs focus-visible:bg-background"
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="添加 AI Connection"
          title="添加 AI Connection"
          onClick={() => setCustomDialogOpen(true)}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      <AiCustomProviderDialog
        open={customDialogOpen}
        saving={savingCustomProvider}
        error={customProviderError}
        onOpenChange={setCustomDialogOpen}
        onSave={(value) => void saveCustomProvider(value)}
      />
    </>
  )
}
