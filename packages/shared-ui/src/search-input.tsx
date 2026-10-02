import * as React from 'react'
import { Search } from 'lucide-react'
import { Input, type InputProps } from './input'
import { cn } from './utils'

export type SearchInputProps = Omit<InputProps, 'type'>

/** Shared collection filter; hosts own the query and surrounding layout. */
export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  ({ className, placeholder = '搜索', ...props }, ref) => (
    <div className="relative min-w-0 w-full">
      <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        {...props}
        ref={ref}
        type="search"
        placeholder={placeholder}
        className={cn('h-auto min-h-8 rounded-lg border-border bg-card py-1 pl-8 pr-2.5 text-[13px] leading-normal', className)}
      />
    </div>
  ),
)
SearchInput.displayName = 'SearchInput'
