# Xpod / Linx Layout Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Xpod render AI Connection with the same 60px rail, 210px list pane, 48px pane headers, and list-owned search/Add controls as Linx.

**Architecture:** The extension SDK owns the measurable workspace geometry and distinct list/content header slots. Xpod becomes a thin host that supplies its icon navigation, while AI Connection supplies search/Add in its list header and the selected provider title in its content header. Existing stacked navigation remains the narrow-screen fallback.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Bun workspaces, Bun test, Vitest, Vite, browser visual verification.

---

## File Structure

- `packages/extension-sdk/src/react/app-layout.tsx`: fixed 60px host rail with no host-global header.
- `packages/extension-sdk/src/react/workspace-layout.tsx`: 210px list pane and independent 48px list/content headers.
- `packages/extension-sdk/src/web.ts`: two-pane applet slot contract (`listHeader`, `list`, `mainHeader`, `main`).
- `packages/extension-sdk/test/app-layout.test.tsx`: host rail geometry regression.
- `packages/extension-sdk/test/workspace-layout.test.tsx`: pane/header geometry and stacked-mode regressions.
- `packages/extension-sdk/test/two-pane.test.tsx`: applet slot mounting contract.
- `ui/src/layout/XpodSettingsLayout.tsx`: Xpod icon rail only; no host search/header.
- `ui/src/layout/XpodSettingsLayout.test.tsx`: host behavior and accessibility regression.
- `packages/ai-connection/src/AiConnectionHeader.tsx`: list header search and Add control.
- `packages/ai-connection/src/AiConnectionMainHeader.tsx`: selected provider content title.
- `packages/ai-connection/src/index.ts`: register the two explicit header slots.
- `packages/ai-connection/test/extension.test.tsx`: slot ownership regression.
- `packages/ai-connection/test/interactions.test.tsx`: search and Add interaction regression.
- `ui/src/pages/settings/ModelsPage.tsx`: mount all four two-pane slots into SDK layout.
- `ui/src/pages/settings/ModelsPage.test.tsx`: integrated host/applet layout regression.

### Task 1: Lock and implement SDK geometry

**Files:**
- Modify: `packages/extension-sdk/test/app-layout.test.tsx`
- Modify: `packages/extension-sdk/test/workspace-layout.test.tsx`
- Modify: `packages/extension-sdk/src/react/app-layout.tsx`
- Modify: `packages/extension-sdk/src/react/workspace-layout.tsx`

- [ ] **Step 1: Write failing geometry tests**

Assert the rendered markup exposes the approved layout values:

```tsx
expect(html).toContain('gridTemplateColumns:60px minmax(0, 1fr)')
expect(html).not.toContain('data-app-layout-header')
expect(html).toContain('gridTemplateColumns:210px minmax(0, 1fr)')
expect(html).toContain('data-workspace-list-header="true"')
expect(html).toContain('data-workspace-main-header="true"')
expect((html.match(/h-12/g) ?? []).length).toBe(2)
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
bunx vitest run packages/extension-sdk/test/app-layout.test.tsx packages/extension-sdk/test/workspace-layout.test.tsx
```

Expected: failures show the current 240px rail, global 64px header, and missing independent pane headers.

- [ ] **Step 3: Implement minimal SDK geometry**

Change the host grid and two-pane API:

```tsx
const appLayoutGridStyle = {
  gridTemplateColumns: '60px minmax(0, 1fr)',
} satisfies CSSProperties

export interface TwoPaneLayoutProps {
  listHeader: ReactNode
  list: ReactNode
  mainHeader: ReactNode
  main: ReactNode
  mode?: TwoPaneLayoutMode
  history?: WorkspaceLayoutHistoryAdapter
  className?: string
}
```

Render `listHeader` and `mainHeader` inside their respective panes with `h-12 shrink-0 border-b border-border`, and make each pane a flex column whose body alone scrolls. Retain `210px minmax(0, 1fr)` and the current stacked pane visibility/navigation behavior.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: both files pass with zero failures.

- [ ] **Step 5: Commit SDK geometry**

Stage only the four files and commit with a Lore-formatted message describing the Linx geometry constraint.

### Task 2: Standardize two-pane applet header slots

**Files:**
- Modify: `packages/extension-sdk/test/two-pane.test.tsx`
- Modify: `packages/extension-sdk/test/react-runtime.test.tsx`
- Modify: `packages/extension-sdk/src/web.ts`

- [ ] **Step 1: Write failing slot-contract tests**

Update test applets to declare and expect four semantic slots:

```tsx
slots: {
  listHeader: () => createElement('header', null, 'list header'),
  list: () => createElement('aside', null, 'list'),
  mainHeader: () => createElement('header', null, 'main header'),
  main: () => createElement('main', null, 'main'),
}

expect(Object.keys(mounted.slots)).toEqual([
  'listHeader', 'list', 'mainHeader', 'main',
])
```

- [ ] **Step 2: Run focused slot tests and verify RED**

Run:

```bash
bunx vitest run packages/extension-sdk/test/two-pane.test.tsx packages/extension-sdk/test/react-runtime.test.tsx
```

Expected: type/runtime failures because the current contract requires `header` and does not mount `mainHeader`.

- [ ] **Step 3: Implement the semantic slot contract**

Replace the two-pane slot type and mounted slot mapping:

```ts
export type TwoPaneAppletSlots<TController, Database = unknown> = {
  listHeader: AppletSlot<TController, Database>
  list: AppletSlot<TController, Database>
  mainHeader: AppletSlot<TController, Database>
  main: AppletSlot<TController, Database>
}
```

Update descriptor validation, mounting, and three-pane extension so every two-pane applet supplies both header slots. Do not keep an ambiguous `header` alias because it would allow the old global-header pattern to return.

- [ ] **Step 4: Run slot and all extension SDK tests**

Run:

```bash
bunx vitest run packages/extension-sdk/test
```

Expected: all extension SDK tests pass.

- [ ] **Step 5: Commit the slot contract**

Stage only SDK source/tests and commit with a Lore directive that two-pane headers belong to panes, never the host.

### Task 3: Move AI Connection search/Add into the list header

**Files:**
- Modify: `packages/ai-connection/test/extension.test.tsx`
- Modify: `packages/ai-connection/test/interactions.test.tsx`
- Modify: `packages/ai-connection/src/AiConnectionHeader.tsx`
- Create: `packages/ai-connection/src/AiConnectionMainHeader.tsx`
- Modify: `packages/ai-connection/src/index.ts`

- [ ] **Step 1: Write failing AI Connection header tests**

Require the list header to contain search and Add without an `AI Connection` title, and require the main header to show the selected provider:

```tsx
expect(listHeaderHtml).toContain('aria-label="搜索 Provider"')
expect(listHeaderHtml).toContain('aria-label="添加 AI Connection"')
expect(listHeaderHtml).not.toContain('>AI Connection<')
expect(mainHeaderHtml).toContain('Kimi')
```

Add an interaction assertion that clicking Add selects the first provider whose product state is `unconfigured`; when every provider is already configured or connected, it selects the first provider. This reuses the existing provider configuration panel and does not introduce a second creation state model.

- [ ] **Step 2: Run focused AI Connection tests and verify RED**

Run:

```bash
bunx vitest run packages/ai-connection/test/extension.test.tsx packages/ai-connection/test/interactions.test.tsx
```

Expected: missing Add control, missing main-header slot, and obsolete `AI Connection` title failures.

- [ ] **Step 3: Implement the two headers**

Use the Linx list-header structure:

```tsx
<div className="flex h-full min-w-0 items-center gap-2 px-3">
  <div className="relative min-w-0 flex-1">{/* Search + 32px Input */}</div>
  <Button
    variant="ghost"
    size="icon"
    className="h-8 w-8 shrink-0"
    aria-label="添加 AI Connection"
    onClick={() => controller.selectFirstUnconfiguredProvider()}
  >
    <Plus className="h-4 w-4" />
  </Button>
</div>
```

Add `selectFirstUnconfiguredProvider()` to the controller interface and implementation. It reads the already-loaded provider state map in `PROVIDERS` order, selects the first `unconfigured` provider, and falls back to `PROVIDERS[0]`. `AiConnectionMainHeader` subscribes to `useSelectedProvider`, resolves the label from `PROVIDERS`, and renders it with `px-4 text-sm font-medium`. Register `listHeader`, `list`, `mainHeader`, and `main` in `aiConnectionApplet`.

- [ ] **Step 4: Run all AI Connection tests**

Run:

```bash
bunx vitest run packages/ai-connection/test
```

Expected: all AI Connection tests pass.

- [ ] **Step 5: Commit AI Connection headers**

Stage only AI Connection source/tests and commit with a Lore-tested trailer listing the focused suites.

### Task 4: Make Xpod a thin Linx-style host

**Files:**
- Modify: `ui/src/layout/XpodSettingsLayout.test.tsx`
- Modify: `ui/src/pages/settings/ModelsPage.test.tsx`
- Modify: `ui/src/layout/XpodSettingsLayout.tsx`
- Modify: `ui/src/pages/settings/ModelsPage.tsx`
- Modify: `ui/src/index.css`

- [ ] **Step 1: Write failing host integration tests**

Assert the host contains icon-only accessible navigation and no settings search/global header:

```tsx
expect(html).toContain('data-app-layout="workspace"')
expect(html).toContain('aria-label="Models"')
expect(html).not.toContain('aria-label="Search settings"')
expect(html).not.toContain('Xpod Settings')
expect(html).not.toContain('Runtime workspace')
```

Assert Models passes all semantic applet slots:

```tsx
expect(html).toContain('data-workspace-list-header="true"')
expect(html).toContain('data-workspace-main-header="true"')
expect(html).toContain('aria-label="搜索 Provider"')
```

- [ ] **Step 2: Run focused UI tests and verify RED**

Run:

```bash
cd ui && bun test src/layout/XpodSettingsLayout.test.tsx src/pages/settings/ModelsPage.test.tsx
```

Expected: current global search/title and missing pane-header slot assertions fail.

- [ ] **Step 3: Implement the thin host**

Remove `SettingsHostHeader`, settings search state, filtered navigation, and compact duplicate navigation. Render Xpod destinations as 36px icon controls centered inside the SDK 60px rail, with labels retained through `aria-label` and `title`. Mount Models as:

```tsx
<TwoPaneLayout
  listHeader={mounted.slots.listHeader}
  list={mounted.slots.list}
  mainHeader={mounted.slots.mainHeader}
  main={mounted.slots.main}
  mode="auto"
/>
```

Delete obsolete `.xpod-settings-shell > div > header` overrides from `ui/src/index.css`; do not add compensating pixel hacks outside SDK layout tokens.

- [ ] **Step 4: Run focused UI tests and verify GREEN**

Run the command from Step 2. Expected: both UI test files pass.

- [ ] **Step 5: Commit the Xpod host alignment**

Stage only the five UI files and commit with a Lore message recording that destinations differ but layout geometry must match Linx.

### Task 5: Full verification and visual acceptance

**Files:**
- Modify only if a verification failure identifies a scoped defect.

- [ ] **Step 1: Run package regression suites**

```bash
bun run build:packages
bun run test:packages
```

Expected: four package builds pass and all package tests pass.

- [ ] **Step 2: Run Xpod build checks**

```bash
bun run build:ts
bun run build:ui
```

Expected: both commands exit 0; existing chunk-size/eval warnings may remain, with no new errors.

- [ ] **Step 3: Run complete integration regression**

```bash
bun run test:integration
```

Expected: Lite and Full suites pass; skipped tests remain explicitly reported.

- [ ] **Step 4: Compare in the browser at one viewport**

Open `http://localhost:3000/dashboard/models` at 1280px width and verify from computed element rectangles:

```text
primary rail width = 60px
list pane width = 210px
list header height = 48px
main header height = 48px
list and main header top/bottom coordinates match
search and Add are descendants of list header
```

Capture a screenshot and confirm console errors are empty.

- [ ] **Step 5: Final scoped commit if verification required fixes**

Stage only files changed to correct verified defects. Leave existing `static/app` and local backup/data changes untouched.
