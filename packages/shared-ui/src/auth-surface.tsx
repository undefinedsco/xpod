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

export interface AuthSurfaceProps {
  mode: AuthSurfaceMode
  title: string
  children: ReactNode
  onClose?: () => void
  closeLabel?: string
  closeOnEscape?: boolean
  className?: string
}

export function AuthSurfaceBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-testid="auth-surface-body"
      className={cn('min-h-0 max-h-[min(80vh,48rem)] overflow-y-auto', className)}
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
  onClose,
  closeLabel,
  closeOnEscape = true,
  className,
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
      ;(focusable[0] ?? surface).focus()
    }

    return () => {
      restoreFocusRef.current?.focus()
      restoreFocusRef.current = null
    }
  }, [mode])

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

  return (
    <div
      data-testid={`auth-surface-${mode}`}
      data-auth-surface-mode={mode}
      className={cn(
        mode === 'modal'
          ? 'fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4'
          : 'flex min-h-0 w-full items-center justify-center p-4',
        className,
      )}
    >
      <Card
        ref={surfaceRef}
        {...dialogProps}
        tabIndex={-1}
        className={cn(
          'relative flex min-h-0 w-full flex-col border-border bg-card text-card-foreground',
          mode === 'embedded' ? 'max-w-none shadow-none' : 'max-w-lg',
        )}
      >
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
        <AuthSurfaceBody>{children}</AuthSurfaceBody>
      </Card>
    </div>
  )
}
