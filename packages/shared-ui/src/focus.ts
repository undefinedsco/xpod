/**
 * Shared keyboard-focus treatments for controls and other interactive items.
 *
 * Framed form controls use their existing border for focus. An offset outline
 * adds a second boundary even when the native blue ring has been removed.
 */
export const controlFocusClass =
  'focus:[outline:none] focus:[box-shadow:none] focus:border-ring focus-visible:[outline:none] focus-visible:border-2 focus-visible:border-ring'

export const interactiveFocusClass =
  'focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * Buttons communicate keyboard focus through their existing surface instead
 * of drawing a second frame around the control.
 */
export const buttonFocusClass =
  'focus:outline-none focus:ring-0 focus-visible:outline-none'
