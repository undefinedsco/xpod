import { compatibleProtocolLabel, endpointDisplayValue, endpointProtocolLabel, type AiEndpointEntry } from './offering-endpoints'
import { AiCopyButton } from './AiCopyButton'

/**
 * Protocol/endpoint list shared by a provider offering's details and Xpod's own
 * 接入信息: in both places a list of `protocol → base URL` pairs is what the user
 * reads, so the rows (and their copy affordance) are one implementation.
 *
 * `copy` is opt-in because the provider pages read their upstream endpoints
 * without offering them for pasting, while Xpod's own endpoints exist to be
 * copied into a client.
 */
export function AiEndpointList({ endpoints, copy = false, display = 'compact' }: {
  endpoints: readonly AiEndpointEntry[]
  copy?: boolean
  /**
   * `compact` shortens the address, `full` shows it in full.
   *
   * `protocol` drops the address and lists the accept-compatible protocols as
   * chips. Xpod publishes three protocols from one gateway, so two of them even
   * share an address: repeating it tells the reader less than naming the
   * protocol they should pick, and the address stays one click away.
   */
  display?: 'compact' | 'full' | 'protocol'
}) {
  if (display === 'protocol') {
    return (
      <ul className="flex flex-wrap gap-2">
        {endpoints.map((endpoint) => {
          const label = compatibleProtocolLabel(endpoint.protocol)
          return (
            <li key={endpoint.protocol}>
              {copy ? (
                <AiCopyButton
                  value={endpoint.baseUrl}
                  label={`${label} 地址`}
                  text={label}
                  variant="outline"
                  className="h-7 gap-1.5 px-2 text-[11px] font-normal"
                  iconClassName="h-3 w-3"
                />
              ) : (
                <span className="inline-flex h-7 items-center rounded-md border border-border px-2 text-[11px] text-muted-foreground">
                  {label}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <dl className="space-y-1 text-[11px] text-muted-foreground">
      {endpoints.map((endpoint) => {
        const label = endpointProtocolLabel(endpoint.protocol)
        return (
          <div key={`${endpoint.protocol}:${endpoint.baseUrl}`} className="flex min-w-0 items-baseline gap-2">
            <dt className="shrink-0 text-foreground/70">{label}</dt>
            <dd className="min-w-0 truncate font-mono" title={endpoint.baseUrl}>
              {display === 'full' ? endpoint.baseUrl : endpointDisplayValue(endpoint.baseUrl)}
            </dd>
            {copy ? (
              <dd className="shrink-0">
                <AiCopyButton
                  value={endpoint.baseUrl}
                  label={`${label} 地址`}
                  variant="ghost"
                  className="h-6 gap-1 px-1.5 text-[11px]"
                  iconClassName="h-3 w-3"
                />
              </dd>
            ) : null}
          </div>
        )
      })}
    </dl>
  )
}
