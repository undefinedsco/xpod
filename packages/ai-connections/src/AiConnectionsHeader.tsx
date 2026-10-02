import { Button, SearchInput } from '@undefineds.co/shared-ui'
import type { AppletSlotProps } from '@undefineds.co/extension-sdk/web'
import { Plus } from 'lucide-react'
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
      setCustomProviderError('请先登录后再添加自定义服务商。')
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
          <SearchInput
            aria-label="搜索服务商"
            value={searchQuery}
            onChange={(event) => controller.setSearchQuery(event.target.value)}
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
