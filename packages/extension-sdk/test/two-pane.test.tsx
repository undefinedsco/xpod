import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createMockWebExtensionHost } from '../src/testing'
import {
  defineAppletLayout,
  mountApplet,
  mountTwoPaneApplet,
  type DescriptorSinglePaneAppletModule,
  type DescriptorThreePaneAppletModule,
  type DescriptorTwoPaneAppletModule,
  type WebExtensionModule,
  type TwoPaneAppletModule,
} from '../src/web'
import type { ExtensionManifest } from '../src/manifest'

describe('mountTwoPaneApplet', () => {
  it('types extension modules with descriptor three-pane manifests', () => {
    const module: WebExtensionModule = {
      manifest: {
        extensionId: 'https://example.test/extensions/descriptor-three',
        name: 'Descriptor Three Extension',
        version: '1.0.0',
        sdkVersion: '0.1.0',
        contributes: {
          applets: [{
            appId: 'https://example.test/applets/descriptor-three',
            name: 'Descriptor Three',
            entry: '.',
            commands: [],
            layout: 'three-pane',
          }],
        },
        dataModels: [],
        hostCapabilities: [],
      },
      applets: {
        descriptorThree: {
          manifest: {
            appId: 'https://example.test/applets/descriptor-three',
            name: 'Descriptor Three',
            entry: '.',
            commands: [],
            layout: 'three-pane',
          },
          layout: {
            descriptor: defineAppletLayout({ type: 'three-pane' }),
            slots: {
              listHeader: () => createElement('header'),
              list: () => createElement('nav'),
              mainHeader: () => createElement('header'),
              main: () => createElement('main'),
              context: () => createElement('aside'),
            },
          },
          createController: () => ({}),
        },
      },
    }

    const legacyManifest: ExtensionManifest = {
      extensionId: 'https://example.test/extensions/legacy',
      name: 'Legacy Extension',
      version: '1.0.0',
      sdkVersion: '0.1.0',
      contributes: {
        applets: [{
          appId: 'https://example.test/applets/legacy',
          name: 'Legacy',
          entry: '.',
          commands: [],
          layout: 'two-pane',
        }],
      },
      dataModels: [],
      hostCapabilities: [],
    }
    const legacyModule: WebExtensionModule = {
      manifest: legacyManifest,
      applets: {},
    }

    expect(module.manifest.contributes.applets[0]?.layout).toBe('three-pane')
    expect(legacyModule.manifest).toBe(legacyManifest)
  })

  it('creates one controller shared by list header, list, main header and main slots', () => {
    const controllers: object[] = []
    const module: TwoPaneAppletModule<object> = {
      manifest: {
        appId: 'https://example.test/applets/demo',
        name: 'Demo',
        entry: '.',
        commands: [],
        layout: 'two-pane',
      },
      createController: () => ({}),
      slots: {
        listHeader: ({ controller }) => {
          controllers.push(controller)
          return createElement('header', null, 'List header')
        },
        list: ({ controller }) => {
          controllers.push(controller)
          return createElement('nav', null, 'List')
        },
        mainHeader: ({ controller }) => {
          controllers.push(controller)
          return createElement('header', null, 'Main header')
        },
        main: ({ controller }) => {
          controllers.push(controller)
          return createElement('main', null, 'Main')
        },
      },
    }

    const mounted = mountTwoPaneApplet(module, createMockWebExtensionHost())
    renderToStaticMarkup(mounted.listHeader)
    renderToStaticMarkup(mounted.list)
    renderToStaticMarkup(mounted.mainHeader)
    renderToStaticMarkup(mounted.main)

    expect(Object.keys(mounted)).toEqual(['controller', 'listHeader', 'list', 'mainHeader', 'main'])
    expect(controllers).toHaveLength(4)
    expect(controllers[0]).toBe(controllers[1])
    expect(controllers[1]).toBe(controllers[2])
    expect(controllers[2]).toBe(controllers[3])
    expect(mounted.controller).toBe(controllers[0])
  })

  it('rejects an implementation that contradicts its manifest layout', () => {
    const malformed = {
      manifest: {
        appId: 'https://example.test/applets/malformed',
        name: 'Malformed',
        entry: '.',
        commands: [],
        layout: 'single-pane',
      },
      createController: () => ({}),
      slots: {
        listHeader: () => createElement('header'),
        list: () => createElement('nav'),
        mainHeader: () => createElement('header'),
        main: () => createElement('main'),
      },
    }

    expect(() => mountApplet(
      malformed as unknown as TwoPaneAppletModule<object>,
      createMockWebExtensionHost(),
    )).toThrow('single-pane')
  })

  it('mounts descriptor two-pane applets with the legacy mounted shape', () => {
    const controllers: object[] = []
    const module: DescriptorTwoPaneAppletModule<object> = {
      manifest: {
        appId: 'https://example.test/applets/descriptor-demo',
        name: 'Descriptor Demo',
        entry: '.',
        commands: [],
        layout: 'two-pane',
      },
      layout: {
        descriptor: defineAppletLayout({ type: 'two-pane' }),
        slots: {
          listHeader: ({ controller }) => {
            controllers.push(controller)
            return createElement('header', null, 'List header')
          },
          list: ({ controller }) => {
            controllers.push(controller)
            return createElement('nav', null, 'List')
          },
          mainHeader: ({ controller }) => {
            controllers.push(controller)
            return createElement('header', null, 'Main header')
          },
          main: ({ controller }) => {
            controllers.push(controller)
            return createElement('main', null, 'Main')
          },
        },
      },
      createController: () => ({}),
    }

    const mounted = mountApplet(module, createMockWebExtensionHost())
    renderToStaticMarkup(mounted.slots.listHeader)
    renderToStaticMarkup(mounted.slots.list)
    renderToStaticMarkup(mounted.slots.mainHeader)
    renderToStaticMarkup(mounted.slots.main)

    expect(mounted.layout).toBe('two-pane')
    expect(Object.keys(mounted.slots)).toEqual(['listHeader', 'list', 'mainHeader', 'main'])
    expect(controllers).toHaveLength(4)
    expect(controllers[0]).toBe(controllers[1])
    expect(controllers[1]).toBe(controllers[2])
    expect(controllers[2]).toBe(controllers[3])
    expect(mounted.controller).toBe(controllers[0])
  })

  it('mounts descriptor three-pane applets with context slots and context config', () => {
    const module: DescriptorThreePaneAppletModule<{ selected: string }> = {
      manifest: {
        appId: 'https://example.test/applets/three',
        name: 'Three',
        entry: '.',
        commands: [],
        layout: 'three-pane',
      },
      layout: {
        descriptor: defineAppletLayout({
          type: 'three-pane',
          context: { collapsible: true, initiallyCollapsed: true },
        }),
        slots: {
          listHeader: ({ controller }) => createElement('header', null, controller.selected),
          list: ({ controller }) => createElement('nav', null, controller.selected),
          mainHeader: ({ controller }) => createElement('header', null, controller.selected),
          main: ({ controller }) => createElement('main', null, controller.selected),
          context: ({ controller }) => createElement('aside', null, controller.selected),
        },
      },
      createController: () => ({ selected: 'three-pane' }),
    }

    const mounted = mountApplet(module, createMockWebExtensionHost())

    expect(mounted.layout).toBe('three-pane')
    expect(Object.keys(mounted.slots)).toEqual(['listHeader', 'list', 'mainHeader', 'main', 'context'])
    expect(mounted.contextConfig).toEqual({ collapsible: true, initiallyCollapsed: true })
    expect(renderToStaticMarkup(mounted.slots.context)).toContain('three-pane')
  })

  it('rejects descriptor layouts that contradict the manifest layout', () => {
    const module = {
      manifest: {
        appId: 'https://example.test/applets/descriptor-mismatch',
        name: 'Descriptor Mismatch',
        entry: '.',
        commands: [],
        layout: 'single-pane',
      },
      layout: {
        descriptor: defineAppletLayout({ type: 'two-pane' }),
        slots: {
          listHeader: () => createElement('header'),
          list: () => createElement('nav'),
          mainHeader: () => createElement('header'),
          main: () => createElement('main'),
        },
      },
      createController: () => ({}),
    }

    expect(() => mountApplet(
      module as unknown as DescriptorTwoPaneAppletModule<object>,
      createMockWebExtensionHost(),
    )).toThrow('Applet manifest layout single-pane does not match descriptor layout two-pane')
  })

  it('rejects descriptor two-pane applets with missing or invalid required slots', () => {
    const host = createMockWebExtensionHost()
    const base = {
      manifest: {
        appId: 'https://example.test/applets/malformed-two',
        name: 'Malformed Two',
        entry: '.',
        commands: [],
        layout: 'two-pane',
      },
      createController: () => ({}),
    }

    expect(() => mountApplet({
      ...base,
      layout: {
        descriptor: defineAppletLayout({ type: 'two-pane' }),
        slots: {
          list: () => createElement('nav'),
          main: () => createElement('main'),
        },
      },
    } as unknown as DescriptorTwoPaneAppletModule<object>, host)).toThrow(
      'Applet descriptor two-pane slot listHeader must be a function',
    )

    expect(() => mountApplet({
      ...base,
      layout: {
        descriptor: defineAppletLayout({ type: 'two-pane' }),
        slots: {
          listHeader: () => createElement('header'),
          list: () => createElement('nav'),
          mainHeader: () => createElement('header'),
          main: null,
        },
      },
    } as unknown as DescriptorTwoPaneAppletModule<object>, host)).toThrow(
      'Applet descriptor two-pane slot main must be a function',
    )
  })

  it('rejects descriptor three-pane applets with missing required slots', () => {
    const host = createMockWebExtensionHost()
    const base = {
      manifest: {
        appId: 'https://example.test/applets/malformed-three',
        name: 'Malformed Three',
        entry: '.',
        commands: [],
        layout: 'three-pane',
      },
      createController: () => ({}),
    }

    expect(() => mountApplet({
      ...base,
      layout: {
        descriptor: defineAppletLayout({ type: 'three-pane' }),
        slots: {
          listHeader: () => createElement('header'),
          list: () => createElement('nav'),
          mainHeader: () => createElement('header'),
          context: () => createElement('aside'),
        },
      },
    } as unknown as DescriptorThreePaneAppletModule<object>, host)).toThrow(
      'Applet descriptor three-pane slot main must be a function',
    )

    expect(() => mountApplet({
      ...base,
      layout: {
        descriptor: defineAppletLayout({ type: 'three-pane' }),
        slots: {
          listHeader: () => createElement('header'),
          list: () => createElement('nav'),
          mainHeader: () => createElement('header'),
          main: () => createElement('main'),
        },
      },
    } as unknown as DescriptorThreePaneAppletModule<object>, host)).toThrow(
      'Applet descriptor three-pane slot context must be a function',
    )
  })

  it('rejects descriptor single-pane applets with missing render functions', () => {
    const module = {
      manifest: {
        appId: 'https://example.test/applets/malformed-single',
        name: 'Malformed Single',
        entry: '.',
        commands: [],
        layout: 'single-pane',
      },
      layout: {
        descriptor: defineAppletLayout({ type: 'single-pane' }),
      },
      createController: () => ({}),
    }

    expect(() => mountApplet(
      module as unknown as DescriptorSinglePaneAppletModule<object>,
      createMockWebExtensionHost(),
    )).toThrow('Applet descriptor single-pane render must be a function')
  })

  it('rejects malformed descriptor layout containers before reading descriptor', () => {
    const host = createMockWebExtensionHost()
    const base = {
      manifest: {
        appId: 'https://example.test/applets/malformed-layout',
        name: 'Malformed Layout',
        entry: '.',
        commands: [],
        layout: 'two-pane',
      },
      createController: () => ({}),
    }

    expect(() => mountApplet({
      ...base,
      layout: null,
    } as unknown as DescriptorTwoPaneAppletModule<object>, host)).toThrow(
      'Applet descriptor layout must be an object',
    )

    expect(() => mountApplet({
      ...base,
      layout: {
        slots: {
          listHeader: () => createElement('header'),
          list: () => createElement('nav'),
          mainHeader: () => createElement('header'),
          main: () => createElement('main'),
        },
      },
    } as unknown as DescriptorTwoPaneAppletModule<object>, host)).toThrow(
      'Applet descriptor required',
    )

    expect(() => mountApplet({
      ...base,
      layout: {
        descriptor: { type: 'grid' },
        slots: {
          listHeader: () => createElement('header'),
          list: () => createElement('nav'),
          mainHeader: () => createElement('header'),
          main: () => createElement('main'),
        },
      },
    } as unknown as DescriptorTwoPaneAppletModule<object>, host)).toThrow(
      'Unsupported applet layout type: grid',
    )
  })
})
