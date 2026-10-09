import { controlFocusClass } from './focus'

/** Internal shared surface; consumers choose native semantics and control height. */
export const formControlClass =
  `w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-[border-color] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 ${controlFocusClass}`
