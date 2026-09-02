/**
 * Shared keyboard-focus treatments for controls and other interactive items.
 *
 * Keep these as a single outline. Stacking Tailwind rings and ring offsets on
 * top of a native form focus border creates the double-frame effect that this
 * package intentionally avoids.
 */
export const controlFocusClass =
  'focus:outline-none focus:ring-0 focus-visible:border-ring'

export const interactiveFocusClass =
  'focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * Buttons communicate keyboard focus through their existing surface instead
 * of drawing a second frame around the control.
 */
export const buttonFocusClass =
  'focus:outline-none focus:ring-0 focus-visible:outline-none'
