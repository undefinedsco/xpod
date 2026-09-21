import type { AiProviderAuthorizationMethod, AiProviderOffering } from './contract/ai-connections-client'
import { authMethodLabel, offeringKindLabel, offeringTitle } from './offering-label'
import { authorizationMethodsForOffering } from './authorization-methods'
import { AiEndpointList } from './AiEndpointList'

export function AiOfferingDetails({ offering, methods }: {
  offering: AiProviderOffering
  methods?: AiProviderAuthorizationMethod[]
}) {
  const endpoints = offering.endpoints ?? []
  const title = offeringTitle(offering)
  const kindLabel = offering.kind ? offeringKindLabel(offering.kind) : undefined
  const subtitle = kindLabel && kindLabel !== title ? [kindLabel] : []
  return (
    <section className="space-y-2" aria-labelledby={`offering-${offering.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 id={`offering-${offering.id}`} className="text-sm font-medium text-foreground">{title}</h4>
          {subtitle.length ? (
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              {subtitle.map((part) => <span key={part}>{part}</span>)}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs">
          <span className="text-muted-foreground">{authMethodLabel(offering, methods)}</span>
          {offering.consoleUrl ? <OfferingLink href={offering.consoleUrl} label="控制台" /> : null}
          {offering.subscriptionUrl ? <OfferingLink href={offering.subscriptionUrl} label="订阅与账单" /> : null}
          {offering.quota?.url ? <OfferingLink href={offering.quota.url} label="额度与用量" /> : null}
          {offering.usagePolicyUrl ? <OfferingLink href={offering.usagePolicyUrl} label="使用政策" /> : null}
        </div>
      </div>
      {offering.lifecycle === 'unavailable' && !authorizationMethodsForOffering(offering).some((method) => method.lifecycle === 'active') ? (
        <p className="text-xs text-muted-foreground">{offering.kind === 'oauth-subscription'
          ? '暂不可用：账号订阅需在 Xpod 桌面版中导入本机客户端（如 Codex CLI）的登录态，浏览器中无法完成。'
          : '暂不可用：该接入方式尚未提供可用的连接流程。'}</p>
      ) : null}
      {endpoints.length ? <AiEndpointList endpoints={endpoints} /> : null}
    </section>
  )
}

function OfferingLink({ href, label }: { href: string; label: string }) {
  return <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">{label}</a>
}
