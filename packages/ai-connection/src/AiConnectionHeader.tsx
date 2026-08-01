import { Input } from '@undefineds.co/shared-ui'
import type { AppletSlotProps } from '@undefineds.co/extension-sdk/web'
import { Search } from 'lucide-react'
import {
  type AiConnectionController,
  useProviderSearch,
} from './controller'

export function AiConnectionHeader({
  controller,
}: AppletSlotProps<AiConnectionController>) {
  const searchQuery = useProviderSearch(controller)

  return (
    <div className="flex h-full min-w-0 items-center gap-4 px-4">
      <h1 className="shrink-0 text-sm font-medium text-foreground">
        AI Connection
      </h1>
      <div className="relative ml-auto w-full max-w-xs">
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
    </div>
  )
}
