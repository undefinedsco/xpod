/**
 * Give every packed macOS bundle a valid ad-hoc signature.
 *
 * electron-builder only signs when a Developer ID identity is configured. Without
 * one, arm64 binaries keep the linker's ad-hoc signature, which does not seal the
 * bundle resources at all: `codesign --verify` rejects the shipped app with
 * "code has no resources but signature indicates they must be present". Sealing
 * the bundle here keeps the app's own integrity checkable and gives the desktop
 * self-updater something to verify on every later release.
 *
 * The hook must stay in `afterPack`: electron-builder only runs `afterSign` when
 * it signed something itself (`skipping "afterSign" hook as no signing occurred`).
 */

const { execFileSync } = require('node:child_process')
const path = require('node:path')

async function afterPackAdhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' })
  console.log(`[xpod-desktop] ad-hoc signed ${appPath}`)
}

module.exports = afterPackAdhocSign
module.exports.default = afterPackAdhocSign
