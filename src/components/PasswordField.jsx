// src/components/PasswordField.jsx
import React, { useState } from 'react'
import { Eye, EyeOff, Lock } from 'lucide-react'
import { cn } from '../lib/utils'

export default function PasswordField({
  id,
  label,
  value,
  onChange,
  placeholder = '••••••••',
  error,
  autoComplete = 'new-password',
}) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-gray-700">
        {label}
      </label>
      <div className="relative">
        <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className={cn(
            'w-full rounded-lg border bg-white py-2.5 pl-10 pr-10 text-sm text-gray-900 shadow-sm outline-none transition-colors',
            'focus:border-teal-500 focus:ring-2 focus:ring-teal-100',
            error ? 'border-red-300' : 'border-gray-200'
          )}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          aria-label={visible ? 'Hide password' : 'Show password'}
          tabIndex={-1}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}
