import React from 'react'
import { cn } from '../../lib/utils'

export function Badge({ className, variant = 'default', ...props }) {
  const variants = {
    default: 'bg-ink-50 text-ink-700 border-ink-200',
    available: 'bg-ledger-stamp/10 text-ledger-stampDark border-ledger-stamp/40',
    pickedup: 'bg-ink-900/5 text-ink-500 border-ink-200',
    warn: 'bg-ledger-amber/10 text-ledger-amber border-ledger-amber/40',
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
        variants[variant],
        className,
      )}
      {...props}
    />
  )
}
