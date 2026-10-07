import * as React from 'react'
import { cn } from './utils'

export interface SegmentedControlOption<T extends string> {
  value: T
  /** Visible segment text. Omit when the segment is icon-only. */
  label?: React.ReactNode
  /** Decorative glyph rendered before the label. */
  icon?: React.ReactNode
  disabled?: boolean
  /** Accessible name for an icon-only segment. */
  'aria-label'?: string
}

export interface SegmentedControlProps<T extends string>
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'children' | 'defaultValue'> {
  value: T
  onValueChange: (value: T) => void
  options: ReadonlyArray<SegmentedControlOption<T>>
  /** Accessible name for the single-choice group. */
  ariaLabel: string
  /** Native radio group name. Generated when omitted so the radios stay one group. */
  name?: string
  size?: 'sm' | 'md'
}

const sizeClass: Record<NonNullable<SegmentedControlProps<string>['size']>, string> = {
  // Height is a lower bound: 36px for precise pointers, 44px for coarse ones.
  sm: 'min-h-9 px-2.5 text-xs [@media(pointer:coarse)]:min-h-11',
  md: 'min-h-9 px-3 text-sm [@media(pointer:coarse)]:min-h-11',
}

const selectedClass = 'bg-card font-semibold text-primary shadow-sm'
const idleClass = 'text-foreground hover:text-primary'

/**
 * Single-choice segmented control backed by a native radio group.
 *
 * Controlled via `value` / `onValueChange`; disabled options are skipped by
 * pointer and by the roving Arrow/Home/End keyboard model. When a caller needs
 * to switch tab panels, use a tablist instead: this control truthfully exposes
 * radio semantics for filters and view toggles.
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  name,
  size = 'md',
  className,
  onKeyDown,
  ...props
}: SegmentedControlProps<T>) {
  const generatedName = React.useId()
  const groupName = name ?? generatedName
  const refs = React.useRef<Array<HTMLInputElement | null>>([])
  const selectedIndex = options.findIndex(option => option.value === value)
  const enabledIndices = options
    .map((option, index) => (option.disabled ? -1 : index))
    .filter(index => index >= 0)
  const tabbableIndex = selectedIndex >= 0 && !options[selectedIndex]?.disabled
    ? selectedIndex
    : enabledIndices[0]

  const select = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    refs.current[index]?.focus()
    if (option.value !== value) onValueChange(option.value)
  }

  const step = (from: number, direction: 1 | -1) => {
    if (enabledIndices.length === 0) return
    const position = enabledIndices.indexOf(from)
    const nextPosition = position < 0
      ? (direction > 0 ? 0 : enabledIndices.length - 1)
      : (position + direction + enabledIndices.length) % enabledIndices.length
    select(enabledIndices[nextPosition])
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return
    const activeIndex = refs.current.findIndex(element => element === document.activeElement)
    const from = activeIndex >= 0 ? activeIndex : tabbableIndex
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault()
        step(from, 1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault()
        step(from, -1)
        break
      case 'Home':
        event.preventDefault()
        step(-1, 1)
        break
      case 'End':
        event.preventDefault()
        step(-1, -1)
        break
      default:
        break
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn('inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5', className)}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {options.map((option, index) => {
        const checked = option.value === value
        const accessibleLabel = option['aria-label']
        return (
          <label
            key={option.value}
            className={cn(
              'relative inline-flex min-w-0 grow cursor-pointer select-none items-center justify-center gap-1.5 rounded-md transition-colors',
              sizeClass[size],
              checked ? selectedClass : idleClass,
              option.disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              ref={element => { refs.current[index] = element }}
              type="radio"
              className="absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none opacity-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed"
              name={groupName}
              value={option.value}
              checked={checked}
              disabled={option.disabled}
              tabIndex={index === tabbableIndex ? 0 : -1}
              aria-label={accessibleLabel}
              onChange={() => select(index)}
            />
            {option.icon ? <span aria-hidden="true" className="inline-flex shrink-0 items-center">{option.icon}</span> : null}
            {option.label ? <span className="min-w-0 break-words text-center">{option.label}</span> : null}
          </label>
        )
      })}
    </div>
  )
}
