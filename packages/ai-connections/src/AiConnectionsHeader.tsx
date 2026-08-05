import { Button, Input } from '@undefineds.co/shared-ui'
import type { AppletSlotProps } from '@undefineds.co/extension-sdk/web'
import { Plus, Search } from 'lucide-react'
import {
  type AiConnectionsController,
  useProviderSearch,
} from './controller'

export function AiConnectionsHeader({
  controller,
}: AppletSlotProps<AiConnectionsController>) {
  const searchQuery = useProviderSearch(controller)

  return (
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
        onClick={() => controller.selectFirstUnconfiguredProvider()}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  )
}
