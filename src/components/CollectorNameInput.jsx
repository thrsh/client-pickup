import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { UserRound, Check } from 'lucide-react'
import { Input } from './ui/input'
import { normalizeCollectorName, collectorNamesMatch } from '../lib/staleChecks'
import { cn } from '../lib/utils'

// Highlights the matched substring within a suggestion, same visual
// pattern as NameCombobox in the Reports page — keeps the "why is this
// suggestion showing up" answer visible at a glance.
function highlightMatch(text, query) {
  if (!query) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <span className="font-semibold text-ledger-stamp">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  )
}

/**
 * A free-text collector-name input with a styled, keyboard-navigable
 * suggestion dropdown layered on top. It's still plain text underneath —
 * typing a name that isn't in `options` yet is always allowed, since a
 * first-time collector won't be in the suggestion list — this just makes
 * picking an EXISTING collector fast and helps surface near-duplicates
 * (different casing/whitespace of a name already on file) before they
 * get typed in yet again.
 *
 * Props:
 *   value        - current text value (controlled)
 *   onChange     - (nextValue: string) => void, fired on every keystroke
 *                  and on suggestion selection
 *   options      - string[] of known collector names (already deduped,
 *                  e.g. via dedupeCollectorNames)
 *   label        - optional <label> text above the input
 *   placeholder  - input placeholder
 *   id           - optional id, forwarded to the <input> and its <label>
 *   autoFocus    - optional, forwarded to the input
 *   disabled     - optional
 *   className    - optional extra classes on the outer wrapper
 *
 * Normalization: whitespace is trimmed/collapsed via
 * normalizeCollectorName on blur and on suggestion selection — NOT on
 * every keystroke, so the user isn't fighting the input while typing
 * (e.g. a trailing space while still typing a middle name). Casing is
 * never altered; collectorNamesMatch() (case-insensitive, whitespace-
 * normalized) is what powers both the "already on file" checkmark and
 * suggestion filtering.
 */
export default function CollectorNameInput({
  value,
  onChange,
  options = [],
  label,
  placeholder = "Collector's full name",
  id,
  autoFocus = false,
  disabled = false,
  className,
}) {
  const [open, setOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const containerRef = useRef(null)
  const inputId = id || 'collector-name-input'

  const safeValue = typeof value === 'string' ? value : ''

  const filtered = useMemo(() => {
    const term = normalizeCollectorName(safeValue).toLowerCase()
    const list = term ? options.filter((o) => o.toLowerCase().includes(term)) : options
    return list.slice(0, 8)
  }, [options, safeValue])

  // Does the current value already match a known collector exactly
  // (case/whitespace-insensitively)? Used to show a confirmation check
  // instead of silently letting a near-duplicate slip through.
  const exactMatch = useMemo(
    () => (safeValue.trim() ? options.find((o) => collectorNamesMatch(o, safeValue)) : null),
    [options, safeValue],
  )

  useEffect(() => {
    setHighlightedIndex(-1)
  }, [open, safeValue])

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const selectItem = useCallback(
    (name) => {
      onChange(normalizeCollectorName(name))
      setOpen(false)
      setHighlightedIndex(-1)
    },
    [onChange],
  )

  function handleBlur() {
    // Clean up whitespace once the user is done typing, without
    // rewriting casing. Delayed slightly isn't needed here since
    // selectItem already closes the dropdown on click via onMouseDown
    // preventDefault below, so blur firing first is safe.
    if (safeValue) {
      const normalized = normalizeCollectorName(safeValue)
      if (normalized !== safeValue) onChange(normalized)
    }
  }

  function handleKeyDown(e) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true)
      return
    }
    if (!open) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      if (highlightedIndex >= 0 && filtered[highlightedIndex]) {
        e.preventDefault()
        selectItem(filtered[highlightedIndex])
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {label && (
        <label htmlFor={inputId} className="mb-1 block text-xs font-medium text-ink-500">
          {label}
        </label>
      )}
      <div className="relative">
        <UserRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
        <Input
          id={inputId}
          value={safeValue}
          onChange={(e) => {
            onChange(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          autoFocus={autoFocus}
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          className="pl-8 pr-8"
        />
        {exactMatch && (
          <span
            className="absolute right-3 top-1/2 -translate-y-1/2 text-ledger-stamp"
            title={`Matches an existing collector: ${exactMatch}`}
          >
            <Check className="h-3.5 w-3.5" />
          </span>
        )}
      </div>

      {open && filtered.length > 0 && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-ink-200 bg-white shadow-lg">
          <ul className="max-h-56 overflow-auto py-1 text-sm">
            {filtered.map((opt, i) => {
              const active = i === highlightedIndex
              return (
                <li key={opt}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectItem(opt)}
                    onMouseEnter={() => setHighlightedIndex(i)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-ink-700',
                      active ? 'bg-ledger-stamp/5' : 'hover:bg-ink-50',
                    )}
                  >
                    <span className="truncate">{highlightMatch(opt, normalizeCollectorName(safeValue))}</span>
                    {collectorNamesMatch(opt, safeValue) && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-ledger-stamp" />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}