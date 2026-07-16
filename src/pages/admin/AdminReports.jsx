import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react'
import {
  Download,
  Loader2,
  FileSpreadsheet,
  FileText,
  AlertTriangle,
  Eye,
  ArrowLeft,
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
  Info,
  X,
  Check,
  Users,
} from 'lucide-react'
// npm install exceljs — used to build the formatted .xlsx report workbooks below.
import ExcelJS from 'exceljs'
// npm install jspdf jspdf-autotable — used to build the PDF report file/preview below.
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { supabase } from '../../lib/supabaseClient'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { useToast } from '../../components/ui/toast'
import { formatCurrency } from '../../lib/utils'

// Corporate Branding Colors
const BRAND = {
  teal: '#0d9488', // teal-600
  orange: '#f97316', // orange-500
  gray: '#64748b', // slate-500
}
const BRAND_TEAL_RGB = [13, 148, 136]

/* ------------------------------------------------------------------ */
/* Report generation config                                           */
/*                                                                    */
/* NOTE ON ASSUMPTIONS — the `checks` table doesn't have columns for  */
/* Releasing Unit Name/Code or Date Returned to BPI (OR/AR report     */
/* only). Those columns are generated blank (with a light highlight)  */
/* so staff can fill them in after the physical/bank-side steps       */
/* happen. OR No. and AR Collected come from `checks.or_no` /         */
/* `checks.ar_collected`. Remarks (Released report only) is derived   */
/* from `checks.status` via `remarksLabel`.                           */
/* "Client Name" is mapped to the payee, matching the header's        */
/* "Client Name" definition — swap `getClientName` below if you       */
/* actually want it to mirror the payor.                              */
/*                                                                    */
/* "Date Uploaded" is `checks.created_at` — when the check record     */
/* was entered into this system. "Aging (Days)" is how many days the  */
/* check has been (or was) in our hands: for still-unreleased checks  */
/* that's created_at -> today; for released checks it's the elapsed   */
/* time between created_at and picked_up_at.                          */
/*                                                                    */
/* `buildRow` is the single source of truth for row content — it's    */
/* used to build the .xlsx workbook, the PDF, AND to render the       */
/* in-app preview table, so none of the three can drift out of sync.  */
/*                                                                    */
/* `released_audit` is a SEPARATE config entry from `released` — it   */
/* is only ever used when the admin explicitly checks "Include full   */
/* audit trail" on the Released report. See effectiveReportKey()      */
/* below, which is the single place that decides which of the two    */
/* configs actually gets used. The plain `released` config is never   */
/* modified by that toggle.                                           */
/* ------------------------------------------------------------------ */

const MANUAL_FILL_COLOR = 'FFFFFBEA' // faint amber — flags cells meant for manual entry
const HEADER_FILL_COLOR = 'FF0D9488' // teal
const BORDER_COLOR = 'FFD1D5DB'

const ALL_PAYEES_LABEL = 'All Payees'

function getClientName(row) {
  return row.payee || ''
}

function statusLabel(status) {
  if (status === 'picked_up') return 'Picked Up'
  if (status === 'available') return 'Available'
  return status || ''
}

// Released report shows "Released" instead of "Picked Up" in the Status
// column — it's the same underlying status value, just a different label
// for this specific report.
function releasedStatusLabel(status) {
  if (status === 'picked_up') return 'Released'
  return statusLabel(status)
}

// `ar_collected` is a nullable boolean: true -> "Y", false -> "N",
// null/undefined -> not yet recorded (rendered blank, still manual-fill highlighted).
function arCollectedLabel(value) {
  if (value === true) return 'Y'
  if (value === false) return 'N'
  return ''
}

// Remarks auto-fills based on pickup status — the Released report is already
// scoped to picked_up checks, so this will read "Released" for every row,
// but it's derived from status rather than hardcoded in case that changes.
function remarksLabel(status) {
  if (status === 'picked_up') return 'Released'
  return ''
}

// Days between two dates (calendar-day granularity, never negative). When
// `endDate` is omitted, "now" is used — that's how a still-unreleased
// check's aging keeps climbing day over day.
function daysBetween(startDate, endDate) {
  if (!startDate) return null
  const start = new Date(startDate)
  const end = endDate ? new Date(endDate) : new Date()
  start.setHours(0, 0, 0, 0)
  end.setHours(0, 0, 0, 0)
  const diff = Math.round((end - start) / 86400000)
  return diff < 0 ? 0 : diff
}

function formatExcelDateLabel(date) {
  if (!date) return '—'
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

// Shared display text for the selected-payee(s) filter, used in the preview
// header, the workbook/PDF header, and the on-screen summary.
function formatPayeeDisplay(payeeAll, payees) {
  if (payeeAll) return ALL_PAYEES_LABEL
  if (!payees || payees.length === 0) return '—'
  if (payees.length <= 3) return payees.join(', ')
  return `${payees.length} payees selected (${payees.slice(0, 2).join(', ')}, +${payees.length - 2} more)`
}

// Short, filesystem-safe tag for filenames — kept separate from the
// display text above so long payee lists don't produce unwieldy filenames.
function payeeFileTag(payeeAll, payees) {
  if (payeeAll) return 'all-payees'
  if (!payees || payees.length === 0) return 'payee'
  if (payees.length === 1) return payees[0].replace(/[^a-z0-9]+/gi, '_')
  return `${payees.length}-payees`
}

function thinBorder() {
  return {
    top: { style: 'thin', color: { argb: BORDER_COLOR } },
    left: { style: 'thin', color: { argb: BORDER_COLOR } },
    bottom: { style: 'thin', color: { argb: BORDER_COLOR } },
    right: { style: 'thin', color: { argb: BORDER_COLOR } },
  }
}

// Renders a cell descriptor (the same one used to build the .xlsx and PDF)
// as a display string, so formatting stays in sync across all three
// outputs without duplicating any formatting logic.
function formatCellDisplay(cell) {
  if (cell.value instanceof Date) {
    return cell.value.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
  }
  if (typeof cell.value === 'number' && cell.numFmt === '#,##0.00') {
    return cell.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  return cell.value === '' || cell.value == null ? '' : String(cell.value)
}

const REPORT_CONFIG = {
  released: {
    fileTag: 'released-check-report',
    title: 'RELEASED CHECK REPORT',
    statusFilter: 'picked_up',
    showReleasedDate: true,
    amountColIndex: 5,
    legendText: 'Highlighted cells are blank in the file — fill them in manually after export.',
    columns: [
      { header: 'NO', width: 6 },
      { header: 'Check Date', width: 14 },
      { header: 'Date Uploaded', width: 14 },
      { header: 'Payee', width: 26 },
      { header: 'Check Amount', width: 16 },
      { header: 'Client Name', width: 26 },
      { header: 'Status', width: 14 },
      { header: 'Date Released', width: 14 },
      { header: 'Aging (Days)', width: 12 },
      { header: 'OR No.', width: 14 },
      { header: 'AR Collected (Y/N)', width: 16 },
      { header: 'Remarks', width: 24 },
    ],
    buildRow: (r, no) => [
      { value: no, align: 'center' },
      { value: r.check_date ? new Date(r.check_date) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: r.created_at ? new Date(r.created_at) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: r.payee || '' },
      { value: Number(r.amount || 0), numFmt: '#,##0.00', align: 'right' },
      { value: getClientName(r) },
      { value: releasedStatusLabel(r.status), align: 'center' },
      { value: r.picked_up_at ? new Date(r.picked_up_at) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: daysBetween(r.created_at, r.picked_up_at) ?? '', align: 'center' },
      { value: r.or_no || '', align: 'center', fill: r.or_no ? undefined : MANUAL_FILL_COLOR },
      { value: arCollectedLabel(r.ar_collected), align: 'center', fill: r.ar_collected == null ? MANUAL_FILL_COLOR : undefined },
      { value: remarksLabel(r.status) },
    ],
  },

  // Same underlying data (status = 'picked_up') as `released`, but with
  // the full chain of custody: who uploaded it, who reserved it for
  // pickup, who submitted it for approval, and who approved it — plus
  // when each of those happened. Only ever selected via
  // effectiveReportKey() when the admin checks "Include full audit
  // trail" on the Released report.
  released_audit: {
    fileTag: 'released-check-report-audit-trail',
    title: 'RELEASED CHECK REPORT — FULL AUDIT TRAIL',
    statusFilter: 'picked_up',
    showReleasedDate: true,
    amountColIndex: 7,
    legendText:
      'Highlighted cells indicate missing audit data — the step may not have happened yet, or the record predates this tracking.',
    columns: [
      { header: 'NO', width: 6 },
      { header: 'Check Date', width: 14 },
      { header: 'Date Uploaded', width: 14 },
      { header: 'Uploaded By', width: 18 },
      { header: 'Payee', width: 24 },
      { header: 'Payor', width: 22 },
      { header: 'Check Amount', width: 16 },
      { header: 'Client Name', width: 24 },
      { header: 'Status', width: 14 },
      { header: 'Selected For Pickup By', width: 20 },
      { header: 'Date Selected', width: 14 },
      { header: 'Submitted By', width: 20 },
      { header: 'Date Submitted', width: 14 },
      { header: 'Approved By', width: 20 },
      { header: 'Date Approved', width: 14 },
      { header: 'Date Released', width: 14 },
      { header: 'Aging (Days)', width: 12 },
      { header: 'OR No.', width: 14 },
      { header: 'AR Collected (Y/N)', width: 16 },
      { header: 'Remarks', width: 22 },
    ],
    buildRow: (r, no) => [
      { value: no, align: 'center' },
      { value: r.check_date ? new Date(r.check_date) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: r.created_at ? new Date(r.created_at) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      {
        value: r.upload_batches?.uploaded_by || '',
        align: 'center',
        fill: r.upload_batches?.uploaded_by ? undefined : MANUAL_FILL_COLOR,
      },
      { value: r.payee || '' },
      { value: r.payor || '' },
      { value: Number(r.amount || 0), numFmt: '#,##0.00', align: 'right' },
      { value: getClientName(r) },
      { value: releasedStatusLabel(r.status), align: 'center' },
      {
        value: r.collector_name || '',
        align: 'center',
        fill: r.collector_name ? undefined : MANUAL_FILL_COLOR,
      },
      {
        value: r.pickup_reservations?.reserved_at ? new Date(r.pickup_reservations.reserved_at) : null,
        numFmt: 'mm/dd/yyyy',
        align: 'center',
        fill: r.pickup_reservations?.reserved_at ? undefined : MANUAL_FILL_COLOR,
      },
      {
        value: r.submitted_by_name || '',
        align: 'center',
        fill: r.submitted_by_name ? undefined : MANUAL_FILL_COLOR,
      },
      {
        value: r.submitted_at ? new Date(r.submitted_at) : null,
        numFmt: 'mm/dd/yyyy',
        align: 'center',
        fill: r.submitted_at ? undefined : MANUAL_FILL_COLOR,
      },
      {
        value: r.approved_by_name || '',
        align: 'center',
        fill: r.approved_by_name ? undefined : MANUAL_FILL_COLOR,
      },
      {
        value: r.approved_at ? new Date(r.approved_at) : null,
        numFmt: 'mm/dd/yyyy',
        align: 'center',
        fill: r.approved_at ? undefined : MANUAL_FILL_COLOR,
      },
      { value: r.picked_up_at ? new Date(r.picked_up_at) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: daysBetween(r.created_at, r.picked_up_at) ?? '', align: 'center' },
      { value: r.or_no || '', align: 'center', fill: r.or_no ? undefined : MANUAL_FILL_COLOR },
      {
        value: arCollectedLabel(r.ar_collected),
        align: 'center',
        fill: r.ar_collected == null ? MANUAL_FILL_COLOR : undefined,
      },
      { value: remarksLabel(r.status) },
    ],
  },

  unreleased: {
    fileTag: 'unreleased-check-report',
    title: 'UNRELEASED CHECK REPORT',
    statusFilter: 'available',
    showReleasedDate: false,
    amountColIndex: 5,
    legendText: 'Highlighted cells are blank in the file — fill them in manually after export.',
    columns: [
      { header: 'No', width: 6 },
      { header: 'Payee Name', width: 26 },
      { header: 'Check No.', width: 16 },
      { header: 'Check Date', width: 14 },
      { header: 'Check Amount', width: 16 },
      { header: 'Client Name', width: 26 },
      { header: 'Date Uploaded', width: 14 },
      { header: 'Aging (Days)', width: 12 },
    ],
    buildRow: (r, no) => [
      { value: no, align: 'center' },
      { value: r.payee || '' },
      { value: r.check_no || '', align: 'center' },
      { value: r.check_date ? new Date(r.check_date) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: Number(r.amount || 0), numFmt: '#,##0.00', align: 'right' },
      { value: getClientName(r) },
      { value: r.created_at ? new Date(r.created_at) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: daysBetween(r.created_at, null) ?? '', align: 'center' },
    ],
  },

  or_ar: {
    fileTag: 'or-ar-report',
    title: 'OR / AR REPORT',
    statusFilter: 'picked_up',
    showReleasedDate: true,
    amountColIndex: 9,
    legendText: 'Highlighted cells are blank in the file — fill them in manually after export.',
    columns: [
      { header: 'No', width: 6 },
      { header: 'Releasing Unit Name', width: 22 },
      { header: 'Releasing Unit Code', width: 18 },
      { header: 'Date Returned to BPI', width: 16 },
      { header: 'Check Date', width: 14 },
      { header: 'Date Uploaded', width: 14 },
      { header: 'Payee Name', width: 26 },
      { header: 'Check No.', width: 16 },
      { header: 'Check Amount', width: 16 },
      { header: 'Client Name', width: 26 },
      { header: 'Status', width: 14 },
      { header: 'Date Released', width: 14 },
      { header: 'Aging (Days)', width: 12 },
      { header: 'OR No.', width: 14 },
      { header: 'AR Collected (Y/N)', width: 16 },
    ],
    buildRow: (r, no) => [
      { value: no, align: 'center' },
      { value: '', fill: MANUAL_FILL_COLOR },
      { value: '', fill: MANUAL_FILL_COLOR, align: 'center' },
      { value: '', fill: MANUAL_FILL_COLOR, align: 'center' },
      { value: r.check_date ? new Date(r.check_date) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: r.created_at ? new Date(r.created_at) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: r.payee || '' },
      { value: r.check_no || '', align: 'center' },
      { value: Number(r.amount || 0), numFmt: '#,##0.00', align: 'right' },
      { value: getClientName(r) },
      { value: statusLabel(r.status), align: 'center' },
      { value: r.picked_up_at ? new Date(r.picked_up_at) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: daysBetween(r.created_at, r.picked_up_at) ?? '', align: 'center' },
      { value: r.or_no || '', align: 'center', fill: r.or_no ? undefined : MANUAL_FILL_COLOR },
      { value: arCollectedLabel(r.ar_collected), align: 'center', fill: r.ar_collected == null ? MANUAL_FILL_COLOR : undefined },
    ],
  },
}

const REPORT_TYPE_LABELS = {
  released: 'Released check report',
  unreleased: 'Unreleased check report',
  or_ar: 'OR / AR report',
}

const PAGE_SIZE_OPTIONS = [25, 50, 100]

// The ONLY place that decides which REPORT_CONFIG entry is actually used.
// `reportType` is what the Select control shows/stores — it never changes
// to 'released_audit' itself. The toggle just switches which config key
// this function resolves to when reportType === 'released'. Every other
// report type ignores includeAuditTrail entirely.
function effectiveReportKey(reportType, includeAuditTrail) {
  return reportType === 'released' && includeAuditTrail ? 'released_audit' : reportType
}

/* ------------------------------------------------------------------ */
/* NameCombobox                                                       */
/*                                                                    */
/* A small, self-contained single-value autocomplete used for the     */
/* Payor filter field. It's still a free-text input underneath (the   */
/* DB query uses `ilike`, so values that aren't in `options` yet      */
/* still work) — it just adds a styled, keyboard-navigable suggestion */
/* list with match highlighting instead of the native <datalist>.     */
/* ------------------------------------------------------------------ */

function highlightMatch(text, query) {
  if (!query) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <span className="font-semibold text-teal-700">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  )
}

function NameCombobox({ label, value, onChange, onSelectOption, options, placeholder }) {
  const [open, setOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const containerRef = useRef(null)

  const filtered = useMemo(() => {
    const term = value.trim().toLowerCase()
    const list = term ? options.filter((o) => o.toLowerCase().includes(term)) : options
    return list.slice(0, 8)
  }, [options, value])

  useEffect(() => {
    setHighlightedIndex(-1)
  }, [open, value])

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
    (label) => {
      onSelectOption(label)
      setOpen(false)
      setHighlightedIndex(-1)
    },
    [onSelectOption]
  )

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
    <div ref={containerRef} className="relative">
      <label className="mb-1 block text-xs font-medium text-gray-500">{label}</label>
      <Input
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg">
          <ul className="max-h-64 overflow-auto py-1 text-sm">
            {filtered.map((opt, i) => {
              const active = i === highlightedIndex
              return (
                <li key={opt}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectItem(opt)}
                    onMouseEnter={() => setHighlightedIndex(i)}
                    className={
                      'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-gray-700 ' +
                      (active ? 'bg-teal-50' : 'hover:bg-gray-50')
                    }
                  >
                    <span className="truncate">{highlightMatch(opt, value.trim())}</span>
                    {value.trim() && opt.toLowerCase() === value.trim().toLowerCase() && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-teal-600" />
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

/* ------------------------------------------------------------------ */
/* PayeeMultiSelect                                                    */
/*                                                                    */
/* Lets the user pick one payee, several payees, or every payee for   */
/* the report. Selections render as removable chips; a pinned "All    */
/* Payees" row at the top of the dropdown switches to the all-payees  */
/* mode (which clears any specific selections, since the two are      */
/* mutually exclusive).                                               */
/* ------------------------------------------------------------------ */

function PayeeMultiSelect({ label, options, selected, onChangeSelected, allSelected, onSelectAll, onClearAll }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef(null)

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    return term ? options.filter((o) => o.toLowerCase().includes(term)) : options
  }, [options, query])

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function toggleOption(opt) {
    if (allSelected) {
      // Picking a specific payee while "All" is active switches modes
      // rather than adding to it — the two are mutually exclusive.
      onClearAll()
      onChangeSelected([opt])
      return
    }
    if (selected.includes(opt)) {
      onChangeSelected(selected.filter((o) => o !== opt))
    } else {
      onChangeSelected([...selected, opt])
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <label className="mb-1 block text-xs font-medium text-gray-500">{label}</label>
      <div
        className="flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1"
        onClick={() => setOpen(true)}
      >
        {allSelected && (
          <span className="flex items-center gap-1 rounded bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700">
            <Users className="h-3 w-3" />
            {ALL_PAYEES_LABEL}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onClearAll()
              }}
              className="text-teal-500 hover:text-teal-700"
              aria-label="Clear all payees"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
        {!allSelected &&
          selected.map((opt) => (
            <span key={opt} className="flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
              {opt}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onChangeSelected(selected.filter((o) => o !== opt))
                }}
                className="text-gray-400 hover:text-gray-600"
                aria-label={`Remove ${opt}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        {!allSelected && (
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            placeholder={selected.length === 0 ? 'Search or select payees…' : ''}
            className="min-w-[80px] flex-1 border-0 p-0.5 text-sm outline-none"
          />
        )}
      </div>

      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg">
          <ul className="max-h-64 overflow-auto py-1 text-sm">
            <li>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelectAll()
                  setOpen(false)
                }}
                className={
                  'flex w-full items-center gap-2 border-b border-gray-100 px-3 py-2 text-left font-medium ' +
                  (allSelected ? 'bg-teal-50 text-teal-700' : 'text-teal-600 hover:bg-teal-50')
                }
              >
                <Users className="h-3.5 w-3.5" />
                {ALL_PAYEES_LABEL}
              </button>
            </li>
            {filtered.length === 0 && <li className="px-3 py-2 text-xs text-gray-400">No matching payees.</li>}
            {filtered.map((opt) => {
              const checked = !allSelected && selected.includes(opt)
              return (
                <li key={opt}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => toggleOption(opt)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-gray-700 hover:bg-gray-50"
                  >
                    <span className="truncate">{highlightMatch(opt, query.trim())}</span>
                    {checked && <Check className="h-3.5 w-3.5 shrink-0 text-teal-600" />}
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

/* ------------------------------------------------------------------ */

export default function AdminReports() {
  // Wizard step: 'form' (choose filters) -> 'preview' (review before download)
  const [step, setStep] = useState('form')

  // Filter form state
  const [reportType, setReportType] = useState('released')
  // Only meaningful when reportType === 'released'. Reset to false any
  // time reportType changes away from 'released' (see the Select's
  // onChange below) so it can never silently apply to another report.
  const [includeAuditTrail, setIncludeAuditTrail] = useState(false)
  const [reportPayees, setReportPayees] = useState([])
  const [reportPayeeAll, setReportPayeeAll] = useState(false)
  const [reportPayor, setReportPayor] = useState('')
  const [releasedDate, setReleasedDate] = useState('')
  const [reportDateFrom, setReportDateFrom] = useState('')
  const [reportDateTo, setReportDateTo] = useState('')
  const [formError, setFormError] = useState('')
  const [payeeOptions, setPayeeOptions] = useState([])
  const [payorOptions, setPayorOptions] = useState([])

  // Data behind the current preview (fetched once, reused for download —
  // no refetch needed unless the user explicitly refreshes)
  const [rawRows, setRawRows] = useState([])
  // previewMeta.configKey is the resolved REPORT_CONFIG key actually used
  // for this preview (e.g. 'released_audit'), captured at the moment the
  // admin clicked "Preview report" — every download/refresh/PDF action
  // below reads previewMeta.configKey, never reportType or
  // includeAuditTrail directly, so editing the form afterward can't
  // retroactively change what an already-generated preview shows.
  const [previewMeta, setPreviewMeta] = useState(null)
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [downloadingPdf, setDownloadingPdf] = useState(false)

  // Preview table controls
  const [searchTerm, setSearchTerm] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  // PDF preview modal state
  const [pdfState, setPdfState] = useState({ open: false, url: '', generating: false })

  const { push } = useToast()

  useEffect(() => {
    loadDistinctNames()
  }, [])

  // Revoke the PDF preview's blob URL whenever it changes or the component
  // unmounts, so we don't leak memory across repeated previews.
  useEffect(() => {
    return () => {
      if (pdfState.url) URL.revokeObjectURL(pdfState.url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfState.url])

  async function loadDistinctNames() {
    try {
      const { data, error } = await supabase.from('checks').select('payee, payor').limit(2000)
      if (error) return
      const payees = [...new Set((data || []).map((r) => r.payee).filter(Boolean))].sort()
      const payors = [...new Set((data || []).map((r) => r.payor).filter(Boolean))].sort()
      setPayeeOptions(payees)
      setPayorOptions(payors)
    } catch {
      // Suggestions are a convenience only — silently ignore failures here.
    }
  }

  // Fetches every matching row in pages of 1000 (Supabase's per-request cap)
  // so large payee/payor/date combinations don't get silently truncated.
  // Audit-trail columns (collector_name, submitted_by_name, submitted_at,
  // approved_by_name, approved_at, and the embedded reservation/batch
  // fields) are always selected — they're harmless no-ops for report
  // types whose buildRow doesn't reference them, and it means toggling
  // "Include full audit trail" before clicking Preview needs no separate
  // fetch path.
  async function fetchAllChecks({ payees, payeeAll, payor, statusFilter, dateFrom, dateTo }) {
    const PAGE = 1000
    let from = 0
    let all = []

    while (true) {
      let req = supabase
        .from('checks')
        .select(
          'id, check_no, check_date, payee, payor, amount, status, picked_up_by, picked_up_at, created_at, or_no, ar_collected, collector_name, submitted_by_name, submitted_at, approved_by_name, approved_at, reservation_id, pickup_reservations(reserved_at), upload_batches(uploaded_by)'
        )
        .order('check_date', { ascending: true })
        .range(from, from + PAGE - 1)

      if (!payeeAll && payees.length > 0) req = req.in('payee', payees)
      if (payor.trim()) req = req.ilike('payor', `%${payor.trim()}%`)
      if (statusFilter) req = req.eq('status', statusFilter)
      if (dateFrom) req = req.gte('check_date', dateFrom)
      if (dateTo) req = req.lte('check_date', dateTo)

      const { data, error } = await req
      if (error) throw error

      all = all.concat(data || [])
      if (!data || data.length < PAGE) break
      from += PAGE
    }

    return all
  }

  function validateForm() {
    if (!reportPayor.trim()) {
      return 'Please enter a payor.'
    }
    if (!reportPayeeAll && reportPayees.length === 0) {
      return `Please select at least one payee, or choose "${ALL_PAYEES_LABEL}".`
    }
    if (REPORT_CONFIG[effectiveReportKey(reportType, includeAuditTrail)].showReleasedDate && !releasedDate) {
      return 'Please select a released date.'
    }
    if (reportDateFrom && reportDateTo && reportDateFrom > reportDateTo) {
      return 'The "from" date must be before the "to" date.'
    }
    return ''
  }

  async function handlePreview() {
    const validationError = validateForm()
    if (validationError) {
      setFormError(validationError)
      return
    }
    setFormError('')
    setFetchError('')
    setFetching(true)
    try {
      const configKey = effectiveReportKey(reportType, includeAuditTrail)
      const config = REPORT_CONFIG[configKey]
      const rows = await fetchAllChecks({
        payees: reportPayees,
        payeeAll: reportPayeeAll,
        payor: reportPayor,
        statusFilter: config.statusFilter,
        dateFrom: reportDateFrom,
        dateTo: reportDateTo,
      })

      if (rows.length === 0) {
        setFormError('No matching checks found for that filter combination.')
        return
      }

      setRawRows(rows)
      setPreviewMeta({
        reportType,
        configKey,
        includeAuditTrail: configKey === 'released_audit',
        payees: reportPayeeAll ? [] : reportPayees,
        payeeAll: reportPayeeAll,
        payor: reportPayor.trim(),
        releasedDate,
        dateFrom: reportDateFrom,
        dateTo: reportDateTo,
      })
      setSearchTerm('')
      setPage(1)
      setStep('preview')
    } catch (err) {
      const message = err?.message || 'Failed to load checks. Please try again.'
      setFormError(message)
    } finally {
      setFetching(false)
    }
  }

  async function handleRefresh() {
    if (!previewMeta) return
    setFetchError('')
    setFetching(true)
    try {
      const config = REPORT_CONFIG[previewMeta.configKey]
      const rows = await fetchAllChecks({
        payees: previewMeta.payees,
        payeeAll: previewMeta.payeeAll,
        payor: previewMeta.payor,
        statusFilter: config.statusFilter,
        dateFrom: previewMeta.dateFrom,
        dateTo: previewMeta.dateTo,
      })
      setRawRows(rows)
      setPage(1)
      push?.({ variant: 'success', title: 'Preview refreshed', description: `${rows.length} record${rows.length === 1 ? '' : 's'} loaded.` })
    } catch (err) {
      const message = err?.message || 'Failed to refresh the preview. Please try again.'
      setFetchError(message)
    } finally {
      setFetching(false)
    }
  }

  function handleBackToFilters() {
    setStep('form')
    setFetchError('')
  }

  function addHeaderRow(sheet, rowNum, colCount, text, style = {}) {
    sheet.mergeCells(rowNum, 1, rowNum, colCount)
    const cell = sheet.getRow(rowNum).getCell(1)
    cell.value = text
    cell.font = {
      bold: !!style.bold,
      size: style.size || 11,
      color: style.color ? { argb: style.color } : undefined,
    }
    cell.alignment = { vertical: 'middle', horizontal: style.align || 'left' }
    sheet.getRow(rowNum).height = style.height || 18
  }

  // Shared header text lines for the report's info block — used to build
  // both the Excel workbook header rows and the PDF header, so the two
  // outputs can't drift apart.
  function buildHeaderLines(configKey, { payeeDisplay, payor, releasedDateValue, dateFrom, dateTo }) {
    const config = REPORT_CONFIG[configKey]
    const lines = [{ text: `Client Name: ${payeeDisplay || '—'}`, size: 11, bold: true }]
    lines.push({ text: `Report Date: ${formatExcelDateLabel(new Date())}`, size: 10 })
    if (dateFrom || dateTo) {
      const fromLabel = dateFrom ? formatExcelDateLabel(new Date(dateFrom)) : '—'
      const toLabel = dateTo ? formatExcelDateLabel(new Date(dateTo)) : '—'
      lines.push({ text: `Check Date Range: ${fromLabel} to ${toLabel}`, size: 10 })
    }
    if (config.showReleasedDate) {
      const releasedLabel = releasedDateValue ? formatExcelDateLabel(new Date(releasedDateValue)) : '—'
      lines.push({ text: `Released Date: ${releasedLabel}`, size: 10 })
    }
    return lines
  }

  async function buildWorkbook(configKey, rows, { payeeDisplay, payor, releasedDateValue, dateFrom, dateTo }) {
    const config = REPORT_CONFIG[configKey]
    const colCount = config.columns.length

    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'Check Disbursement System'
    workbook.created = new Date()

    const sheet = workbook.addWorksheet(config.title.slice(0, 31), {
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
      views: [{ showGridLines: false }],
    })

    sheet.columns = config.columns.map((c) => ({ width: c.width }))

    let r = 1

    // Row 1 — Company Name (the payor)
    addHeaderRow(sheet, r, colCount, `Company Name: ${payor || '—'}`, { bold: true, size: 14 })
    r++

    // Row 2 — Report title
    addHeaderRow(sheet, r, colCount, config.title, { bold: true, size: 13, color: HEADER_FILL_COLOR })
    r++

    // Remaining header lines (Client Name, Report Date, Date Range, Released Date)
    for (const line of buildHeaderLines(configKey, { payeeDisplay, payor, releasedDateValue, dateFrom, dateTo })) {
      addHeaderRow(sheet, r, colCount, line.text, { bold: line.bold, size: line.size })
      r++
    }

    // Blank spacer row
    r++

    // Column header row
    const headerRowIndex = r
    const headerRow = sheet.getRow(headerRowIndex)
    config.columns.forEach((c, i) => {
      const cell = headerRow.getCell(i + 1)
      cell.value = c.header
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_COLOR } }
      cell.border = thinBorder()
    })
    headerRow.height = 26
    r++

    // Data rows
    let total = 0
    rows.forEach((row, idx) => {
      const values = config.buildRow(row, idx + 1)
      const excelRow = sheet.getRow(r)
      values.forEach((val, i) => {
        const cell = excelRow.getCell(i + 1)
        cell.value = val.value
        if (val.numFmt) cell.numFmt = val.numFmt
        cell.alignment = { vertical: 'middle', horizontal: val.align || 'left' }
        cell.border = thinBorder()
        if (val.fill) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: val.fill } }
        }
      })
      total += Number(row.amount || 0)
      r++
    })

    // Total row
    const totalRow = sheet.getRow(r)
    for (let c = 1; c <= colCount; c++) {
      totalRow.getCell(c).border = thinBorder()
    }
    sheet.mergeCells(r, 1, r, config.amountColIndex - 1)
    const totalLabelCell = totalRow.getCell(1)
    totalLabelCell.value = 'TOTAL'
    totalLabelCell.font = { bold: true }
    totalLabelCell.alignment = { horizontal: 'right', vertical: 'middle' }

    const totalAmountCell = totalRow.getCell(config.amountColIndex)
    totalAmountCell.value = total
    totalAmountCell.numFmt = '#,##0.00'
    totalAmountCell.font = { bold: true }
    totalAmountCell.alignment = { horizontal: 'right', vertical: 'middle' }
    totalRow.height = 20

    // Freeze everything above (and including) the column header row
    sheet.views = [{ state: 'frozen', ySplit: headerRowIndex }]

    return workbook
  }

  // Builds a professional, landscape PDF report using the exact same
  // header lines and row data as the Excel workbook (via buildHeaderLines
  // and config.buildRow), so all three surfaces — preview table, Excel,
  // PDF — always show identical numbers.
  function buildPdfDocument(configKey, rows, { payeeDisplay, payor, releasedDateValue, dateFrom, dateTo }) {
    const config = REPORT_CONFIG[configKey]
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
    const margin = 32

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(14)
    doc.setTextColor(20, 20, 20)
    doc.text(`Company Name: ${payor || '—'}`, margin, 40)

    doc.setFontSize(13)
    doc.setTextColor(...BRAND_TEAL_RGB)
    doc.text(config.title, margin, 60)

    let y = 78
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(60, 60, 60)
    for (const line of buildHeaderLines(configKey, { payeeDisplay, payor, releasedDateValue, dateFrom, dateTo })) {
      if (line.bold) doc.setFont('helvetica', 'bold')
      doc.text(line.text, margin, y)
      if (line.bold) doc.setFont('helvetica', 'normal')
      y += 14
    }

    const head = [config.columns.map((c) => c.header)]
    let total = 0
    const body = rows.map((row, idx) => {
      const cells = config.buildRow(row, idx + 1)
      total += Number(row.amount || 0)
      return cells.map((cell) => formatCellDisplay(cell) || '')
    })
    // Totals row, styled bold via didParseCell below.
    body.push(
      config.columns.map((c, i) => {
        if (i === config.amountColIndex - 1) {
          return total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        }
        if (i === config.amountColIndex - 2) return 'TOTAL'
        return ''
      })
    )
    const totalRowIndex = body.length - 1

    autoTable(doc, {
      head,
      body,
      startY: y + 8,
      margin: { left: margin, right: margin },
      styles: { fontSize: 8, cellPadding: 4, lineColor: [209, 213, 219], lineWidth: 0.5, textColor: [55, 65, 81] },
      headStyles: { fillColor: BRAND_TEAL_RGB, textColor: 255, fontStyle: 'bold', halign: 'center' },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: { [config.amountColIndex - 1]: { halign: 'right' } },
      didParseCell: (data) => {
        if (data.row.section === 'body' && data.row.index === totalRowIndex) {
          data.cell.styles.fontStyle = 'bold'
          data.cell.styles.fillColor = [255, 255, 255]
        }
      },
      didDrawPage: (data) => {
        const pageCount = doc.internal.getNumberOfPages()
        doc.setFontSize(8)
        doc.setTextColor(150, 150, 150)
        doc.text(
          `Generated ${formatExcelDateLabel(new Date())} · Page ${data.pageNumber} of ${pageCount}`,
          margin,
          doc.internal.pageSize.getHeight() - 14
        )
      },
    })

    return doc
  }

  async function handleDownload() {
    if (!previewMeta || rawRows.length === 0) return
    setDownloading(true)
    try {
      const config = REPORT_CONFIG[previewMeta.configKey]
      const payeeDisplay = formatPayeeDisplay(previewMeta.payeeAll, previewMeta.payees)
      const workbook = await buildWorkbook(previewMeta.configKey, rawRows, {
        payeeDisplay,
        payor: previewMeta.payor,
        releasedDateValue: previewMeta.releasedDate,
        dateFrom: previewMeta.dateFrom,
        dateTo: previewMeta.dateTo,
      })

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const stamp = new Date().toISOString().slice(0, 10)
      const safePayor = previewMeta.payor.replace(/[^a-z0-9]+/gi, '_')
      const payeeTag = payeeFileTag(previewMeta.payeeAll, previewMeta.payees)
      a.href = url
      a.download = `${config.fileTag}-${safePayor}-${payeeTag}-${stamp}.xlsx`
      a.click()
      URL.revokeObjectURL(url)

      push?.({
        variant: 'success',
        title: 'Report downloaded',
        description: `${rawRows.length} check${rawRows.length === 1 ? '' : 's'} included in the ${config.title.toLowerCase()}.`,
      })
    } catch (err) {
      const message = err?.message || 'Failed to generate the report. Please try again.'
      push?.({ variant: 'error', title: 'Download failed', description: message })
    } finally {
      setDownloading(false)
    }
  }

  function pdfMetaArgs() {
    return {
      payeeDisplay: formatPayeeDisplay(previewMeta.payeeAll, previewMeta.payees),
      payor: previewMeta.payor,
      releasedDateValue: previewMeta.releasedDate,
      dateFrom: previewMeta.dateFrom,
      dateTo: previewMeta.dateTo,
    }
  }

  function pdfFilename() {
    const config = REPORT_CONFIG[previewMeta.configKey]
    const stamp = new Date().toISOString().slice(0, 10)
    const safePayor = previewMeta.payor.replace(/[^a-z0-9]+/gi, '_')
    const payeeTag = payeeFileTag(previewMeta.payeeAll, previewMeta.payees)
    return `${config.fileTag}-${safePayor}-${payeeTag}-${stamp}.pdf`
  }

  function handlePreviewPdf() {
    if (!previewMeta || rawRows.length === 0) return
    setPdfState((s) => ({ ...s, generating: true }))
    try {
      const doc = buildPdfDocument(previewMeta.configKey, rawRows, pdfMetaArgs())
      const blobUrl = doc.output('bloburl')
      setPdfState((s) => {
        if (s.url) URL.revokeObjectURL(s.url)
        return { open: true, url: blobUrl, generating: false }
      })
    } catch (err) {
      push?.({ variant: 'error', title: 'PDF preview failed', description: err?.message || 'Please try again.' })
      setPdfState((s) => ({ ...s, generating: false }))
    }
  }

  function closePdfPreview() {
    setPdfState((s) => {
      if (s.url) URL.revokeObjectURL(s.url)
      return { open: false, url: '', generating: false }
    })
  }

  function handleDownloadPdf() {
    if (!previewMeta || rawRows.length === 0) return
    setDownloadingPdf(true)
    try {
      const doc = buildPdfDocument(previewMeta.configKey, rawRows, pdfMetaArgs())
      doc.save(pdfFilename())
    } catch (err) {
      push?.({ variant: 'error', title: 'PDF download failed', description: err?.message || 'Please try again.' })
    } finally {
      setDownloadingPdf(false)
    }
  }

  const activeConfig = previewMeta ? REPORT_CONFIG[previewMeta.configKey] : null

  // Row numbering reflects position in the full, unfiltered result set so
  // "No" stays stable regardless of what the user types into the quick search.
  const numberedRows = useMemo(() => rawRows.map((row, i) => ({ no: i + 1, row })), [rawRows])

  const filteredRows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) return numberedRows
    return numberedRows.filter(({ row }) =>
      [row.payee, row.payor, row.check_no].some((v) => String(v || '').toLowerCase().includes(term))
    )
  }, [numberedRows, searchTerm])

  const totalAmount = useMemo(
    () => rawRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    [rawRows]
  )

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pagedRows = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return filteredRows.slice(start, start + pageSize)
  }, [filteredRows, currentPage, pageSize])

  useEffect(() => {
    setPage(1)
  }, [searchTerm, pageSize])

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-12">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Check Report Generator</h1>
        <p className="text-sm text-gray-500">
          Build a formatted check report, preview it, then download it as Excel or PDF once you're happy with it.
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-3 text-sm">
        <StepBadge active={step === 'form'} done={step === 'preview'} label="1. Configure" />
        <div className="h-px flex-1 bg-gray-200" />
        <StepBadge active={step === 'preview'} done={false} label="2. Preview & download" />
      </div>

      {step === 'form' && (
        <Card className="border-gray-100 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Report filters</CardTitle>
            <CardDescription>Choose a report type, then enter the payee(s) and payor to include.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Report type</label>
                <Select
                  value={reportType}
                  onChange={(e) => {
                    setReportType(e.target.value)
                    // The toggle only ever applies to the Released report —
                    // reset it whenever the report type changes away from
                    // 'released' so it can't silently carry over and apply
                    // to a different report type later.
                    if (e.target.value !== 'released') setIncludeAuditTrail(false)
                  }}
                >
                  {Object.entries(REPORT_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </Select>
              </div>

              {REPORT_CONFIG[effectiveReportKey(reportType, includeAuditTrail)].showReleasedDate && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-500">Released date</label>
                  <Input type="date" value={releasedDate} onChange={(e) => setReleasedDate(e.target.value)} />
                </div>
              )}
            </div>

            {/* Audit-trail toggle — only ever shown for the Released report.
                Unchecked (the default) is the exact original `released`
                config with no behavior change from before this feature. */}
            {reportType === 'released' && (
              <label className="flex cursor-pointer items-start gap-2 rounded-md border border-gray-200 bg-gray-50/60 px-3 py-2.5 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={includeAuditTrail}
                  onChange={(e) => setIncludeAuditTrail(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-teal-600"
                />
                <span>
                  <span className="font-medium">Include full audit trail</span>
                  <span className="block text-xs text-gray-500">
                    Adds who uploaded each check and when, who selected it for pickup and when, who
                    submitted it for approval and when, and who approved it and when.
                  </span>
                </span>
              </label>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Check date from</label>
                <Input type="date" value={reportDateFrom} onChange={(e) => setReportDateFrom(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Check date to</label>
                <Input type="date" value={reportDateTo} onChange={(e) => setReportDateTo(e.target.value)} />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <PayeeMultiSelect
                label="Payee(s)"
                options={payeeOptions}
                selected={reportPayees}
                onChangeSelected={setReportPayees}
                allSelected={reportPayeeAll}
                onSelectAll={() => {
                  setReportPayeeAll(true)
                  setReportPayees([])
                }}
                onClearAll={() => setReportPayeeAll(false)}
              />

              <NameCombobox
                label="Payor"
                value={reportPayor}
                onChange={setReportPayor}
                onSelectOption={setReportPayor}
                options={payorOptions}
                placeholder="Enter payor"
              />
            </div>

            {formError && (
              <p className="flex items-center gap-1.5 text-xs text-red-600">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {formError}
              </p>
            )}

            <div className="flex justify-end pt-2">
              <Button
                onClick={handlePreview}
                disabled={fetching}
                className="bg-teal-600 text-white hover:bg-teal-700"
              >
                {fetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
                {fetching ? 'Loading…' : 'Preview report'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'preview' && activeConfig && (
        <Card className="border-gray-100 shadow-sm">
          <CardHeader className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg">
                  {activeConfig.title}
                  {previewMeta.includeAuditTrail && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                      Full audit trail
                    </span>
                  )}
                </CardTitle>
                <CardDescription>
                  Payor: <span className="font-medium text-gray-700">{previewMeta.payor}</span>
                  {' · '}Payee(s):{' '}
                  <span className="font-medium text-gray-700">
                    {formatPayeeDisplay(previewMeta.payeeAll, previewMeta.payees)}
                  </span>
                  {(previewMeta.dateFrom || previewMeta.dateTo) && (
                    <>
                      {' · '}Check dates:{' '}
                      <span className="font-medium text-gray-700">
                        {previewMeta.dateFrom || '—'} to {previewMeta.dateTo || '—'}
                      </span>
                    </>
                  )}
                  {activeConfig.showReleasedDate && previewMeta.releasedDate && (
                    <> {' · '}Released: <span className="font-medium text-gray-700">{previewMeta.releasedDate}</span></>
                  )}
                </CardDescription>
              </div>
              <Button variant="outline" onClick={handleBackToFilters} disabled={downloading || downloadingPdf}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Edit filters
              </Button>
            </div>

            {/* Summary strip */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <SummaryStat label="Total rows" value={rawRows.length.toLocaleString()} />
              <SummaryStat label="Total amount" value={formatCurrency(totalAmount)} />
              <SummaryStat
                label="Filtered results"
                value={searchTerm ? `${filteredRows.length.toLocaleString()} of ${rawRows.length.toLocaleString()}` : 'All shown'}
              />
            </div>

            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <Input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Quick search by payee, payor, or check no."
                  className="pl-8"
                />
              </div>
              <Select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className="w-auto">
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>{size} rows / page</option>
                ))}
              </Select>
              <Button variant="outline" onClick={handleRefresh} disabled={fetching}>
                {fetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Refresh
              </Button>
            </div>

            {fetchError && (
              <p className="flex items-center gap-1.5 text-xs text-red-600">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {fetchError}
              </p>
            )}
          </CardHeader>

          <CardContent className="space-y-4">
            {/* Preview table */}
            <div className="overflow-auto rounded-lg border border-gray-200" style={{ maxHeight: 480 }}>
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 z-10">
                  <tr>
                    {activeConfig.columns.map((col) => (
                      <th
                        key={col.header}
                        className="whitespace-nowrap border-b border-gray-200 px-3 py-2 text-left text-xs font-semibold text-white"
                        style={{ backgroundColor: BRAND.teal }}
                      >
                        {col.header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.length === 0 && (
                    <tr>
                      <td colSpan={activeConfig.columns.length} className="px-3 py-8 text-center text-sm text-gray-400">
                        No rows match your search.
                      </td>
                    </tr>
                  )}
                  {pagedRows.map(({ no, row }) => {
                    const cells = activeConfig.buildRow(row, no)
                    return (
                      <tr key={row.id ?? no} className="border-b border-gray-100 last:border-0 even:bg-gray-50/50">
                        {cells.map((cell, i) => (
                          <td
                            key={i}
                            className="whitespace-nowrap px-3 py-1.5 text-gray-700"
                            style={{
                              textAlign: cell.align || 'left',
                              backgroundColor: cell.fill ? '#fffbea' : undefined,
                            }}
                          >
                            {formatCellDisplay(cell) || <span className="text-gray-300">—</span>}
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Legend + pagination */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <span className="inline-block h-3 w-3 rounded-sm border border-amber-200" style={{ backgroundColor: '#fffbea' }} />
                {activeConfig.legendText || 'Highlighted cells are blank in the file — fill them in manually after export.'}
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <span>
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  className="h-8 w-8 p-0"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  className="h-8 w-8 p-0"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage >= totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-500">
              <div className="flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5 shrink-0" />
                Downloading uses all {rawRows.length.toLocaleString()} row{rawRows.length === 1 ? '' : 's'} in this report, not just the page shown above.
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  onClick={handlePreviewPdf}
                  disabled={pdfState.generating || rawRows.length === 0}
                >
                  {pdfState.generating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}
                  Preview PDF
                </Button>
                <Button
                  variant="outline"
                  onClick={handleDownloadPdf}
                  disabled={downloadingPdf || rawRows.length === 0}
                >
                  {downloadingPdf ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                  {downloadingPdf ? 'Preparing…' : 'Download PDF'}
                </Button>
                <Button
                  onClick={handleDownload}
                  disabled={downloading || rawRows.length === 0}
                  className="shrink-0 bg-teal-600 text-white hover:bg-teal-700"
                >
                  {downloading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
                  {downloading ? 'Preparing…' : 'Download Excel'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* PDF preview modal */}
      {pdfState.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={closePdfPreview}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="flex h-full max-h-[90vh] w-full max-w-5xl flex-col rounded-lg bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <h3 className="text-sm font-semibold text-gray-900">PDF preview — {activeConfig?.title}</h3>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={handleDownloadPdf}
                  disabled={downloadingPdf}
                  className="bg-teal-600 text-white hover:bg-teal-700"
                >
                  {downloadingPdf ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
                  Download
                </Button>
                <button
                  onClick={closePdfPreview}
                  className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                  aria-label="Close PDF preview"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <iframe title="PDF preview" src={pdfState.url} className="flex-1 rounded-b-lg" />
          </div>
        </div>
      )}
    </div>
  )
}

function StepBadge({ active, done, label }) {
  return (
    <span
      className={
        'rounded-full px-3 py-1 font-medium ' +
        (active
          ? 'bg-teal-600 text-white'
          : done
          ? 'bg-teal-50 text-teal-700'
          : 'bg-gray-100 text-gray-400')
      }
    >
      {label}
    </span>
  )
}

function SummaryStat({ label, value }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-white p-3">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="mt-0.5 text-base font-semibold text-gray-900">{value}</div>
    </div>
  )
}