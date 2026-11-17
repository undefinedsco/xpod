import { Badge, EmptyState, InlineNotice } from '@undefineds.co/shared-ui'
import { Server } from 'lucide-react'
import type { AiBuiltinProviderSummary } from './contract/ai-connections-client'

/**
 * The deployment's own read-only AI Connections.
 *
 * These are not Pod providers: the server declares them about itself
 * (`builtin: true` + `readOnly: true`), the user owns no credential for them,
 * and there is nothing here to enable, disable, edit or delete. Rendering them
 * on their own section is what keeps a personal-catalog failure from erasing a
 * directory the caller never had to read the Pod for.
 */
/**
 * The four states of the declared directory, kept apart on purpose.
 *
 * A failed read and a successful empty read look identical on screen if both are
 * projected to `[]`, and then the page tells the user "there are none" when it
 * simply does not know. That is the same false certainty as the original
 * zero-model pane, so they stay distinct here.
 */
export type BuiltinDirectoryState =
  | { status: 'unsupported' }
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; providers: AiBuiltinProviderSummary[] }

export function AiBuiltinProvidersSection({ state }: { state: BuiltinDirectoryState }) {
  const catalog = state.status === 'ready' ? state.providers : []
  const modelCount = catalog.reduce((total, provider) => total + provider.models.length, 0)
  return (
    <section className="space-y-8" aria-label="部署内置模型">
      <div
        data-testid="builtin-providers-header"
        className="flex flex-wrap items-center justify-between gap-2"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="flex items-center gap-2 text-sm font-medium leading-normal text-foreground/90">
            <Server aria-hidden="true" className="h-4 w-4 text-primary" />部署内置模型
          </h3>
          {state.status === 'ready' ? (
            <span className="text-xs leading-normal text-muted-foreground">
              {`共 ${catalog.length} 个提供商 · ${modelCount} 个模型`}
            </span>
          ) : null}
          <span className="text-xs leading-normal text-muted-foreground">由当前部署提供，只读</span>
        </div>
      </div>

      {state.status === 'unsupported' ? (
        <EmptyState description="这个客户端无法读取部署内置模型目录" />
      ) : state.status === 'loading' ? (
        <EmptyState description="部署内置模型目录尚未就绪" />
      ) : state.status === 'failed' ? (
        <InlineNotice tone="destructive" role="alert">
          {`部署内置模型目录读取失败：${state.message}`}
        </InlineNotice>
      ) : catalog.length === 0 ? (
        <EmptyState description="当前部署没有内置模型" />
      ) : (
        <div className="space-y-4">
          {catalog.map((provider) => (
            <div key={provider.id} className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground/90">{provider.name}</span>
                <code className="font-mono text-[10px] text-muted-foreground opacity-70">{provider.id}</code>
                <Badge variant="outline" className="shrink-0 text-[10px] font-normal">只读</Badge>
              </div>
              {provider.models.length === 0 ? (
                <p className="text-xs text-muted-foreground">该提供商未声明模型</p>
              ) : (
                <ul aria-label={`${provider.name} 的模型`} className="grid gap-2">
                  {provider.models.map((model) => (
                    <li
                      key={`${provider.id}\0${model.id}`}
                      className="flex items-center gap-3 rounded-lg border border-border/40 bg-card p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <span className="truncate text-sm font-medium text-foreground/90">
                          {model.displayName ?? model.id}
                        </span>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <code className="max-w-[300px] truncate font-mono text-[10px] text-muted-foreground opacity-70">
                            {model.id}
                          </code>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
