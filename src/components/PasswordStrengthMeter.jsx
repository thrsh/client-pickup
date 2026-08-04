// src/components/PasswordStrengthMeter.jsx
import React from 'react'
import { Check, X } from 'lucide-react'
import { cn } from '../lib/utils'
import { PASSWORD_RULES, evaluatePassword } from '../lib/password'

const BAR_COLORS = {
  'Too weak': 'bg-red-400',
  Weak: 'bg-orange-400',
  Fair: 'bg-yellow-400',
  Strong: 'bg-teal-500',
}

export default function PasswordStrengthMeter({ password, currentPassword }) {
  const { results, score, label } = evaluatePassword(password, { currentPassword })
  const filled = Math.min(score, PASSWORD_RULES.length)

  if (!password) return null

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-gray-50 p-3">
      <div className="flex items-center gap-2">
        <div className="flex h-1.5 flex-1 gap-1">
          {PASSWORD_RULES.map((_, i) => (
            <div
              key={i}
              className={cn(
                'h-full flex-1 rounded-full transition-colors',
                i < filled ? BAR_COLORS[label] : 'bg-gray-200'
              )}
            />
          ))}
        </div>
        <span className="w-14 shrink-0 text-right text-xs font-semibold text-gray-600">
          {label}
        </span>
      </div>

      <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {results.map((rule) => (
          <li
            key={rule.id}
            className={cn(
              'flex items-center gap-1.5 text-xs',
              rule.ok ? 'text-teal-700' : 'text-gray-400'
            )}
          >
            {rule.ok ? (
              <Check className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <X className="h-3.5 w-3.5 shrink-0" />
            )}
            {rule.label}
          </li>
        ))}
      </ul>
    </div>
  )
}