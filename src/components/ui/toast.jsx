import React, { createContext, useCallback, useContext, useState } from 'react'
import { CheckCircle2, XCircle, Info, X } from 'lucide-react'
import { cn } from '../../lib/utils'

const ToastContext = createContext(null)

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const push = useCallback((toast) => {
    const id = Math.random().toString(36).slice(2)
    setToasts((t) => [...t, { id, ...toast }])
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id))
    }, toast.duration || 4000)
  }, [])

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'flex items-start gap-2.5 rounded-md border bg-white p-3.5 shadow-xl',
              t.variant === 'error' && 'border-ledger-brick/30',
              t.variant === 'success' && 'border-ledger-stamp/30',
              (!t.variant || t.variant === 'info') && 'border-ink-100',
            )}
          >
            {t.variant === 'success' && (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ledger-stamp" />
            )}
            {t.variant === 'error' && (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-ledger-brick" />
            )}
            {(!t.variant || t.variant === 'info') && (
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
            )}
            <div className="flex-1">
              {t.title && <p className="text-sm font-medium text-ink-900">{t.title}</p>}
              {t.description && (
                <p className="mt-0.5 text-xs text-ink-400">{t.description}</p>
              )}
            </div>
            <button
              onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}
              className="text-ink-300 hover:text-ink-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
