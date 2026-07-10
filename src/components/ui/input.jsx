import React from 'react'
import { cn } from '../../lib/utils'

export const Input = React.forwardRef(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'flex h-11 w-full rounded-md border border-ink-200 bg-white px-3.5 py-2 text-sm text-ink-900 placeholder:text-ink-300 focus-visible:border-ledger-stamp disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
))
Input.displayName = 'Input'
