import { useRef, type ReactNode } from 'react'
import { Button } from './button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog'

export interface ConfirmationDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  title: string
  description: ReactNode
  children?: ReactNode
  confirmLabel: string
  confirmVariant?: 'default' | 'destructive'
  cancelLabel: string
  pending?: boolean
  error?: string | null
  onConfirm(): void
}

/** Destructive confirmation: focus Cancel first, keep failures retryable. */
export function ConfirmationDialog({
  open, onOpenChange, title, description, children, confirmLabel, cancelLabel,
  pending = false, error, onConfirm, confirmVariant = 'destructive',
}: ConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next) }}>
      <DialogContent
        hideCloseButton
        className="w-[calc(100%_-_2rem)] max-h-[calc(100dvh_-_2rem)] overflow-y-auto"
        aria-busy={pending}
        onOpenAutoFocus={(event) => {
          returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          event.preventDefault()
          cancelRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocusRef.current?.isConnected) {
            event.preventDefault()
            returnFocusRef.current.focus()
          }
        }}
        onEscapeKeyDown={(event) => { if (pending) event.preventDefault() }}
        onInteractOutside={(event) => { if (pending) event.preventDefault() }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter className="gap-2">
          <Button ref={cancelRef} variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>{cancelLabel}</Button>
          <Button variant={confirmVariant} disabled={pending} onClick={onConfirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
