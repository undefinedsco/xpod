# Xpod / Linx Layout Alignment Design

## Goal

Make Xpod-hosted applets use the same workspace geometry and interaction ownership as Linx, so an applet looks and behaves consistently when run standalone in Xpod or embedded in Linx.

## Approved Direction

Use the Linx workspace contract without a host-specific variant:

- primary application rail: `60px`
- applet list pane: `210px` default width
- list pane header: `48px`
- content pane header: `48px`
- search input height: `32px`
- list header horizontal padding: `12px`
- content header horizontal padding: `16px`

The primary rail uses icons rather than a wide settings menu. Xpod may expose different first-level destinations from Linx, but it must use the same geometry, spacing, borders, and active-state language.

## Search and Add Ownership

Search and Add belong to the applet list pane, not the host shell.

For AI Connection:

- the search field and Add button share the 48px list header;
- search filters providers/connections shown in the list pane;
- Add starts the connection-creation flow;
- the content pane header shows the selected connection or provider title;
- the host shell must not render an additional global search header above the applet.

This keeps the applet self-contained and prevents duplicate headers when mounted inside Linx.

## SDK Boundary

`@undefineds.co/extension-sdk` owns the workspace geometry and semantic slots. It provides the rail/list/content structure and stable layout tokens. Applets supply list-header, list-content, content-header, and content-body nodes; they do not hard-code host dimensions.

`@undefineds.co/shared-ui` owns shared visual primitives and theme tokens. AI Connection owns only provider-specific interaction and content.

The Xpod dashboard is a host of the same SDK layout. It may choose Xpod-specific rail destinations (Models, Pod, Network, Services), but it must not introduce a second layout system.

## Responsive Behavior

At narrow widths, preserve the existing SDK stack navigation behavior. The desktop geometry above applies when the split layout is active. Search remains attached to the list pane when panes stack.

## Acceptance Criteria

1. Xpod Models renders a 60px primary rail, a 210px list pane, and a flexible content pane at desktop width.
2. The list and content headers align at exactly 48px.
3. AI Connection search and Add render together in the list header.
4. No global Xpod settings search header appears above the applet.
5. Xpod first-level navigation uses icon-sized controls consistent with Linx.
6. Existing SDK stack/mobile navigation continues to work.
7. Layout tests assert the dimensions and slot ownership rather than relying only on screenshots.
8. A browser comparison at the same viewport confirms aligned borders, header baselines, and pane widths.

## Out of Scope

- changing AI provider data or authentication behavior;
- redesigning Linx itself;
- Electron tray behavior;
- adding a host-wide settings search feature.
