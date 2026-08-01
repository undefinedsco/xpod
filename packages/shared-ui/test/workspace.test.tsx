import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AppletList,
  AppletListItem,
  TwoPaneWorkspace,
} from '../src'

describe('TwoPaneWorkspace', () => {
  it('renders semantic list and main regions', () => {
    const html = renderToStaticMarkup(
      <TwoPaneWorkspace
        header={<div>Search providers</div>}
        list={(
          <AppletList aria-label="AI 服务">
            <AppletListItem selected>OpenAI</AppletListItem>
          </AppletList>
        )}
        main={<section aria-label="OpenAI 详情">Details</section>}
      />,
    )

    expect(html).toContain('aria-label="AI 服务"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('aria-label="OpenAI 详情"')
    expect(html).toContain('data-testid="applet-header-pane"')
    expect(html).toContain('data-testid="applet-list-pane"')
    expect(html).toContain('data-testid="applet-main-pane"')
    expect(html).toContain('data-applet-pane="list"')
    expect(html).toContain('data-applet-pane="main"')
    expect(html).toContain('Search providers')
    expect(html).not.toContain('<main')
  })

  it('lets a Test Host force the narrow list-to-detail contract', () => {
    const html = renderToStaticMarkup(
      <TwoPaneWorkspace
        layoutMode="narrow"
        header={<div>Search providers</div>}
        list={<AppletList>Providers</AppletList>}
        main={<section>Details</section>}
      />,
    )

    expect(html).toContain('data-layout-mode="narrow"')
    expect(html).toContain('grid-cols-1')
    expect(html).toContain('inline-flex')
  })
})
