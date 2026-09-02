# Applet SDK

`@undefineds.co/extension-sdk` defines the boundary between an applet and the
host that runs it. An applet declares its identity, layout structure, and
content slots. The host owns authentication, Pod initialization, application
navigation, native capabilities, and final composition.

The first planned product consumer is Xpod. Xpod can use the same layout
language as Linx while exposing a settings-first entry such as Models, Pod,
Network, and Services. Linx production layout remains on its current
composition until a later migration.

## Layout responsibilities

The SDK has two layout layers:

- `AppLayout` is host-owned. It renders the outer application frame, including
  product navigation, host header, and the active applet surface.
- `SinglePaneLayout`, `TwoPaneLayout`, and `ThreePaneLayout` render applet
  workspaces inside the host frame. They own pane geometry, responsive
  list-to-detail navigation, separators, and scroll containment.

Applets do not render product navigation, inspect viewport width, or branch on
whether they run in Linx, Xpod, or a standalone host.

## Define an applet

New applets should use a descriptor-based layout module. The manifest keeps the
legacy layout field for extension discovery, and the `layout.descriptor` gives
hosts a portable workspace contract.

```tsx
import {
  defineApplet,
  defineAppletLayout,
  type WebExtensionHost,
} from '@undefineds.co/extension-sdk/web'

type NotesController = {
  host: WebExtensionHost
}

export const notesApplet = defineApplet({
  manifest: {
    appId: 'https://example.com/applets/notes',
    name: 'Notes',
    entry: '.',
    commands: [],
    layout: 'two-pane',
  },
  layout: {
    descriptor: defineAppletLayout({ type: 'two-pane' }),
    slots: {
      listHeader: () => <input aria-label="Search notes" />,
      list: () => <nav aria-label="Notes">Notes list</nav>,
      mainHeader: () => <h1>Notes</h1>,
      main: ({ controller }) => {
        const { pod } = controller.host.solid
        return pod.status === 'ready'
          ? <main>{pod.current.podUrl}</main>
          : <main>Pod unavailable</main>
      },
    },
  },
  createController: (host): NotesController => ({ host }),
})
```

Single-pane modules provide `layout.render`. Three-pane modules provide
`layout.slots.listHeader`, `list`, `mainHeader`, `main`, and `context`, plus
optional descriptor context:

```tsx
defineAppletLayout({
  type: 'three-pane',
  context: { collapsible: true, initiallyCollapsed: false },
})
```

## Compose from a host

The host creates one `WebExtensionHost`, calls `useApplet`, and resolves the
mounted layout variant to SDK workspace layouts. The surrounding `AppLayout`
belongs to the host, so Xpod and Linx can share geometry while keeping different
navigation models.

```tsx
import {
  AppLayout,
  SinglePaneLayout,
  ThreePaneLayout,
  TwoPaneLayout,
  useApplet,
} from '@undefineds.co/extension-sdk/react'
import type {
  AppletModule,
  WebExtensionHost,
} from '@undefineds.co/extension-sdk/web'

function AppletSurface({
  applet,
  host,
}: {
  applet: AppletModule
  host: WebExtensionHost
}) {
  const mounted = useApplet(applet, host)

  if (!mounted) return null

  if (mounted.layout === 'single-pane') {
    return <SinglePaneLayout main={mounted.element} />
  }

  if (mounted.layout === 'three-pane') {
    return (
      <ThreePaneLayout
        listHeader={mounted.slots.listHeader}
        list={mounted.slots.list}
        mainHeader={mounted.slots.mainHeader}
        main={mounted.slots.main}
        context={mounted.slots.context}
        contextConfig={mounted.contextConfig}
      />
    )
  }

  return (
    <TwoPaneLayout
      listHeader={mounted.slots.listHeader}
      list={mounted.slots.list}
      mainHeader={mounted.slots.mainHeader}
      main={mounted.slots.main}
    />
  )
}

export function XpodSettingsHost({
  applet,
  host,
}: {
  applet: AppletModule
  host: WebExtensionHost
}) {
  return (
    <AppLayout
      navigation={<nav aria-label="Xpod settings">Models / Pod / Network</nav>}
    >
      <AppletSurface applet={applet} host={host} />
    </AppLayout>
  )
}
```

`useApplet` creates one controller for a stable applet/host pair, calls
`activate` after mounting, and balances cleanup when disabled, replaced, or
unmounted. `mountTwoPaneApplet` remains as a low-level compatibility helper;
new hosts should prefer `useApplet` and the mounted layout union.

For stack-mode navigation, hosts may pass a `history` adapter to
`TwoPaneLayout` or `ThreePaneLayout`. The SDK moves focus to the active pane
and calls the adapter on user navigation, but it does not write to
`window.history` directly. Browser hosts can map the adapter to their router or
to `popstate` handling; embedded hosts can omit it.

## Authentication boundary

`SolidAuthBoundary` is the canonical WebID boundary. It maps the host-owned
`WebIdAuthState`, optional `StorageSelectionState`, and opaque route descriptors
to shared-ui views. It does not create a Solid session, start an OIDC flow,
persist tokens, or decide return-path behavior; the host owns those actions.

```tsx
import {
  SolidAuthBoundary,
  type WebIdAuthState,
  type WebIdLoginRouteDescriptor,
} from '@undefineds.co/extension-sdk/react'

function SolidGate({
  state,
  routes,
  onLogin,
  children,
}: {
  state: WebIdAuthState
  routes: readonly WebIdLoginRouteDescriptor[]
  onLogin: (routeId: string) => Promise<void>
  children: React.ReactNode
}) {
  return (
    <SolidAuthBoundary state={state} routes={routes} onLogin={onLogin}>
      {children}
    </SolidAuthBoundary>
  )
}
```

The legacy pre-route `AuthBoundary`/`LoginView` adapters have been removed.
New Xpod code uses one
host-selected route id with `SolidAuthBoundary` and never accepts an issuer or
provider string from an applet.

The host remains responsible for Solid OIDC operations, session restoration,
logout, token refresh, and return-path handling. This is the same contract when
the applet runs in Linx, Xpod, or an isolated test host.

### Xpod service-owned authentication

Xpod keeps two independent host sessions and applies them at service-route
boundaries rather than through one shell-wide gate:

- Account-only surfaces (such as Dashboard) require the host Account session;
  they do not initialize Solid or open a Pod.
- WebID-only hosts can use `SolidAuthBoundary` without an Account session.
- Pod-backed Xpod Settings authorize through WebID + the explicit
  `(webId, storageUrl)` binding selected by the host. Xpod's unified flow
  normally leaves an Account session available, but that Account session is
  not a route-authorization requirement. A remembered valid pair
  may be restored, while multiple or stale bindings require explicit recovery;
  the SDK never chooses the first response implicitly.

The Xpod WebID host owns one current-origin `/auth/callback` transaction, safe
return-path handling, and OIDC state/PKCE integration. Applets receive state
and callbacks, never Account/access/refresh-token values, callback state,
issuer/provider selection, or Cloud/local chooser controls. Account password
views and state contracts are Xpod product code and are not exported from
shared-ui or extension-sdk.

## Solid and data rules

An applet receives Solid through `host.solid`:

- Use `host.solid.session.fetch` for authenticated network requests.
- Read the already-opened database and collection state from the optional
  `host.solid.pod` capability; do not initialize Inrupt OIDC, drizzle-solid, or
  collections inside the applet. Identity-only hosts intentionally omit this
  capability.
- Call `host.solid.requireLogin()` when an anonymous standalone host needs
  login. The host supplies the shared login UI and OIDC flow.
- Import RDF schemas from `@undefineds.co/models`.
- Perform Pod CRUD with drizzle-solid. Collections own hydration and reactive
  query setup.
- Never accept or persist bearer tokens, DPoP material, API keys, or refresh
  tokens in browser storage. User AI credentials remain encrypted in the Pod
  through the Xpod service boundary.

Applet code must not branch on deployment shape such as local or cloud. Data and
capabilities should be self-describing through the host contract.

## Legacy compatibility

The previous applet shape is still supported:

```tsx
defineApplet({
  manifest: {
    appId: 'https://example.com/applets/legacy',
    name: 'Legacy',
    entry: '.',
    commands: [],
    layout: 'two-pane',
  },
  createController: (host) => ({ host }),
  slots: {
    listHeader: () => <input aria-label="Search legacy items" />,
    list: () => <nav>Items</nav>,
    mainHeader: () => <h1>Legacy</h1>,
    main: () => <main>Detail</main>,
  },
})
```

Keep this path for existing applets and tests. Prefer descriptors for new
applets so hosts can resolve layout structure consistently across products.

## Test independently

Use the SDK mock host to test applet behavior without launching Linx or
implementing OIDC. Tests can provide anonymous, ready, or failed Solid
capabilities.

```tsx
import { render, screen } from '@testing-library/react'
import { TwoPaneLayout, useApplet } from '@undefineds.co/extension-sdk/react'
import { createMockWebExtensionHost } from '@undefineds.co/extension-sdk/testing'

const host = createMockWebExtensionHost({ solid: readySolidCapability })

function Harness() {
  const mounted = useApplet(notesApplet, host)
  return mounted?.layout === 'two-pane'
    ? (
      <TwoPaneLayout
        mode="stack"
        listHeader={mounted.slots.listHeader}
        list={mounted.slots.list}
        mainHeader={mounted.slots.mainHeader}
        main={mounted.slots.main}
      />
    )
    : null
}

render(<Harness />)
screen.getByRole('heading', { name: 'Notes' })
```

A host typically composes `AppLayout`, `SolidAuthBoundary`, SDK workspace
layouts, and applets such as the AI Connection applet.

## Public entry points

- `@undefineds.co/extension-sdk`: framework-neutral manifest, layout,
  lifecycle, testing, and React exports for package-internal consumers.
- `@undefineds.co/extension-sdk/manifest`: manifest contracts.
- `@undefineds.co/extension-sdk/web`: applet definitions, layout descriptors,
  mounting, and host capabilities.
- `@undefineds.co/extension-sdk/react`: `AppLayout`, workspace layouts,
  `SolidAuthBoundary`, and `useApplet`. (The legacy `AuthBoundary`/`LoginView`
  adapters have been removed.)
- `@undefineds.co/extension-sdk/testing`: deterministic host test doubles.
