import React, { useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import {
  UploadCloud,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Trash2,
  ArrowRight,
  Loader2,
  Stamp,
  Sparkles,
  Download,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Button } from '../../components/ui/button'
import { Card, CardContent } from '../../components/ui/card'
import { Select } from '../../components/ui/select'
import { useToast } from '../../components/ui/toast'
import { normalizeDate, cn } from '../../lib/utils'

const REQUIRED_FIELDS = [
  { key: 'payee', label: 'Payee' },
  { key: 'payor', label: 'Payor' },
  { key: 'check_no', label: 'Check No' },
  { key: 'check_date', label: 'Check Date' },
  { key: 'amount', label: 'Amount' },
]

const ACCEPTED_EXTENSIONS = ['.csv', '.xlsx', '.xls']
const PREVIEW_ROW_LIMIT = 5
const EXPANDED_PREVIEW_CAP = 200

// best-effort auto-detection of column headers
function guessColumn(headers, field) {
  const patterns = {
    payee: /^payee$/i,
    payor: /^payor|payer$/i,
    check_no: /check.?no|check.?number/i,
    check_date: /check.?date|date/i,
    amount: /amount|amt/i,
  }
  const idx = headers.findIndex((h) => patterns[field].test(String(h).trim()))
  return idx >= 0 ? headers[idx] : ''
}

function formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function downloadTemplate() {
  const csvContent = [
    'Payee,Payor,Check No,Check Date,Amount',
    'Jane Doe,Acme Corp,00123,2024-01-15,250.00',
    'John Smith,Acme Corp,00124,2024-02-03,1050.75',
  ].join('\n')
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'check-import-template.csv'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export default function AdminUpload() {
  const [fileName, setFileName] = useState('')
  const [fileSize, setFileSize] = useState(0)
  const [headers, setHeaders] = useState([])
  const [rawRows, setRawRows] = useState([])
  const [mapping, setMapping] = useState({})
  const [autoDetected, setAutoDetected] = useState({})
  const [saving, setSaving] = useState(false)
  const [importProgress, setImportProgress] = useState(0)
  const [parseError, setParseError] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [importedCount, setImportedCount] = useState(null) // set once import succeeds
  const [showAllRows, setShowAllRows] = useState(false)
  const inputRef = useRef(null)
  const { push } = useToast()

  const hasFile = headers.length > 0
  const mappingComplete = REQUIRED_FIELDS.every(({ key }) => mapping[key])

  // Per-row quality flags so the preview table can point at the exact
  // cells that look wrong, not just show an aggregate count.
  const rowFlags = useMemo(() => {
    if (!mappingComplete || rawRows.length === 0) return []

    const payeeIdx = headers.indexOf(mapping.payee)
    const amountIdx = headers.indexOf(mapping.amount)
    const dateIdx = headers.indexOf(mapping.check_date)

    return rawRows.map((row) => {
      const parsedAmount =
        Number(String(row[amountIdx] ?? '0').replace(/[^0-9.-]/g, '')) || 0
      return {
        payee: !String(row[payeeIdx] ?? '').trim(),
        amount: parsedAmount === 0,
        check_date: !normalizeDate(row[dateIdx]),
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mappingComplete, rawRows, headers, mapping])

  const dataQuality = useMemo(() => {
    if (rowFlags.length === 0) return null
    return {
      missingPayee: rowFlags.filter((f) => f.payee).length,
      missingAmount: rowFlags.filter((f) => f.amount).length,
      missingDate: rowFlags.filter((f) => f.check_date).length,
    }
  }, [rowFlags])

  const totalIssues = dataQuality
    ? dataQuality.missingPayee + dataQuality.missingAmount + dataQuality.missingDate
    : 0

  const previewRows = showAllRows
    ? rawRows.slice(0, EXPANDED_PREVIEW_CAP)
    : rawRows.slice(0, PREVIEW_ROW_LIMIT)

  function resetFileState() {
    setFileName('')
    setFileSize(0)
    setHeaders([])
    setRawRows([])
    setMapping({})
    setAutoDetected({})
    setParseError('')
    setImportProgress(0)
    setImportedCount(null)
    setShowAllRows(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  function processFile(file) {
    if (!file) return

    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      push({
        variant: 'error',
        title: 'Unsupported file type',
        description: `Please choose a ${ACCEPTED_EXTENSIONS.join(', ')} file.`,
      })
      return
    }

    setParseError('')
    setImportedCount(null)
    setShowAllRows(false)
    setFileName(file.name)
    setFileSize(file.size)

    const reader = new FileReader()
    reader.onerror = () => {
      setParseError('Could not read this file. It may be corrupted — try re-exporting it.')
    }
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target.result)
        const workbook = XLSX.read(data, { type: 'array', cellDates: false })
        const sheet = workbook.Sheets[workbook.SheetNames[0]]
        const json = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' })

        if (json.length === 0) {
          push({ variant: 'error', title: 'Empty file', description: 'No rows were found.' })
          resetFileState()
          return
        }

        const [headerRow, ...body] = json
        const cleanHeaders = headerRow.map((h) => String(h).trim())
        const bodyRows = body.filter((r) => r.some((cell) => String(cell).trim() !== ''))

        if (bodyRows.length === 0) {
          push({
            variant: 'error',
            title: 'No data rows found',
            description: 'The file only has a header row.',
          })
          resetFileState()
          return
        }

        setHeaders(cleanHeaders)
        setRawRows(bodyRows)

        const autoMap = {}
        const detected = {}
        REQUIRED_FIELDS.forEach(({ key }) => {
          const guess = guessColumn(cleanHeaders, key)
          autoMap[key] = guess
          detected[key] = !!guess
        })
        setMapping(autoMap)
        setAutoDetected(detected)
      } catch (err) {
        setParseError(
          err?.message || 'Could not parse this file. Double-check it matches the expected format.'
        )
      }
    }
    reader.readAsArrayBuffer(file)
  }

  function handleFile(e) {
    processFile(e.target.files?.[0])
  }

  function handleDrop(e) {
    e.preventDefault()
    setIsDragging(false)
    processFile(e.dataTransfer.files?.[0])
  }

  async function handleImport() {
    if (!mappingComplete || saving) return
    setSaving(true)
    setImportProgress(0)

    const colIndex = (field) => headers.indexOf(mapping[field])

    const preparedRows = rawRows.map((row, i) => ({
      row_number: i + 2, // +2 accounts for the header row occupying row 1
      payee: String(row[colIndex('payee')] ?? '').trim(),
      payor: String(row[colIndex('payor')] ?? '').trim(),
      check_no: String(row[colIndex('check_no')] ?? '').trim(),
      check_date: normalizeDate(row[colIndex('check_date')]),
      amount: Number(String(row[colIndex('amount')] ?? '0').replace(/[^0-9.-]/g, '')) || 0,
    }))

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      const { data: batch, error: batchError } = await supabase
        .from('upload_batches')
        .insert({ file_name: fileName, total_rows: preparedRows.length, uploaded_by: user?.id })
        .select()
        .single()

      if (batchError) {
        push({ variant: 'error', title: 'Could not create upload batch', description: batchError.message })
        return
      }

      const toInsert = preparedRows.map((r) => ({ ...r, batch_id: batch.id, status: 'available' }))

      // insert in chunks to stay under request size limits
      const chunkSize = 500
      for (let i = 0; i < toInsert.length; i += chunkSize) {
        const chunk = toInsert.slice(i, i + chunkSize)
        const { error } = await supabase.from('checks').insert(chunk)
        if (error) {
          push({ variant: 'error', title: 'Import failed partway', description: error.message })
          return
        }
        setImportProgress(Math.round((Math.min(i + chunk.length, toInsert.length) / toInsert.length) * 100))
      }

      push({
        variant: 'success',
        title: 'Import complete',
        description: `${toInsert.length} checks added from ${fileName}.`,
      })
      setImportedCount(toInsert.length)
    } catch (err) {
      push({
        variant: 'error',
        title: 'Import failed',
        description: err?.message || 'Something went wrong. Please try again.',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-ink-900">Upload a file</h1>
        <p className="mt-1 text-sm text-ink-400">
          Import a CSV or Excel file with Payee, Payor, Check No, Check Date, and Amount columns.
          Each row's position in the file is stored automatically for cross-reference.
        </p>
      </div>

      <StepTracker step={importedCount !== null ? 3 : hasFile ? 2 : 1} />

      <Card className="mt-4">
        <CardContent className="p-6">
          {importedCount !== null ? (
            <ImportedState
              count={importedCount}
              fileName={fileName}
              onUploadAnother={resetFileState}
            />
          ) : (
            <>
              {!hasFile ? (
                <>
                  <label
                    htmlFor="file-upload"
                    onDragOver={(e) => {
                      e.preventDefault()
                      setIsDragging(true)
                    }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={handleDrop}
                    className={cn(
                      'flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed py-12 text-center transition',
                      isDragging
                        ? 'border-teal-500 bg-teal-50'
                        : 'border-ink-200 hover:border-teal-400/60 hover:bg-teal-50/40'
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-12 w-12 items-center justify-center rounded-full transition',
                        isDragging ? 'scale-105 bg-teal-100 text-teal-700' : 'bg-ink-50 text-ink-300'
                      )}
                    >
                      <UploadCloud className="h-6 w-6" />
                    </span>
                    <p className="text-sm font-medium text-ink-700">
                      {isDragging ? 'Drop it here' : 'Click to choose a file, or drag one in'}
                    </p>
                    <p className="text-xs text-ink-300">
                      .csv, .xlsx, or .xls · max recommended size: ~10,000 rows per file
                    </p>
                    <input
                      ref={inputRef}
                      id="file-upload"
                      type="file"
                      accept={ACCEPTED_EXTENSIONS.join(',')}
                      onChange={handleFile}
                      className="hidden"
                    />
                  </label>

                  <div className="mt-3 flex items-center justify-center">
                    <button
                      type="button"
                      onClick={downloadTemplate}
                      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-teal-700 transition hover:bg-teal-50 hover:text-teal-800"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download a template CSV
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-ink-100 bg-ink-50/50 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-teal-100 text-teal-700">
                      <FileSpreadsheet className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-800">{fileName}</p>
                      <p className="font-mono text-xs text-ink-400">
                        {formatFileSize(fileSize)} · {rawRows.length} row{rawRows.length === 1 ? '' : 's'}{' '}
                        detected
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={resetFileState}
                    disabled={saving}
                    className="flex shrink-0 items-center gap-1.5 rounded-md border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-500 hover:bg-white hover:text-red-600 disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </button>
                </div>
              )}

              {parseError && (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3.5 py-3 text-xs text-red-700">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div>
                    <p className="font-medium">Couldn't read this file</p>
                    <p className="mt-0.5 text-red-600/90">{parseError}</p>
                  </div>
                </div>
              )}

              {hasFile && (
                <div className="mt-6">
                  <h3 className="mb-3 font-display text-sm font-semibold text-ink-900">
                    Map your columns
                  </h3>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {REQUIRED_FIELDS.map(({ key, label }) => (
                      <div key={key}>
                        <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-500">
                          {label}
                          {autoDetected[key] && mapping[key] && (
                            <span className="flex items-center gap-0.5 rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] font-medium text-teal-700">
                              <Sparkles className="h-2.5 w-2.5" />
                              auto
                            </span>
                          )}
                        </label>
                        <Select
                          value={mapping[key] || ''}
                          onChange={(e) => {
                            const value = e.target.value
                            setMapping((m) => ({ ...m, [key]: value }))
                            setAutoDetected((d) => ({ ...d, [key]: false }))
                          }}
                          className={cn(!mapping[key] && 'ring-1 ring-orange-400/60')}
                        >
                          <option value="">— Select column —</option>
                          {headers.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </Select>
                      </div>
                    ))}
                  </div>

                  {!mappingComplete && (
                    <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-orange-600">
                      <AlertTriangle className="h-3.5 w-3.5" /> Map all five fields to continue.
                    </p>
                  )}

                  {mappingComplete && dataQuality && totalIssues > 0 && (
                    <div className="mt-4 rounded-md border border-orange-200 bg-orange-50 px-3.5 py-3 text-xs text-ink-600">
                      <p className="flex items-center gap-1.5 font-medium text-orange-600">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Some rows may need a second look
                      </p>
                      <ul className="mt-1.5 space-y-0.5 pl-5 text-ink-500">
                        {dataQuality.missingPayee > 0 && (
                          <li className="list-disc">{dataQuality.missingPayee} row(s) missing a payee</li>
                        )}
                        {dataQuality.missingAmount > 0 && (
                          <li className="list-disc">
                            {dataQuality.missingAmount} row(s) with a zero or unreadable amount
                          </li>
                        )}
                        {dataQuality.missingDate > 0 && (
                          <li className="list-disc">
                            {dataQuality.missingDate} row(s) with a missing or unreadable check date
                          </li>
                        )}
                      </ul>
                      <p className="mt-1.5 text-ink-400">
                        These rows will still be imported — flagged cells are marked orange below so
                        you can double-check the source file or your column mapping.
                      </p>
                    </div>
                  )}

                  <div className="mt-5 overflow-x-auto rounded-md border border-ink-100">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-teal-50 text-teal-700">
                        <tr>
                          <th className="px-3 py-2 font-medium">Row</th>
                          {REQUIRED_FIELDS.map(({ key, label }) => (
                            <th key={key} className="px-3 py-2 font-medium">
                              {label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-dashed divide-ink-100">
                        {previewRows.map((row, i) => {
                          const flags = rowFlags[i] || {}
                          return (
                            <tr key={i} className="transition hover:bg-teal-50/50">
                              <td className="px-3 py-2 font-mono text-ink-300">{i + 2}</td>
                              {REQUIRED_FIELDS.map(({ key }) => {
                                const value = mapping[key]
                                  ? String(row[headers.indexOf(mapping[key])] ?? '')
                                  : ''
                                const flagged = flags[key]
                                return (
                                  <td
                                    key={key}
                                    className={cn(
                                      'px-3 py-2',
                                      flagged ? 'font-medium text-orange-600' : 'text-ink-700'
                                    )}
                                  >
                                    {!mapping[key] ? (
                                      '—'
                                    ) : flagged ? (
                                      <span className="inline-flex items-center gap-1">
                                        <AlertTriangle className="h-3 w-3 shrink-0" />
                                        {value.trim() ? value : 'Missing'}
                                      </span>
                                    ) : (
                                      value || '—'
                                    )}
                                  </td>
                                )
                              })}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-2 flex items-center justify-between">
                    <p className="flex items-center gap-1.5 text-xs text-ink-300">
                      <FileSpreadsheet className="h-3.5 w-3.5 text-teal-400" />
                      Showing {previewRows.length} of {rawRows.length} rows detected.
                    </p>
                    {rawRows.length > PREVIEW_ROW_LIMIT && (
                      <button
                        type="button"
                        onClick={() => setShowAllRows((v) => !v)}
                        className="flex items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-800"
                      >
                        {showAllRows ? (
                          <>
                            <ChevronUp className="h-3.5 w-3.5" />
                            Show fewer rows
                          </>
                        ) : (
                          <>
                            <ChevronDown className="h-3.5 w-3.5" />
                            Show {Math.min(rawRows.length, EXPANDED_PREVIEW_CAP)} rows
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  {saving && (
                    <div className="mt-5">
                      <div className="mb-1.5 flex items-center justify-between text-xs text-ink-400">
                        <span>Importing…</span>
                        <span className="font-mono">{importProgress}%</span>
                      </div>
                      <div
                        className="h-1.5 w-full overflow-hidden rounded-full bg-ink-100"
                        role="progressbar"
                        aria-valuenow={importProgress}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <div
                          className="h-full rounded-full bg-teal-500 transition-all duration-300"
                          style={{ width: `${Math.max(importProgress, 4)}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <Button
                    onClick={handleImport}
                    disabled={!mappingComplete || saving}
                    className="mt-5 bg-orange-500 text-white hover:bg-orange-600 focus-visible:ring-orange-400 disabled:bg-ink-200 disabled:text-ink-400"
                  >
                    {saving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    )}
                    {saving ? 'Importing…' : `Import ${rawRows.length} checks`}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function StepTracker({ step }) {
  const steps = [
    { n: 1, label: 'Upload file' },
    { n: 2, label: 'Map columns' },
    { n: 3, label: 'Imported' },
  ]
  const percent = ((step - 1) / (steps.length - 1)) * 100

  return (
    <div>
      <div className="flex flex-wrap items-center gap-y-2">
        {steps.map((s, i) => {
          const state = step > s.n ? 'done' : step === s.n ? 'active' : 'upcoming'
          return (
            <React.Fragment key={s.n}>
              <div
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 transition',
                  state === 'done' && 'border-teal-300 bg-teal-50',
                  state === 'active' && 'border-teal-400 bg-teal-50/70',
                  state === 'upcoming' && 'border-ink-100 bg-ink-50/40'
                )}
              >
                <span
                  className={cn(
                    'flex h-4 w-4 items-center justify-center rounded-full font-mono text-[10px] font-semibold',
                    state === 'done' && 'bg-teal-600 text-white',
                    state === 'active' && 'bg-teal-700 text-white',
                    state === 'upcoming' && 'bg-ink-200 text-ink-500'
                  )}
                >
                  {state === 'done' ? <CheckCircle2 className="h-3 w-3" /> : s.n}
                </span>
                <span
                  className={cn(
                    'font-mono text-[11px] font-medium',
                    state === 'upcoming' ? 'text-ink-400' : 'text-teal-700'
                  )}
                >
                  {s.label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <ArrowRight className="mx-0.5 h-3 w-3 shrink-0 text-ink-200" aria-hidden="true" />
              )}
            </React.Fragment>
          )
        })}
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-ink-100">
        <div
          className="h-full rounded-full bg-teal-500 transition-all duration-300"
          style={{ width: `${Math.max(percent, 4)}%` }}
        />
      </div>
    </div>
  )
}

function ImportedState({ count, fileName, onUploadAnother }) {
  return (
    <div className="flex flex-col items-center py-10 text-center">
      <span className="stamp-pop flex h-16 w-16 rotate-[-8deg] items-center justify-center rounded-full border-2 border-dashed border-teal-500 bg-teal-50 text-orange-500">
        <Stamp className="h-7 w-7" />
      </span>
      <p className="mt-4 font-display text-lg font-semibold text-ink-900">
        {count} check{count === 1 ? '' : 's'} added to the register
      </p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">
        Imported from <span className="font-medium text-ink-600">{fileName}</span>. They're now
        available for collectors to search and reserve.
      </p>
      <button
        onClick={onUploadAnother}
        className="mt-5 flex items-center gap-1.5 rounded-md border border-ink-200 px-4 py-2 text-sm font-medium text-teal-700 hover:border-teal-300 hover:bg-teal-50"
      >
        <UploadCloud className="h-3.5 w-3.5" />
        Upload another file
      </button>

      <style>{`
        .stamp-pop { animation: stamp-pop 0.2s ease-out; }
        @keyframes stamp-pop {
          from { transform: scale(0.7) rotate(-8deg); opacity: 0; }
          to { transform: scale(1) rotate(-8deg); opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .stamp-pop { animation: none; }
        }
      `}</style>
    </div>
  )
}
