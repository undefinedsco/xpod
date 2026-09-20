import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { Button, cn } from '@undefineds.co/shared-ui'
import { Check, Copy } from 'lucide-react'

const CLIPBOARD_UNAVAILABLE = '当前浏览器无法访问剪贴板，请允许剪贴板访问后重试。'

/**
 * One clipboard affordance for the whole applet: the copied flag, its reset
 * timer, and the "no clipboard access" failure all live here instead of being
 * re-implemented by every caller that hands a value to the user.
 */
export function useCopyToClipboard(resetMs = 1500) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = useCallback(async (value: string) => {
    if (!navigator.clipboard?.writeText) throw new Error(CLIPBOARD_UNAVAILABLE)
    await navigator.clipboard.writeText(value)
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), resetMs)
  }, [resetMs])

  return { copied, copy }
}

/**
 * Copy button carrying the applet's established affordance: a `复制 <what>`
 * accessible name, the visible label swapping to `已复制`, and a check glyph in
 * place of the copy glyph for the length of the feedback window.
 */
export function AiCopyButton({
  value,
  label,
  text,
  title,
  variant = 'outline',
  size = 'sm',
  disabled = false,
  className,
  iconClassName = 'h-3.5 w-3.5',
  copiedIconClassName,
  onError,
}: {
  /**
   * Text to copy. A function is resolved when the button is pressed, for
   * secrets that only exist for the length of one flow.
   */
  value: string | (() => string)
  /** What is copied; the accessible name becomes `复制 ${label}`. */
  label: string
  /** Visible label. Omit for an icon-only button. */
  text?: string
  title?: string
  variant?: ComponentProps<typeof Button>['variant']
  size?: ComponentProps<typeof Button>['size']
  disabled?: boolean
  className?: string
  iconClassName?: string
  copiedIconClassName?: string
  onError?: (cause: unknown) => void
}) {
  const { copied, copy } = useCopyToClipboard()
  const iconOnly = text === undefined
  const Icon = copied ? Check : Copy

  const handleClick = () => {
    void (async () => {
      try {
        await copy(typeof value === 'function' ? value() : value)
      } catch (cause) {
        onError?.(cause)
      }
    })()
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={disabled}
      className={className}
      aria-label={`复制 ${label}`}
      title={title ?? `复制 ${label}`}
      onClick={handleClick}
    >
      <Icon aria-hidden="true" className={cn(iconClassName, copied && copiedIconClassName)} />
      <span className={iconOnly ? 'sr-only' : 'ml-1.5'}>{copied ? '已复制' : text ?? '复制'}</span>
    </Button>
  )
}
