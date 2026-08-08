import { useEffect, useId, useState, type ReactNode } from 'react'
import { cn } from '@undefineds.co/shared-ui'
import type {
  AiProviderOffering,
  AiProviderSummary,
} from './ai-connections-client'

export function AiOfferingTabs({
  product,
  fallbackOfferings,
  children,
}: {
  product?: AiProviderSummary
  fallbackOfferings: AiProviderOffering[]
  children: (offering: AiProviderOffering) => ReactNode
}) {
  const tabsId = useId()
  const offerings = product?.offerings.length ? product.offerings : fallbackOfferings
  const [selectedOfferingId, setSelectedOfferingId] = useState(offerings[0]?.id ?? 'api-platform')

  useEffect(() => {
    if (!offerings.some((offering) => offering.id === selectedOfferingId)) {
      setSelectedOfferingId(offerings[0]?.id ?? 'api-platform')
    }
  }, [offerings, selectedOfferingId])

  const selectedOffering = offerings.find((offering) => offering.id === selectedOfferingId) ?? offerings[0]
  if (!selectedOffering) return null

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Provider credential offerings" className="flex flex-wrap gap-2">
        {offerings.map((offering) => {
          const selected = offering.id === selectedOffering.id
          return (
            <button
              key={offering.id}
              type="button"
              role="tab"
              id={`${tabsId}-${offering.id}-tab`}
              aria-selected={selected}
              aria-controls={`${tabsId}-${offering.id}-panel`}
              onClick={() => setSelectedOfferingId(offering.id)}
              className={cn(
                'rounded-md border px-3 py-1.5 text-sm font-medium transition-colors',
                selected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground',
              )}
            >
              {offering.label ?? offeringLabel(offering)}
            </button>
          )
        })}
      </div>
      <div
        role="tabpanel"
        id={`${tabsId}-${selectedOffering.id}-panel`}
        aria-labelledby={`${tabsId}-${selectedOffering.id}-tab`}
      >
        {children(selectedOffering)}
      </div>
    </div>
  )
}

export function offeringLabel(offering: AiProviderOffering): string {
  if (offering.label) return offering.label
  if (offering.authModes?.some((mode) => mode === 'oauth' || mode === 'deviceCode')) return '账号登录'
  if (offering.authModes?.some((mode) => mode === 'apiKey')) return 'API Key'
  return offering.id
}
