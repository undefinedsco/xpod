import {
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react'
import { Button } from './button'
import { Card } from './card'
import { cn } from './utils'

export type AuthSurfaceMode = 'page' | 'modal' | 'embedded'
export type AuthSurfacePresentation = 'standard' | 'compact'
export type AuthSurfaceHost = 'document' | 'window'

export interface AuthSurfaceProps {
  mode: AuthSurfaceMode
  title: string
  children: ReactNode
  presentation?: AuthSurfacePresentation
  /**
   * `window` lets a native host make this surface the entire BrowserWindow
   * content instead of drawing a dialog card over a document backdrop.
   */
  host?: AuthSurfaceHost
  lead?: ReactNode
  onClose?: () => void
  closeLabel?: string
  closeOnEscape?: boolean
  className?: string
  frameClassName?: string
  contentClassName?: string
}

export function AuthSurfaceBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-testid="auth-surface-body"
      className={cn('min-h-0', className)}
    >
      {children}
    </div>
  )
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.getAttribute('aria-hidden') !== 'true')
}

export function AuthSurface({
  mode,
  title,
  children,
  presentation = 'standard',
  host = 'document',
  lead,
  onClose,
  closeLabel,
  closeOnEscape = true,
  className,
  frameClassName,
  contentClassName,
}: AuthSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const titleId = useId()

  useLayoutEffect(() => {
    if (mode !== 'modal' || typeof document === 'undefined') return undefined

    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const surface = surfaceRef.current
    if (surface) {
      const focusable = getFocusable(surface)
      // Compact auth cards start on the dialog itself so opening the card does
      // not paint a control as preselected. Keyboard users reach the first
      // action with one Tab; standard dialogs retain first-control focus.
      ;(presentation === 'compact' ? surface : focusable[0] ?? surface).focus()
    }

    return () => {
      restoreFocusRef.current?.focus()
      restoreFocusRef.current = null
    }
  }, [mode, presentation])

  useLayoutEffect(() => {
    if (mode !== 'modal' || typeof document === 'undefined') return undefined

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (closeOnEscape && onClose) {
          event.preventDefault()
          onClose()
        }
        return
      }
      if (event.key !== 'Tab') return

      const surface = surfaceRef.current
      if (!surface) return
      const focusable = getFocusable(surface)
      if (focusable.length === 0) {
        event.preventDefault()
        surface.focus()
        return
      }

      const current = document.activeElement
      const currentIndex = focusable.indexOf(current as HTMLElement)
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
        : (currentIndex === focusable.length - 1 ? 0 : currentIndex + 1)
      event.preventDefault()
      focusable[nextIndex].focus()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeOnEscape, mode, onClose])

  const dialogProps = mode === 'modal'
    ? {
        role: 'dialog' as const,
        'aria-modal': true as const,
        'aria-labelledby': titleId,
      }
    : {
        role: 'region' as const,
        'aria-labelledby': titleId,
      }
  const isCompact = presentation === 'compact'
  const isWindowHost = host === 'window'
  const bodyClassName = isCompact
    ? 'flex min-h-0 flex-1 flex-col overflow-y-auto'
    : 'max-h-[min(80vh,48rem)] overflow-y-auto'

  const surfaceContent = (
    <>
      {isCompact ? (
        <>
          <h1 id={titleId} className="sr-only">{title}</h1>
          {mode === 'modal' && onClose && closeLabel ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label={closeLabel}
              className="absolute right-2 top-2 z-10"
            >
              <span aria-hidden="true">×</span>
            </Button>
          ) : null}
        </>
      ) : (
        <div className="flex items-start justify-between gap-4 border-b border-border/60 p-4">
          <h1 id={titleId} className="text-lg font-semibold text-foreground">{title}</h1>
          {mode === 'modal' && onClose && closeLabel ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label={closeLabel}
            >
              <span aria-hidden="true">×</span>
            </Button>
          ) : null}
        </div>
      )}
      {lead ? (
        <div
          data-testid="auth-surface-lead"
          className={cn(
            isCompact
              ? 'shrink-0 px-5 pt-7 has-[[data-presentation=compact]]:pt-5'
              : 'border-b border-border/60 p-4',
          )}
        >
          {lead}
        </div>
      ) : null}
      <AuthSurfaceBody
        className={cn(
          bodyClassName,
          contentClassName,
        )}
      >
        {children}
      </AuthSurfaceBody>
    </>
  )

  return (
    <div
      data-testid={`auth-surface-${mode}`}
      data-auth-surface-mode={mode}
      data-auth-surface-presentation={isCompact ? 'compact' : undefined}
      data-auth-surface-host={isWindowHost ? 'window' : undefined}
      className={cn(
        isWindowHost
          ? 'fixed inset-0 z-50 flex items-stretch justify-stretch overflow-hidden bg-card p-0'
          : mode === 'modal'
          ? cn(
              'fixed inset-0 z-50 flex items-center justify-center p-4',
              isCompact ? 'bg-black/50' : 'bg-background',
            )
          : mode === 'page'
            ? 'flex min-h-[100dvh] w-full items-center justify-center bg-background p-4'
            : 'flex min-h-0 w-full items-center justify-center p-4',
        className,
      )}
    >
      {isWindowHost ? (
        <div
          ref={surfaceRef}
          {...dialogProps}
          data-auth-surface-frame="window"
          tabIndex={-1}
          className={cn(
            'relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-card text-card-foreground focus:outline-none',
            frameClassName,
          )}
        >
          {surfaceContent}
        </div>
      ) : (
        <Card
          ref={surfaceRef}
          {...dialogProps}
          tabIndex={-1}
          style={{ outline: 'none' }}
          className={cn(
            'relative flex min-h-0 w-full flex-col border-border bg-card text-card-foreground focus:outline-none',
            isCompact
              ? 'h-[400px] w-[280px] max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border-border/50 shadow-lg shadow-black/5'
              : mode === 'embedded' ? 'max-w-none shadow-none' : 'max-w-lg',
            frameClassName,
          )}
        >
          {surfaceContent}
        </Card>
      )}
    </div>
  )
}
