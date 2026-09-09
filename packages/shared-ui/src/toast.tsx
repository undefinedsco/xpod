import { useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { interactiveFocusClass } from './focus'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './utils'

const TOAST_LIMIT = 3
const TOAST_DEFAULT_DURATION = 3_000

export const toastVariants = cva(
  'pointer-events-auto relative flex w-full items-start justify-between gap-3 overflow-hidden rounded-md border px-4 py-3 text-sm shadow-lg transition-opacity',
  {
    variants: {
      variant: {
        default: 'border-border bg-background text-foreground',
        destructive: 'border-destructive/30 bg-destructive/10 text-destructive',
        success: 'border-green-500/20 bg-green-500/15 text-green-600',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export interface ToastOptions extends VariantProps<typeof toastVariants> {
  title?: string
  description?: string
  duration?: number
  className?: string
}

export interface ToastItem {
  id: string
  title?: string
  description?: string
  variant: NonNullable<ToastOptions['variant']>
  className?: string
}

interface ToastEntry extends ToastItem {
  timer: ReturnType<typeof setTimeout>
}

let count = 0
let entries: ToastEntry[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function removeToast(id: string): void {
  const index = entries.findIndex((entry) => entry.id === id)
  if (index < 0) return
  clearTimeout(entries[index]!.timer)
  entries = entries.filter((entry) => entry.id !== id)
  emit()
}

export function dismissToast(id: string): void {
  removeToast(id)
}

export function toast(options: ToastOptions): string {
  count = (count + 1) % Number.MAX_SAFE_INTEGER
  const id = count.toString()
  const duration = options.duration ?? TOAST_DEFAULT_DURATION
  const entry: ToastEntry = {
    id,
    title: options.title,
    description: options.description,
    variant: options.variant ?? 'default',
    className: options.className,
    timer: setTimeout(() => removeToast(id), duration),
  }
  entries = [...entries.slice(-(TOAST_LIMIT - 1)), entry]
  emit()
  return id
}

export function useToast(): { toast: typeof toast; dismiss: typeof dismissToast } {
  return { toast, dismiss: dismissToast }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): ToastItem[] {
  return entries
}

export function Toaster({ className }: { className?: string }) {
  const toasts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return (
    <div
      aria-live="polite"
      role="status"
      className={cn(
        'pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2',
        className,
      )}
    >
      {toasts.map((item) => (
        <div key={item.id} className={cn(toastVariants({ variant: item.variant }), item.className)}>
          <div className="min-w-0 flex-1">
            {item.title ? <p className="font-medium">{item.title}</p> : null}
            {item.description ? <p className={cn(item.title ? 'mt-0.5' : undefined)}>{item.description}</p> : null}
          </div>
          <button
            type="button"
            aria-label="关闭通知"
            className={cn('shrink-0 rounded-sm opacity-60 transition-opacity hover:opacity-100', interactiveFocusClass)}
            onClick={() => dismissToast(item.id)}
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
