// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockWebExtensionHost } from '../src/testing'
import { useApplet } from '../src/react'
import { defineApplet, defineAppletLayout } from '../src/web'

describe('useApplet', () => {
  afterEach(cleanup)

  it('owns one controller and balances activation cleanup for all slots', () => {
    const controller = { selected: 'demo' }
    const deactivate = vi.fn()
    const activate = vi.fn(() => deactivate)
    const createController = vi.fn(() => controller)
    const applet = defineApplet({
      manifest: {
        appId: 'https://example.test/applets/demo',
        name: 'Demo',
        entry: '.',
        commands: [],
        layout: 'two-pane',
      },
      createController,
      activate,
      slots: {
        listHeader: ({ controller: value }) => <header>{value.selected} list header</header>,
        list: ({ controller: value }) => <nav>{value.selected} list</nav>,
        mainHeader: ({ controller: value }) => <header>{value.selected} main header</header>,
        main: ({ controller: value }) => <main>{value.selected} main</main>,
      },
    })
    const host = createMockWebExtensionHost()

    function Harness({ enabled = true }: { enabled?: boolean }) {
      const mounted = useApplet(applet, host, { enabled })
      return mounted
        ? <>{mounted.slots.listHeader}{mounted.slots.list}{mounted.slots.mainHeader}{mounted.slots.main}</>
        : <p>disabled</p>
    }

    const rendered = render(<Harness />)

    expect(screen.getByText('demo list header')).toBeTruthy()
    expect(screen.getByText('demo main header')).toBeTruthy()
    expect(screen.getByText('demo list')).toBeTruthy()
    expect(screen.getByText('demo main')).toBeTruthy()
    expect(createController).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledWith(controller, host)

    rendered.rerender(<Harness />)
    expect(createController).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledTimes(1)

    rendered.rerender(<Harness enabled={false} />)
    expect(screen.getByText('disabled')).toBeTruthy()
    expect(deactivate).toHaveBeenCalledTimes(1)

    rendered.unmount()
    expect(deactivate).toHaveBeenCalledTimes(1)
  })

  it('balances activation cleanup for descriptor two-pane applets', () => {
    const controller = { selected: 'descriptor demo' }
    const deactivate = vi.fn()
    const activate = vi.fn(() => deactivate)
    const createController = vi.fn(() => controller)
    const applet = defineApplet({
      manifest: {
        appId: 'https://example.test/applets/descriptor-demo',
        name: 'Descriptor Demo',
        entry: '.',
        commands: [],
        layout: 'two-pane',
      },
      createController,
      activate,
      layout: {
        descriptor: defineAppletLayout({ type: 'two-pane' }),
        slots: {
          listHeader: ({ controller: value }) => <header>{value.selected} list header</header>,
          list: ({ controller: value }) => <nav>{value.selected} list</nav>,
          mainHeader: ({ controller: value }) => <header>{value.selected} main header</header>,
          main: ({ controller: value }) => <main>{value.selected} main</main>,
        },
      },
    })
    const host = createMockWebExtensionHost()

    function Harness({ enabled = true }: { enabled?: boolean }) {
      const mounted = useApplet(applet, host, { enabled })
      return mounted
        ? <>{mounted.slots.listHeader}{mounted.slots.list}{mounted.slots.mainHeader}{mounted.slots.main}</>
        : <p>disabled</p>
    }

    const rendered = render(<Harness />)

    expect(screen.getByText('descriptor demo list header')).toBeTruthy()
    expect(screen.getByText('descriptor demo main header')).toBeTruthy()
    expect(screen.getByText('descriptor demo list')).toBeTruthy()
    expect(screen.getByText('descriptor demo main')).toBeTruthy()
    expect(createController).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledWith(controller, host)

    rendered.rerender(<Harness />)
    expect(createController).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledTimes(1)

    rendered.rerender(<Harness enabled={false} />)
    expect(screen.getByText('disabled')).toBeTruthy()
    expect(deactivate).toHaveBeenCalledTimes(1)

    rendered.unmount()
    expect(deactivate).toHaveBeenCalledTimes(1)
  })

  it('mounts single-pane applets through the same layout-neutral runtime', () => {
    const host = createMockWebExtensionHost()
    const controller = { label: 'single applet' }
    const deactivate = vi.fn()
    const activate = vi.fn(() => deactivate)
    const createController = vi.fn(() => controller)
    const applet = defineApplet({
      manifest: {
        appId: 'https://example.test/applets/single',
        name: 'Single',
        entry: '.',
        commands: [],
        layout: 'single-pane',
      },
      createController,
      activate,
      render: ({ controller: value }) => <main>{value.label}</main>,
    })

    function Harness() {
      const mounted = useApplet(applet, host)
      return mounted?.layout === 'single-pane' ? mounted.element : null
    }

    const rendered = render(<Harness />)

    expect(screen.getByText('single applet')).toBeTruthy()
    expect(createController).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledWith(controller, host)

    rendered.unmount()
    expect(deactivate).toHaveBeenCalledTimes(1)
  })

  it('mounts descriptor single-pane applets and cleans up activation', () => {
    const host = createMockWebExtensionHost()
    const controller = { label: 'descriptor single applet' }
    const deactivate = vi.fn()
    const activate = vi.fn(() => deactivate)
    const createController = vi.fn(() => controller)
    const applet = defineApplet({
      manifest: {
        appId: 'https://example.test/applets/descriptor-single',
        name: 'Descriptor Single',
        entry: '.',
        commands: [],
        layout: 'single-pane',
      },
      createController,
      activate,
      layout: {
        descriptor: defineAppletLayout({ type: 'single-pane' }),
        render: ({ controller: value }) => <main>{value.label}</main>,
      },
    })

    function Harness({ enabled = true }: { enabled?: boolean }) {
      const mounted = useApplet(applet, host, { enabled })
      return mounted?.layout === 'single-pane' ? mounted.element : <p>disabled</p>
    }

    const rendered = render(<Harness />)

    expect(screen.getByText('descriptor single applet')).toBeTruthy()
    expect(createController).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledWith(controller, host)

    rendered.rerender(<Harness enabled={false} />)
    expect(screen.getByText('disabled')).toBeTruthy()
    expect(deactivate).toHaveBeenCalledTimes(1)

    rendered.unmount()
    expect(deactivate).toHaveBeenCalledTimes(1)
  })
})
