/**
 * Ambient environment for the UI sources the tests import.
 *
 * The UI build gets these through `ui/tsconfig.app.json` (`types: ["vite/client"]`) and the
 * globals declared in `ui/src/*.d.ts`. The root test program compiles the same files when a test
 * imports them, so it has to see the same environment - otherwise `import.meta.env`, `*.svg`
 * imports and `window.__XPOD__` look undeclared here while they are perfectly valid in the app.
 */
/// <reference types="vite/client" />

declare global {
  /**
   * React's `act` reads this to decide whether it must flush work synchronously. Tests that drive a
   * component tree set it around their render calls and restore the previous value afterwards.
   */
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

export {};

