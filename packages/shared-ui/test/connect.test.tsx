import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ConnectHeader,
  ConnectSurface,
  SolidConnectForm,
} from '../src'

describe('shared connect components', () => {
  it('renders the connect surface with the shared layout shell', () => {
    const html = renderToStaticMarkup(
      <ConnectSurface labelledBy="connect-title">
        <div>content</div>
      </ConnectSurface>,
    )

    expect(html).toContain('data-auth-boundary="surface"')
    expect(html).toContain('aria-labelledby="connect-title"')
    expect(html).toContain('bg-layout-content')
    expect(html).toContain('content')
  })

  it('renders the Solid connect form with an accessible labelled input', () => {
    const html = renderToStaticMarkup(
      <SolidConnectForm defaultIssuer="https://pod.example.com" onConnect={() => undefined} />,
    )

    expect(html).toContain('Solid Pod 地址')
    expect(html).toContain('type="url"')
    expect(html).toContain('value="https://pod.example.com"')
    expect(html).toContain('type="submit"')
    expect(html).toContain('连接')
    expect(html).toContain('border-border/60')
  })

  it('disables the submit control while a connection is pending', () => {
    const html = renderToStaticMarkup(
      <SolidConnectForm defaultIssuer="https://pod.example.com" pending onConnect={() => undefined} />,
    )

    expect(html).toContain('连接中...')
    expect(html).toContain('disabled')
  })

  it('surfaces the external error through the shared alert pattern', () => {
    const html = renderToStaticMarkup(
      <SolidConnectForm error="issuer unreachable" onConnect={() => undefined} />,
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain('issuer unreachable')
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('aria-describedby')
    expect(html).toContain('text-destructive')
  })

  it('renders the connect header with title, description and logo', () => {
    const html = renderToStaticMarkup(
      <ConnectHeader
        title="连接 Solid Pod"
        titleId="connect-title"
        description="使用你的 WebID 登录"
        logo={<span>logo</span>}
      />,
    )

    expect(html).toContain('id="connect-title"')
    expect(html).toContain('连接 Solid Pod')
    expect(html).toContain('使用你的 WebID 登录')
    expect(html).toContain('logo')
  })
})
