import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@undefineds.co/shared-ui'
import { GripVertical } from 'lucide-react'
import type { AiProviderCredentialSummary } from './ai-connections-client'
import { credentialDisplayLabel } from './credential-labels'

export function AiSortableCredentialList({ credentials, disabled, onMove, children }: {
  credentials: AiProviderCredentialSummary[]
  disabled: boolean
  onMove?: (fromIndex: number, toIndex: number) => void
  children: (credential: AiProviderCredentialSummary, handle: ReactNode) => ReactNode
}) {
  const listRef = useRef<HTMLDivElement>(null)
  type Drag = {
    id: string; from: number; to: number; pointerId: number; startY: number; y: number
    handle: HTMLButtonElement; rows: HTMLElement[]; rects: DOMRect[]
  }
  const dragRef = useRef<Drag | null>(null)
  const frameRef = useRef<number | undefined>(undefined)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dropRef = useRef<Map<string, DOMRect> | null>(null)
  const dropOrderRef = useRef<string | undefined>(undefined)
  const busyRef = useRef(disabled)
  const [announcement, setAnnouncement] = useState('')
  const unavailable = disabled || !onMove || credentials.length < 2
  const order = credentials.map((credential) => credential.id).join('\0')
  const rows = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-sortable-credential]') ?? [])
  const clearMotion = () => {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
    if (timerRef.current !== undefined) clearTimeout(timerRef.current)
    frameRef.current = undefined
    timerRef.current = undefined
    for (const row of rows()) {
      for (const key of ['transform', 'transition', 'zIndex', 'position', 'boxShadow', 'willChange', 'backgroundColor'] as const) row.style[key] = ''
      delete row.dataset.dragging
    }
  }
  const settle = () => {
    const positions = dropRef.current
    if (!positions) return
    dropRef.current = null
    clearMotion()
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const elements = rows()
    for (const row of elements) {
      const previous = positions.get(row.dataset.sortableCredential!)
      if (!previous || reduced) continue
      const rect = row.getBoundingClientRect()
      row.style.transition = 'none'
      row.style.transform = `translateY(${previous.top - rect.top}px)`
    }
    // Commit the inverse positions before animating to the new document order.
    listRef.current?.getBoundingClientRect()
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined
      for (const row of elements) {
        row.style.transition = reduced ? 'none' : 'transform 160ms ease-out, box-shadow 160ms ease-out'
        row.style.transform = 'translateY(0px)'
      }
      timerRef.current = setTimeout(clearMotion, reduced ? 0 : 180)
    })
  }
  const finish = (commit: boolean) => {
    const drag = dragRef.current
    if (!drag) return
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
    dropRef.current = new Map(drag.rows.map((row) => [row.dataset.sortableCredential!, row.getBoundingClientRect()]))
    dropOrderRef.current = order
    if (commit && drag.from !== drag.to && !unavailable) {
      const source = drag.rects[drag.from]!
      const destination = drag.rects[drag.to]!
      const gap = Math.max(0, drag.rects[1]!.top - drag.rects[0]!.bottom)
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      drag.rows.forEach((row, index) => {
        const shift = index === drag.from
          ? drag.from < drag.to ? destination.bottom - source.bottom : destination.top - source.top
          : drag.from < index && index <= drag.to ? -(source.height + gap)
            : drag.to <= index && index < drag.from ? source.height + gap : 0
        row.style.transition = reduced ? 'none' : 'transform 160ms ease-out'
        row.style.transform = `translateY(${shift}px)`
        const rect = drag.rects[index]!
        dropRef.current!.set(row.dataset.sortableCredential!, { ...rect, top: rect.top + shift, bottom: rect.bottom + shift } as DOMRect)
      })
    }

    dragRef.current = null
    if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture?.(drag.pointerId)
    if (commit && !unavailable && credentials[drag.from]?.id === drag.id) move(drag.from, drag.to)
    // React's layout effect handles synchronous reorder; this handles no-op/async saves.
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined
      if (!commit || !busyRef.current) settle()
    })
    // A stalled save must not leave transformed rows indefinitely.
    timerRef.current = setTimeout(settle, 10_000)
  }
  const move = (from: number, to: number) => {
    if (unavailable || from === to || to < 0 || to >= credentials.length) return
    onMove?.(from, to)
    setAnnouncement(`已请求将${credentialDisplayLabel(credentials[from])}移至第 ${to + 1} 位`)
  }
  const lifecycleRef = useRef({ finish, settle, clearMotion })
  useLayoutEffect(() => {
    lifecycleRef.current = { finish, settle, clearMotion }
    busyRef.current = disabled
  })
  useLayoutEffect(() => {
    if (dragRef.current) lifecycleRef.current.finish(false)
    if (dropRef.current && (dropOrderRef.current !== order || !disabled)) lifecycleRef.current.settle()
  }, [order, unavailable, disabled])
  useEffect(() => () => {
    const drag = dragRef.current
    dragRef.current = null
    dropRef.current = null
    if (drag?.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture?.(drag.pointerId)
    lifecycleRef.current.clearMotion()
  }, [])
  const paintDrag = () => {
    frameRef.current = undefined
    const drag = dragRef.current
    if (!drag) return
    const source = drag.rects[drag.from]!
    const gap = drag.rects.length > 1
      ? Math.max(0, drag.rects[1]!.top - drag.rects[0]!.bottom) : 0
    drag.rows.forEach((row, index) => {
      const shift = index === drag.from ? drag.y - drag.startY
        : drag.from < index && index <= drag.to ? -(source.height + gap)
          : drag.to <= index && index < drag.from ? source.height + gap : 0
      row.style.transform = `translateY(${shift}px)`
    })
  }

  return (
    <div ref={listRef} className={cn(credentials.length > 0 && 'rounded-xl border border-border/70')}>
      <span className="sr-only" role="status">{announcement}</span>
      {credentials.map((credential, index) => (
        // `-of-type` rather than `first:`/`last:`: the status span above is the
        // container's first child, the rows after it are its only divs.
        <div key={credential.id} data-sortable-credential={credential.id}
          className="border-b border-border/60 first-of-type:rounded-t-xl last-of-type:rounded-b-xl last:border-b-0">
          {children(credential, onMove ? (
            <button type="button" disabled={unavailable}
              aria-label={`拖动排序 ${credentialDisplayLabel(credential)}`}
              title={credentials.length < 2 ? '至少添加两条连接后可拖动排序' : '拖动调整优先级，或使用方向键、Home / End 排序'}
              className="flex h-8 w-6 shrink-0 touch-none select-none items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40 enabled:cursor-grab active:cursor-grabbing"
              onKeyDown={(event) => {
                if (event.key === 'Escape') { finish(false); return }
                const next = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1
                  : event.key === 'Home' ? 0 : event.key === 'End' ? credentials.length - 1 : undefined
                if (next === undefined) return
                event.preventDefault()
                move(index, next)
              }}
              onPointerDown={(event) => {
                if (unavailable || event.button !== 0 || dragRef.current) return
                event.preventDefault()
                dropRef.current = null
                clearMotion()
                event.currentTarget.focus()
                event.currentTarget.setPointerCapture?.(event.pointerId)
                const elements = rows()
                const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
                dragRef.current = { id: credential.id, from: index, to: index, pointerId: event.pointerId,
                  startY: event.clientY, y: event.clientY, handle: event.currentTarget, rows: elements,
                  rects: elements.map((row) => row.getBoundingClientRect()) }
                for (const [rowIndex, row] of elements.entries()) {
                  row.style.willChange = 'transform'
                  row.style.transition = reduced || rowIndex === index ? 'none' : 'transform 160ms ease-out'
                  if (rowIndex === index) {
                    row.dataset.dragging = 'true'
                    row.style.position = 'relative'
                    row.style.zIndex = '10'
                    row.style.boxShadow = '0 8px 24px rgb(0 0 0 / 0.18)'
                    row.style.backgroundColor = 'hsl(var(--card))'
                  }
                }
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current
                if (!drag || drag.pointerId !== event.pointerId || unavailable) return
                drag.y = event.clientY
                let distance = Infinity
                drag.rects.forEach((rect, rowIndex) => {
                  const delta = Math.abs(event.clientY - (rect.top + rect.bottom) / 2)
                  if (delta < distance) { distance = delta; drag.to = rowIndex }
                })
                if (frameRef.current === undefined) frameRef.current = requestAnimationFrame(paintDrag)
              }}
              onPointerUp={(event) => {
                if (dragRef.current?.pointerId === event.pointerId) finish(true)
              }}
              onPointerCancel={(event) => {
                if (dragRef.current?.pointerId === event.pointerId) finish(false)
              }}
              onLostPointerCapture={(event) => {
                if (dragRef.current?.pointerId === event.pointerId) finish(false)
              }}
            ><GripVertical aria-hidden="true" className="h-4 w-4" /></button>
          ) : null)}
        </div>
      ))}
    </div>
  )
}
