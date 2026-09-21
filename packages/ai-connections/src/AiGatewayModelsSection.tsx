import { useMemo, useState } from 'react'
import { Badge } from '@undefineds.co/shared-ui'
import { Box } from 'lucide-react'
import type { AiGatewayModel } from './contract/ai-connections-client'
import {
  AiModelEmptyPanel,
  AiModelSearchInput,
  AiModelRow,
  modelIconTokens,
  withCatalogModelId,
} from './AiModelCatalog'

/**
 * What the gateway list shares with the provider pages.
 *
 * A published model is a joined one, so switching here writes the same
 * selection the provider pages write rather than a second flag to keep in sync.
 */
export interface GatewayModelSelection {
  isSelected(model: AiGatewayModel): boolean
  toggle(model: AiGatewayModel): void
  disabled?: boolean
}

/**
 * The catalog the Gateway publishes to clients (`/v1/models`), switched with the
 * same row the provider pages use: 停用 withdraws a model from the models list
 * endpoint, 启用 publishes it again.
 */
export function AiGatewayModelsSection({ models, selection }: { models?: AiGatewayModel[]; selection?: GatewayModelSelection }) {
  const [search, setSearch] = useState('')
  const catalog = useMemo(() => aggregateGatewayModels(models ?? []), [models])
  const query = search.trim().toLocaleLowerCase()
  const visibleModels = query
    ? catalog.filter((model) => model.searchText.includes(query))
    : catalog
  const unavailableCount = catalog.filter((model) => model.availability === 'unavailable').length
  const publishedCount = selection
    ? catalog.filter((model) => selection.isSelected(model)).length
    : catalog.length
  return (
    <section className="space-y-8" aria-label="可用模型">
      <div
        data-testid="gateway-models-header"
        className="flex flex-wrap items-center justify-between gap-2"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground/90">
            <Box aria-hidden="true" className="h-4 w-4 text-primary" />可用模型
          </h3>
          <span className="text-xs text-muted-foreground">
            {selection
              ? `共 ${catalog.length} · 已发布 ${publishedCount} · 已失效 ${unavailableCount}`
              : `共 ${catalog.length} · 已失效 ${unavailableCount}`}
          </span>
          <span className="text-xs text-muted-foreground">Xpod 当前发布的模型</span>
        </div>
        <AiModelSearchInput value={search} onChange={setSearch} />
      </div>

      {models === undefined ? (
        <AiModelEmptyPanel>Xpod 模型目录尚未就绪</AiModelEmptyPanel>
      ) : catalog.length === 0 ? (
        <AiModelEmptyPanel>暂无可用模型</AiModelEmptyPanel>
      ) : visibleModels.length === 0 ? (
        <AiModelEmptyPanel>未找到匹配的模型</AiModelEmptyPanel>
      ) : (
        <div className="grid gap-2">
          {visibleModels.map((model) => (
            <AiModelRow
              key={model.key}
              label={model.displayName ?? model.id}
              modelId={model.id}
              iconTokens={model.iconTokens}
              enabled={selection?.isSelected(model) ?? false}
              toggleDisabled={selection?.disabled}
              onToggle={selection ? () => selection.toggle(model) : undefined}
              unavailable={model.availability === 'unavailable'}
              badges={(
                <>
                  {model.custom ? <Badge variant="outline" className="shrink-0 text-[10px] font-normal">手工</Badge> : null}
                  {model.availability === 'unavailable' ? (
                    <Badge variant="destructive" className="shrink-0 text-[10px] font-normal">
                      已失效
                    </Badge>
                  ) : null}
                </>
              )}
            />
          ))}
        </div>
      )}
    </section>
  )
}

interface GatewayCatalogModel extends AiGatewayModel {
  key: string
  searchText: string
  iconTokens: string[]
}

/**
 * One gateway model can be published once per credential/offering, so the
 * read surface folds those entries the same way the provider page does.
 */
function aggregateGatewayModels(models: AiGatewayModel[]): GatewayCatalogModel[] {
  const catalog = new Map<string, GatewayCatalogModel>()
  for (const entry of models) {
    const model = withCatalogModelId(entry)
    const key = `${model.provider}\0${model.id}`
    const iconTokens = modelIconTokens(model)
    const searchText = [model.id, model.displayName].filter(Boolean).join('\n').toLocaleLowerCase()
    const existing = catalog.get(key)
    if (!existing) {
      catalog.set(key, { ...model, key, iconTokens, searchText })
      continue
    }
    if (model.availability !== 'unavailable') existing.availability = model.availability
    if (existing.displayName === undefined && model.displayName !== undefined) {
      existing.displayName = model.displayName
    }
    existing.iconTokens = [...new Set([...existing.iconTokens, ...iconTokens])]
    existing.searchText += `\n${searchText}`
  }
  return [...catalog.values()]
}
