# Shared Linx Applet Shell Design

## Goal

Make standalone Xpod and embedded Linx applets render through the same Linx product shell, so an applet can be developed and tested independently without inventing its own navigation, spacing, colors, authentication frame, or pane behavior.

AI Connection is the first acceptance consumer. The shared contract must also support Pod, Network, and Services without embedding any of their business rules in the layout SDK.

## Product decisions

- The desktop shell is a Linx three-column layout: a 60px product rail, a 210px default resizable list pane, and an adaptive content pane.
- The product rail is icon-only. Visible names appear in tooltips, accessible labels, and the narrow-screen menu.
- The account avatar is the first control at the upper-left. It opens the current WebID and Pod identity, account switching or reauthentication, and sign-out actions.
- The primary module icons below the avatar are AI Connection, Pod, Network, and Services.
- The lower-left contains Settings and Help/About. Runtime health is not a primary module; an unobtrusive indicator appears near the lower controls and becomes prominent only for actionable failures.
- List and content headers share a 64px height and the same border, spacing, and background tokens.
- Every list pane uses the same search-plus-add header. Search is 32px high; add is a 32px square icon button; horizontal padding is 12px with an 8px gap.
- Standalone Xpod expands the same settings-oriented shell that Linx embeds. It does not introduce a separate Xpod visual language.
- The applet does not branch on `local` or `cloud`. Its data, capabilities, and endpoint descriptors express what is available.

## Ownership boundaries

### Extension SDK

`@undefineds.co/extension-sdk` owns framework-neutral layout descriptors and React shell primitives:

- `AppLayout`: the complete host shell, including the 60px rail and workspace region.
- `ProductRail`: account, primary module, and lower utility slots with Linx dimensions and interaction states.
- `ListPaneHeader`: the canonical search, add, and optional accessory row.
- `TwoPaneLayout` and `ThreePaneLayout`: resizable workspace composition and responsive pane selection.
- Layout tokens for widths, header heights, separators, backgrounds, focus states, and compact breakpoints.

The SDK exposes semantic props and slots, not Xpod-specific route names or provider logic. Consumers may choose icons and actions from their module registry, but may not override canonical dimensions with local CSS.

### Solid SDK

`@undefineds.co/solid-sdk` continues to own the single Solid runtime boundary, login surface contract, current session snapshot, Pod runtime, and capability access. Layout components consume an authentication state supplied by the host; they do not create another OIDC session or implement token fallback.

The browser session follows normal Solid OIDC expiration and reauthentication behavior. No browser Bearer/DPoP credential is copied into a server-side fallback.

### Linx host

Linx owns the module registry and route selection. Its existing `PrimaryLayout` becomes a thin host adapter around SDK shell primitives, or is removed once every route uses `AppLayout` directly. Linx remains the visual source of truth during migration: shared SDK tokens are extracted from Linx rather than approximated in Xpod.

### Xpod host

Xpod owns its standalone module registry, route wiring, system actions, and service adapters. It mounts the same `AppLayout` and does not keep a parallel `XpodSettingsLayout` style system. Xpod supplies real account, Pod, network, service, and AI Connection state to SDK slots.

### Applets

An applet owns its list data, selection, detail content, commands, loading states, and errors. It declares list and content slots plus semantic actions. It does not own the product rail, authentication shell, global settings, or pane measurements.

## Module map

| Icon | Primary entry | Responsibility |
| --- | --- | --- |
| Bot | AI Connection | Provider authentication, models, quota, gateway keys, and coding-client setup |
| Box | Pod | WebID, Pod URL, storage, collections, hydration, and encrypted credential-storage status |
| Network | Network | Reachability, domain, DDNS, certificates, tunnels, and diagnostics |
| Server | Services | Runtime lifecycle, health, logs, RDF/index services, and runtime configuration |

Account and Pod identity actions live under the upper-left avatar. Appearance, language, application settings, help, about, updates, and sign-out are not duplicated as primary entries; sign-out remains in the avatar menu while global configuration and help remain at the lower-left.

## Component and data flow

1. The host restores one Solid session through `SolidRuntimeProvider`.
2. The host builds a module registry from available capabilities and routes, without reading a deployment-mode flag.
3. `AppLayout` renders the account control, module rail, lower utilities, and active workspace.
4. The selected module supplies a list slot and a content slot. `ListPaneHeader` receives its real query value, add command, disabled state, and accessible labels.
5. `TwoPaneLayout` manages width, divider interaction, narrow-screen navigation, and focus transfer. The applet only receives semantic pane state when it needs to alter interaction behavior.
6. AI Connection reads and writes provider records through the Pod-backed service. SDK layout state never contains API keys, OAuth tokens, or provider credentials.

## States and errors

- Session restoration renders the shared authentication boundary in the workspace without removing or replacing the shell geometry.
- Empty lists retain the list header and show an empty-state action in the list body.
- Search and add remain disabled only when the active module cannot accept them; the header footprint remains unchanged.
- Module load failures render in the content pane with retry and diagnostic details. They do not collapse the list pane or replace the product shell.
- Global runtime failures set the lower-left status indicator. The indicator opens diagnostics and never becomes a fifth primary module.
- Expired Solid sessions return to the shared login flow. Provider OAuth expiry is reported on the affected provider and does not create another Solid session.
- Narrow screens preserve the same information architecture: the active workspace occupies the viewport, Back switches panes, and the product rail is exposed through a menu rather than compressed into the content.

## Visual contract

The SDK uses the exact Linx design tokens and component states:

- rail width: 60px;
- rail action: 36px square with 24px icon;
- list default width: 210px, resizable within Linx's supported minimum and maximum;
- list and content header height: 64px;
- list header horizontal padding: 12px;
- list header gap: 8px;
- search control and add control height: 32px;
- shared border color, background color, hover state, active accent, radius, typography, and focus ring.

These values are exported once. Linx and Xpod test against the exported contract instead of copying numeric constants.

## Migration

1. Add the canonical rail, header, and tokens to the extension SDK with behavior and accessibility tests.
2. Update the extension test host so it is the lightweight visual and interaction acceptance environment for any applet.
3. Migrate Linx `PrimaryLayout` to consume the SDK contract and verify no visual regression in existing modules.
4. Replace Xpod's custom settings shell and page-specific list headers with the shared components.
5. Mount AI Connection, Pod, Network, and Services through the same registry contract and remove superseded layout CSS and adapters.

Compatibility aliases may remain for one release, but new applets use the canonical APIs. No new dependency is required.

## Verification

- Extension SDK unit tests cover slot placement, icon-only accessible names, account and utility ordering, canonical dimensions, list search/add behavior, divider interaction, keyboard focus, and narrow mode.
- Solid SDK tests prove that the shell consumes one runtime/session and that expiry returns through the normal Solid OIDC flow.
- Linx component tests prove its module registry renders through the shared shell and keeps existing routes working.
- Xpod component tests use real adapters or deterministic in-memory service doubles; no clickable control is accepted if it is disconnected from its command.
- AI Connection acceptance verifies one API-key provider and one browser-OAuth provider end to end, Pod persistence, reload, quota display, deletion, and error recovery.
- Visual acceptance compares standalone Xpod and Linx at the same viewport: rail, list header, content header, borders, spacing, colors, active states, and typography must align.
- Before completion, run each repository's typecheck, focused tests, build, and Xpod's full `bun run test:integration` regression suite.

## Non-goals

- Moving AI provider credentials into SDK state.
- Adding a deployment-mode switch to applet APIs.
- Creating a fifth runtime-health primary entry.
- Making applets choose arbitrary shell spacing or colors.
- Reworking unrelated Linx modules beyond adopting the shared layout contract.
