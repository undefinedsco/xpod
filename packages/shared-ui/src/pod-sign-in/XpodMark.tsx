import type { SVGProps } from 'react'

/**
 * Xpod product mark (brand asset `xpod-app.svg`). It is the default icon of the
 * sign-in service side; application icons always come from the host.
 */
export function XpodMark({ size = 24, ...props }: { size?: number } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height'>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <rect x="10" y="10" width="80" height="80" rx="18" fill="#563E84" />
      <g fill="#F7F4ED">
        <path d="M31 24H52V45H73V73Q73 76 70 76H31Q28 76 28 73V27Q28 24 31 24Z" />
        <path d="M58 24L76 39H58Z" />
      </g>
    </svg>
  )
}
