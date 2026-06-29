# Design

## Source of truth

- Status: Active draft
- Last refreshed: 2026-06-29
- Primary product surfaces:
  - Xpod runtime console at `/dashboard/*`
  - Xpod account/OIDC app at `/.account/*`
  - Service/status/log/config APIs consumed by the console and LinX
- Evidence reviewed:
  - `ui/src/index.css`: shadcn-style violet/neutral tokens, light/dark themes, layout tokens, typography utilities, card/button utilities.
  - `ui/src/pages/admin/AdminLayout.tsx`: existing dashboard shell with top status bar, sidebar, and admin pages.
  - `ui/src/components/ui/Sidebar.tsx`: current admin navigation for dashboard/logs/settings.
  - `ui/src/components/ui/StatusBar.tsx`: current compact service state and restart control.
  - `ui/src/pages/admin/DashboardPage.tsx`: current status/dashboard surface.
  - `ui/src/pages/admin/LogsPage.tsx`: current live logs surface.
  - `ui/src/pages/admin/SettingsPage.tsx`: current runtime settings surface.
  - `ui/src/App.tsx`: current incorrect coupling of admin settings into `/.account/settings/`.
  - `src/api/handlers/AdminHandler.ts`: admin status/config/log/restart API surface.
  - `src/runtime/Proxy.ts`: `/service/status` machine endpoint and `/dashboard/*` proxying.
  - `docs/multi-channel-access.md` and `docs/ngrok-user-tunnel-verification.md`: route/tunnel and diagnostics semantics.
- External references:
  - Open Design method: project-local design source of truth, explicit product surfaces, reusable component constraints.
  - shadcn/ui dashboard pattern: sidebar + cards + tables + badges using existing token system.
  - Vercel-style runtime logs: dense searchable logs, inspection-first, shareable evidence.
  - Cloudflare Tunnel-style network status: tunnel/provider health with actionable next steps.
  - Taste skill anti-slop principle: use brand/context-specific taste; avoid default AI-purple gradients and generic template aesthetics.

## Brand

- Personality: calm, technical, readable, operational, low-drama.
- Trust signals:
  - Clear service health with timestamps and concrete evidence.
  - Sanitized config summaries that never expose secrets.
  - Actionable error copy tied to observed failure codes.
  - Consistent status semantics across UI, APIs, and diagnostics export.
- Avoid:
  - Marketing landing-page visuals inside the runtime console.
  - Grafana-like monitoring complexity.
  - Hacker-terminal styling as the primary UI.
  - LinX product UI patterns that imply end-user app configuration.
  - Secret values in read APIs, screenshots, logs, or diagnostics bundles.

## Product goals

- Goals:
  - Let an operator or LinX user answer: “Is this Xpod running, where is it reachable, and why is access failing?”
  - Provide enough logs and diagnostics to hand off a failure without exposing credentials.
  - Keep necessary local runtime configuration available as an advanced admin tool.
  - Keep account/OIDC routes semantically separate from runtime admin routes.
- Non-goals:
  - Do not make Xpod a full product settings UI.
  - Do not manage user AI provider settings in Xpod runtime console; those belong in the user Pod/LinX.
  - Do not provide Pod content management here.
  - Do not implement a general monitoring dashboard with graphs and alert rules.
- Success signals:
  - A degraded network route can be understood from the status page without opening developer tools.
  - Diagnostics export contains service status, routes, tunnel/DDNS/heartbeat summaries, and recent errors, but no secrets.
  - Runtime settings are reachable under `/dashboard/settings`, not `/.account/settings/`.
  - Restart and configuration changes make required restart state explicit.

## Personas and jobs

- Primary personas:
  - Local Xpod user running a personal SP on a laptop/desktop.
  - LinX desktop/mobile user troubleshooting local SP connectivity.
  - Developer/operator validating tunnels, DDNS, P2P, or Cloud IDP + Local SP flows.
- User jobs:
  - Check whether CSS/API/Gateway are running.
  - Find the correct URL/route to access a local Pod.
  - Understand whether ngrok/Cloudflare/frp/public/LAN/P2P is currently usable.
  - Restart the local runtime after a controlled config change.
  - Copy or download a sanitized diagnostic bundle.
  - Advanced: change allowlisted local runtime settings when LinX is not available.
- Key contexts of use:
  - Local desktop browser on the same machine as Xpod.
  - Remote support session where a user sends diagnostics to a developer.
  - Manual verification of network/tunnel/P2P acceptance paths.

## Information architecture

- Primary navigation:
  - `Status`
  - `Logs`
  - `Settings`
- Core routes/screens:
  - `/dashboard/` redirects or defaults to `/dashboard/status`.
  - `/dashboard/status`: service health, access routes, config summary, restart, actionable errors.
  - `/dashboard/logs`: live logs, file tail, filters, diagnostics export.
  - `/dashboard/settings`: advanced local runtime settings only.
- Account route boundary:
  - `/.account/*` is only for identity, login, OIDC consent, account, and Pod creation flows.
  - Do not mount runtime settings under `/.account/settings/`.
- Content hierarchy:
  - Top status bar: current node, overall state, refresh/restart entry point.
  - Sidebar: section navigation only.
  - Page header: page purpose and primary action.
  - Cards/tables: concrete evidence, not decorative widgets.

## Design principles

- Operational truth first:
  - Show current state, timestamp, and evidence before recommendations.
- Explain reachability, not just health:
  - A service can be running while public access is broken. The UI must represent that distinction.
- Keep config subordinate:
  - Settings exist as an advanced runtime tool. Status and diagnostics are the primary console jobs.
- Secrets are write-only:
  - Tokens and keys may be replaced but never displayed or exported.
- Prefer stable primitives:
  - Reuse shadcn-style Card, Button, Input, Select, Badge, Table, and existing theme tokens.
- Low visual drama:
  - Use color for semantic status only. Avoid gratuitous gradients, charts, and animation.
- Flat taro violet:
  - Violet means a calm, flat taro/lavender accent, not neon purple, not blue-purple glow, and not gradient decoration.

## Visual language

- Color:
  - Use existing `ui/src/index.css` tokens.
  - Primary action: flat taro/lavender violet (`--primary`), with no gradient treatment.
  - Background/surfaces: neutral/zinc/slate token scale.
  - Avoid gradients in runtime console chrome, cards, buttons, and status decoration. If an existing helper such as `top-accent` uses a gradient, do not use it for the runtime console unless it has been converted to a flat accent.
  - Status colors:
    - Healthy/running: green.
    - Degraded/warning: amber.
    - Failed/error: red/destructive.
    - Unknown/disabled: muted gray.
  - Status colors must not be used as decorative accents outside state indication.
- Typography:
  - Use existing utilities: `.type-h1`, `.type-h2`, `.type-h3`, `.type-body`, `.type-caption`, `.type-label`.
  - Logs, URLs, ids, tokens-as-redacted, and diagnostic JSON use monospace.
- Spacing/layout rhythm:
  - Preserve current shell: 56px top bar, 192px sidebar, scrollable content area.
  - Page max width should favor readable operations content, roughly `max-w-6xl` for status/logs and `max-w-4xl` for settings.
  - Use 16–24px page/card gaps; compact rows for data-dense tables.
- Shape/radius/elevation:
  - Use existing radius scale; default cards are `rounded-xl` or token-equivalent.
  - Elevation stays subtle. Shadow is acceptable for page-level cards, not table rows.
- Motion:
  - Minimal. Use spinner only for refresh/restart/checking states.
  - No animated dashboards or moving charts.
- Imagery/iconography:
  - Lucide icons are acceptable for navigation and status actions.
  - Icons must not replace text labels for critical status.

## Components

- Existing components to reuse:
  - `AdminLayout`
  - `Sidebar`
  - `StatusBar`
  - `DashboardPage` as the base for the new Status page.
  - `LogsPage`
  - `SettingsPage`
  - Existing shared `Button`, `Card`, `Input`, `Select`, and table-like primitives.
- New/changed components:
  - `StatusSummaryCard`: overall health with primary evidence and last checked time.
  - `ServiceHealthCard`: CSS/API/Gateway/Tunnel compact service cards.
  - `RouteTable`: loopback/LAN/public/tunnel/P2P route rows with health and target.
  - `ConfigSummaryCard`: sanitized runtime config summary.
  - `ActionNeededCard`: human-readable reason and next step for degraded state.
  - `DiagnosticsPanel`: export/copy diagnostics preview and action.
  - `SecretField`: write-only secret replacement field showing configured/not configured.
  - `PendingChangesPanel`: settings diff summary and restart-required state.
- Variants and states:
  - Health: healthy, degraded, failed, unknown.
  - Route visibility: same-device, LAN, public, tunnel, P2P.
  - Settings secret: configured, not configured, replacing, dirty.
  - Logs: live, paused, filtered, empty, stream-error.
- Token/component ownership:
  - Xpod console must not introduce a new design system.
  - Add small components only when the same display pattern appears in at least two places.
  - Keep shared primitives compatible with current shadcn-style token contract.

## Page design: Status

- Route: `/dashboard/status`.
- Primary job: show service health, reachability, and what to do next.
- Primary actions:
  - Refresh.
  - Restart.
  - Copy status JSON.
  - Open logs.
- Required sections:
  - Overall status summary.
  - Service cards: Gateway, CSS, API, Tunnel.
  - Access route table: loopback, LAN, public, tunnel, P2P when applicable.
  - Node/Cloud coordination card: nodeId, spDomain, heartbeat age, DDNS, provision state.
  - Sanitized config summary: edition, baseUrl, storage root, tunnel provider, provider URL configured yes/no, config source.
  - Action-needed card when state is degraded or failed.
- Empty/error behavior:
  - If status API fails, show local console unavailable state and link to logs if available.
  - If route data is unavailable, show unknown rows with “not reported by runtime yet,” not blank space.

## Page design: Logs

- Route: `/dashboard/logs`.
- Primary job: inspect recent/runtime logs and export sanitized diagnostics.
- Primary actions:
  - Pause/resume live stream.
  - Clear client-side view.
  - Copy selected logs.
  - Export diagnostics.
- Required sections:
  - Filter bar: level, source, keyword, auto-scroll.
  - Live log viewport using monospace rows.
  - Log file tail selector: combined, error, stdout/stderr when available.
  - Diagnostics panel with included/excluded checklist.
  - Error-code explanation for known tunnel/network failures.
- Diagnostics must include:
  - `/service/status` summary.
  - service/admin status summary.
  - access routes.
  - tunnel status.
  - DDNS/heartbeat/provision state.
  - sanitized config summary.
  - recent errors/log tail.
  - version/build/runtime info.
- Diagnostics must exclude:
  - environment secrets.
  - API keys.
  - auth cookies.
  - client secrets.
  - ngrok/cloudflare/frp tokens.

## Page design: Settings

- Route: `/dashboard/settings`.
- Primary job: advanced local runtime configuration and controlled restart.
- Placement:
  - Keep in dashboard/admin namespace only.
  - Do not mount at `/.account/settings/`.
- Primary actions:
  - Save.
  - Save and Restart.
  - Reset unsaved changes.
- Required sections:
  - Warning banner: “Advanced runtime settings. Most users should configure Xpod from LinX.”
  - Runtime: mode, baseUrl, storage root, config source.
  - Network access: tunnel provider none/ngrok/cloudflare/sakura-frp/frp, provider-specific public URL/endpoint, secret replacement fields.
  - Cloud coordination: cloud endpoint, nodeId, spDomain, node token configured yes/no, service token configured yes/no.
  - Pending changes: allowlisted key diff, restart-required indication.
- Rules:
  - No arbitrary env editor by default.
  - Only allowlisted keys are editable.
  - Secrets are write-only; a loaded secret becomes “configured,” never its value.
  - Save response must say whether restart is required.
  - LinX remains the preferred configuration UX.

## Accessibility

- Target standard: WCAG 2.1 AA for contrast, keyboard operation, focus visibility, and form labeling.
- Keyboard/focus behavior:
  - Sidebar navigation, filters, restart, export, and settings forms must be reachable by keyboard.
  - Destructive/restart actions require visible focus and confirmation or clear affordance.
- Contrast/readability:
  - Status badges must pair color with text.
  - Logs must remain readable in light and dark modes.
- Screen-reader semantics:
  - Use headings for page sections.
  - Status indicators include textual labels and `aria-live` for refresh results where appropriate.
- Reduced motion and sensory considerations:
  - Respect reduced-motion preference; no non-essential animation.

## Responsive behavior

- Supported breakpoints/devices:
  - Desktop and laptop are primary.
  - Tablet should remain usable.
  - Phone is secondary but should not break basic status/log reading.
- Layout adaptations:
  - Desktop: fixed sidebar + top status bar.
  - Narrow screens: sidebar can collapse to icon/tabs; tables become stacked rows.
  - Logs keep horizontal overflow for long lines with copy affordance.
- Touch/hover differences:
  - Do not rely on hover-only details for critical status.
  - Buttons keep at least 40px hit target.

## Interaction states

- Loading:
  - Skeleton or muted “checking…” states for service/route cards.
  - Refresh buttons show spinner and remain bounded; no indefinite blocked page.
- Empty:
  - No logs: “No logs captured yet.”
  - No tunnel configured: show “none” with configuration guidance, not an error.
- Error:
  - Use observed error code when available.
  - Pair failure with next action.
- Success:
  - Save/status refresh confirms timestamp and whether restart is required.
- Disabled:
  - Disabled actions must explain why, especially Restart/Export.
- Offline/slow network:
  - If API calls timeout, keep last-known state with “stale” label.

## Content voice

- Tone: concise, factual, operational.
- Terminology:
  - Use “runtime,” “route,” “tunnel provider,” “Cloud IDP,” “Local SP,” “canonical URL,” and “diagnostics.”
  - Use “configured” / “not configured” for secrets.
  - Avoid ambiguous “direct” when the actual route is loopback/LAN/public/tunnel/P2P.
- Microcopy rules:
  - Prefer “what happened + why + next action.”
  - Example: “ngrok agent cannot connect to ngrok edge. Evidence: ERR_NGROK_8001. Try a network that can reach ngrok directly or configure another tunnel provider.”
  - Never tell users to paste secrets into diagnostics or screenshots.

## Implementation constraints

- Framework/styling system:
  - React + Vite dashboard app under `ui/src`.
  - Tailwind + shadcn-style tokens from `ui/src/index.css`.
  - Static dashboard output served from `static/dashboard` under `/dashboard/*`.
- Routing constraints:
  - `/service/status` is a machine JSON endpoint, not the visual page route.
  - Visual runtime console stays under `/dashboard/*`.
  - `/.account/*` remains identity/account/OIDC flow only.
- API constraints:
  - Admin config writes and restart must not remain unauthenticated public APIs in production-facing contexts.
  - Config read APIs must return sanitized summaries by default.
  - Secret values must be redacted at source, not only hidden by UI.
- Performance constraints:
  - Logs page must cap in-memory rows and avoid rendering unbounded log history.
  - Diagnostics export should be generated on demand.
- Compatibility constraints:
  - Existing dashboard static serving must keep working with `/dashboard/` base path.
  - Existing machine clients using `/service/status` must not be broken by page routing.
- Test/screenshot expectations:
  - Unit/source tests should assert `/.account/settings/` no longer points to runtime settings.
  - UI tests should cover status page degraded state, logs filters, and settings secret redaction.
  - API tests should cover config sanitization and restart/config authorization boundary when implemented.

## Open questions

- [ ] Should `/dashboard/settings` be visible in the sidebar by default, or nested behind “Advanced” on the Status page? Owner: product. Impact: discoverability vs accidental changes.
- [ ] Which local authentication mechanism gates config writes and restart: loopback-only, admin token, OS-level desktop session, or LinX-mediated token? Owner: security/product. Impact: production safety.
- [ ] Should diagnostics export be pure JSON first, or ZIP with logs plus JSON? Owner: engineering. Impact: implementation scope and support workflow.
- [ ] Should the console support dark mode toggle, or follow system/theme only? Owner: design. Impact: UI polish and testing matrix.
