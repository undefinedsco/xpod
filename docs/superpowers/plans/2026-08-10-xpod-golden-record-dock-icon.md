# Xpod Golden Record Dock Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Xpod's plain purple macOS Dock placeholder with the approved abstract golden-record icon and ship it in a verified DMG.

**Architecture:** Generate one 1024×1024 master raster from the approved design, then derive every macOS icon size mechanically from that master. Keep Dock assets independent from the existing menu-bar template icons, and verify both small-size legibility and the packaged `icon.icns`.

**Tech Stack:** Image generation, macOS `sips`, `iconutil`, Electron Builder, Bun tests

---

### Task 1: Generate and select the master icon

**Files:**
- Modify: `desktop/assets/icon.png`
- Create: `desktop/assets/icon-master.png`

- [ ] **Step 1: Preserve the current visual baseline**

Inspect `desktop/assets/icon.png` at original resolution and record that it is a plain purple squircle with no foreground symbol.

- [ ] **Step 2: Generate the approved icon**

Generate a square 1024×1024 raster using the design spec: deep-purple macOS squircle; centered matte-gold disc made from incomplete concentric tracks; subtly offset aperture; lower-right negative-space interruption suggesting an X; no text, chrome, glitter, or music-player controls.

- [ ] **Step 3: Inspect the master**

Open the generated image at original size. Reject it if the disc resembles a literal vinyl record, contains text, lacks safe padding, or loses the lower-right interruption.

- [ ] **Step 4: Install the selected master**

Copy the selected lossless raster to both `desktop/assets/icon-master.png` and `desktop/assets/icon.png`, preserving 1024×1024 dimensions.

### Task 2: Build and verify macOS icon assets

**Files:**
- Create: `desktop/assets/icon.iconset/icon_16x16.png`
- Create: `desktop/assets/icon.iconset/icon_16x16@2x.png`
- Create: `desktop/assets/icon.iconset/icon_32x32.png`
- Create: `desktop/assets/icon.iconset/icon_32x32@2x.png`
- Create: `desktop/assets/icon.iconset/icon_128x128.png`
- Create: `desktop/assets/icon.iconset/icon_128x128@2x.png`
- Create: `desktop/assets/icon.iconset/icon_256x256.png`
- Create: `desktop/assets/icon.iconset/icon_256x256@2x.png`
- Create: `desktop/assets/icon.iconset/icon_512x512.png`
- Create: `desktop/assets/icon.iconset/icon_512x512@2x.png`
- Create: `desktop/assets/icon.icns`

- [ ] **Step 1: Derive exact iconset sizes**

Run `sips -z` from the 1024 px master for 16, 32, 64, 128, 256, 512, and 1024 px outputs using Apple's iconset filenames.

- [ ] **Step 2: Compile the iconset**

Run `iconutil -c icns desktop/assets/icon.iconset -o desktop/assets/icon.icns` and require exit code 0.

- [ ] **Step 3: Verify dimensions and small-size appearance**

Run `sips -g pixelWidth -g pixelHeight` on the master and each iconset file. Inspect a contact sheet containing 16, 32, 64, 128, 256, 512, and 1024 px versions; require the gold disc and purple silhouette to remain distinct at 16–32 px.

### Task 3: Package and validate Xpod

**Files:**
- Modify: `desktop/release/mac-arm64/Xpod.app/Contents/Resources/icon.icns`
- Modify: `desktop/release/Xpod-0.1.0-arm64.dmg`

- [ ] **Step 1: Protect tray behavior with tests**

Run `cd desktop && bun test` and require all tray and runtime-manager tests to pass, proving the Dock asset change did not alter menu-bar status assets.

- [ ] **Step 2: Build the application and DMG**

Run `cd desktop && bun run dist` and require Electron Builder to produce the arm64 App, ZIP, and DMG.

- [ ] **Step 3: Verify the packaged icon**

Compare the SHA-256 of `desktop/assets/icon.icns` with `desktop/release/mac-arm64/Xpod.app/Contents/Resources/icon.icns`; require identical hashes.

- [ ] **Step 4: Smoke-test and verify the disk image**

Run the packaged app with `XPOD_DESKTOP_SMOKE=1`, require `smoke ok`, then run `hdiutil verify desktop/release/Xpod-0.1.0-arm64.dmg` and require a valid checksum.

- [ ] **Step 5: Report the artifact**

Return the absolute DMG path, SHA-256, the master-icon preview, and the explicit remaining limitation that the development build is unsigned and not notarized.
