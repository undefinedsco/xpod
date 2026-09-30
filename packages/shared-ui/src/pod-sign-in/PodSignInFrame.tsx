import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '../utils'
import type { SignInPresentation } from './types'

export interface PodSignInFrameProps {
  presentation: SignInPresentation
  ariaLabel: string
  /** `page` only: the left column, provided by the application. */
  appIntro?: ReactNode
  /** The 360px wide body. */
  children: ReactNode
  /**
   * `dialog` only. `true` (default) draws a modal layer over the document;
   * `false` draws the same card inline, without modal semantics.
   */
  modal?: boolean
  /** Escape closes a modal dialog when the host provides this. */
  onClose?: () => void
  /** With `onClose`, draws a close button in the corner of a modal dialog. */
  closeLabel?: string
  /** `data-*` attributes placed on the frame element that carries the region / dialog role. */
  dataAttributes?: Record<`data-${string}`, string | undefined>
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Focus lands on the dialog itself when it opens (one Tab reaches the primary
 * action), Tab is kept inside, Escape closes, and focus returns to the opener.
 */
function useModalFocus(active: boolean, onClose?: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!active) return undefined
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onCloseRef.current) {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const root = ref.current
      if (!root) return
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) {
        event.preventDefault()
        root.focus()
        return
      }
      const index = items.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey
        ? (index <= 0 ? items.length - 1 : index - 1)
        : (index === items.length - 1 ? 0 : index + 1)
      event.preventDefault()
      items[next]?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      opener?.focus()
    }
  }, [active])

  return ref
}

const bodyClass = 'flex min-h-0 w-full max-w-[360px] flex-1 flex-col'

/**
 * Outer frame of every sign-in surface. `window` fills the host window,
 * `dialog` is a 400px layer, `page` is two columns. All three share the same
 * 360px body, so a state looks the same wherever the host places it.
 */
export function PodSignInFrame({
  presentation,
  ariaLabel,
  appIntro,
  children,
  modal = true,
  onClose,
  closeLabel,
  dataAttributes,
}: PodSignInFrameProps) {
  const isModal = presentation === 'dialog' && modal
  const dialogRef = useModalFocus(isModal, onClose)

  if (presentation === 'window') {
    return (
      <div
        role="region"
        aria-label={ariaLabel}
        data-pod-sign-in-frame="window"
        {...dataAttributes}
        className="pod-sign-in flex h-full min-h-[480px] w-full min-w-[320px] justify-center overflow-hidden bg-background text-foreground"
      >
        <div className={bodyClass}>{children}</div>
      </div>
    )
  }

  if (presentation === 'page') {
    return (
      <div
        role="region"
        aria-label={ariaLabel}
        data-pod-sign-in-frame="page"
        {...dataAttributes}
        className="pod-sign-in grid min-h-[100dvh] w-full bg-background text-foreground md:grid-cols-2"
      >
        {appIntro ? (
          <aside data-pod-sign-in="intro" className="hidden flex-col justify-center bg-muted px-12 py-10 md:flex">
            {appIntro}
          </aside>
        ) : null}
        <div className={cn('flex items-center justify-center px-4 py-8', appIntro ? '' : 'md:col-span-2')}>
          <div className={bodyClass}>{children}</div>
        </div>
      </div>
    )
  }

  const card = (
    <div
      ref={dialogRef}
      role={isModal ? 'dialog' : 'region'}
      aria-modal={isModal ? true : undefined}
      aria-label={ariaLabel}
      tabIndex={-1}
      data-pod-sign-in-frame="dialog"
      {...dataAttributes}
      className={cn(
        'pod-sign-in relative flex max-h-[90dvh] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-lg focus:outline-none motion-safe:animate-in motion-safe:fade-in-0',
      )}
    >
      {isModal && onClose && closeLabel ? (
        <button
          type="button"
          aria-label={closeLabel}
          className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
      <div className={cn(bodyClass, 'mx-auto')}>{children}</div>
    </div>
  )

  return isModal ? (
    <div className="fixed inset-0 z-[var(--layer-modal)] flex items-center justify-center bg-background/80 p-4">{card}</div>
  ) : (
    <div className="flex w-full items-center justify-center p-4">{card}</div>
  )
}
