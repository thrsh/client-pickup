import React, { useEffect, useMemo, useRef, useState } from 'react'
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
  Search,
  Filter,
  CheckSquare,
  Square,
  Lock,
  Wallet,
  Layers,
  X,
  Landmark,
  Info,
  HelpCircle,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Button } from '../../components/ui/button'
import { Card, CardContent } from '../../components/ui/card'
import { Select } from '../../components/ui/select'
import { useToast } from '../../components/ui/toast'
import { normalizeDate, formatCurrency, cn } from '../../lib/utils'
import { logAuditEvent } from '../../lib/adminAuditApi'

// ----------------------------------------------------------------------------
// Field configuration. Toggle EXTRA_FIELDS_REQUIRED to `true` the day
// Client Ref No / Pickup Branch / Account Number become mandatory for every
// upload — mappingComplete, the red-asterisk markers, and the missing-value
// flags all read from FIELD_DEFS[...].required, so this is the ONLY line
// that needs to change to make that switch. It does NOT affect the payee
// columns below — payee has its own conditional requirement (company OR
// individual name) handled separately by `payeeMappingValid` and the
// per-row `missingPayee*` flags, since it can't be expressed as a single
// required/optional flag per field.
//
// CORE_FIELDS vs EXTRA_FIELDS is a SEPARATE split from required/optional —
// it controls table STRUCTURE (which dedicated columns exist), not
// validation. This is deliberate: if EXTRA_FIELDS_REQUIRED flips to true,
// these three fields must NOT also get folded into the generic
// "required columns" header loop, or they'd render twice (once from their
// own <th>, once from a required-fields loop that now includes them).
// ----------------------------------------------------------------------------
const EXTRA_FIELDS_REQUIRED = false

const FIELD_DEFS = [
  // Payee is no longer a single free-text column. It's resolved from
  // EITHER a company name OR an individual's first/middle/last name — a
  // row must supply one or the other. None of these four carry
  // `required: true` here (that flag only drives the plain "map this one
  // column" logic used by REQUIRED_FIELDS below); the real conditional
  // rule — company OR (first AND last) — lives in `payeeMappingValid`
  // (mapping-time) and the per-row `missingPayee*` flags (data-time).
  { key: 'payee_company', label: 'Payee Company', required: false },
  { key: 'payee_first_name', label: 'Payee First Name', required: false },
  { key: 'payee_middle_name', label: 'Payee Middle Name', required: false },
  { key: 'payee_last_name', label: 'Payee Last Name', required: false },
  { key: 'payor', label: 'Payor', required: true },
  { key: 'check_no', label: 'Check No', required: true },
  { key: 'check_date', label: 'Check Date', required: true },
  { key: 'amount', label: 'Amount', required: true },
  { key: 'client_ref_no', label: 'Client Ref. No', required: EXTRA_FIELDS_REQUIRED },
  { key: 'pickup_branch', label: 'Pickup Branch', required: EXTRA_FIELDS_REQUIRED },
  { key: 'account_number', label: 'Account Number', required: EXTRA_FIELDS_REQUIRED },
  // 2307 (BIR withholding certificate) attachment flag. Always optional,
  // but strictly normalized down to a single 'Y' or 'N' regardless of the
  // case or wording ("yes"/"no") used in the source file.
  { key: 'form_2307_attached', label: '2307 Attached (Y/N)', required: false },
]
const FIELD_DEFS_BY_KEY = Object.fromEntries(FIELD_DEFS.map((f) => [f.key, f]))

const CORE_FIELD_KEYS = [
  'payee_company',
  'payee_first_name',
  'payee_middle_name',
  'payee_last_name',
  'payor',
  'check_no',
  'check_date',
  'amount',
]
const CORE_FIELDS = FIELD_DEFS.filter((f) => CORE_FIELD_KEYS.includes(f.key))
const EXTRA_FIELDS = FIELD_DEFS.filter((f) => !CORE_FIELD_KEYS.includes(f.key))

// Used ONLY for "map N required fields to continue" messaging and the
// mappingComplete gate — never for table layout (see note above). Payee
// is deliberately excluded (see FIELD_DEFS comment) and checked via
// `payeeMappingValid` instead.
const REQUIRED_FIELDS = FIELD_DEFS.filter((f) => f.required)

const CLIENT_REF_MAX_LENGTH = 12
const ACCOUNT_NUMBER_MAX_LENGTH = 12
const PICKUP_BRANCH_MAX_LENGTH = 100
const PAYEE_NAME_PART_MAX_LENGTH = 60
const COMPANY_NAME_MAX_LENGTH = 150

// Include, Row, Bank, the resolved Payee column, and every configured
// field column — computed instead of hardcoded so it can never drift out
// of sync with the actual <th> count, including if more optional fields
// are added later.
const PREVIEW_COLSPAN = CORE_FIELDS.length + EXTRA_FIELDS.length + 4

// Default bank list — extend/edit as needed, or swap this for a Supabase
// lookup (e.g. a `banks` table) later without touching anything else,
// since every consumer below reads from `bankValue`/`bankValid` only.
const BANKS = [
  'BDO Unibank',
  'Bank of the Philippine Islands (BPI)',
  'Metrobank',
  'Land Bank of the Philippines',
  'Philippine National Bank (PNB)',
  'China Banking Corporation (Chinabank)',
  'Rizal Commercial Banking Corporation (RCBC)',
  'Security Bank',
  'UnionBank of the Philippines',
  'EastWest Bank',
  'Philippine Savings Bank (PSBank)',
]
const OTHER_BANK_VALUE = '__other__'
const MAX_CUSTOM_BANK_LENGTH = 100

const ACCEPTED_EXTENSIONS = ['.csv', '.xlsx', '.xls']
// Browsers report CSV/Excel MIME types inconsistently (many omit it
// entirely), so this is a best-effort secondary check layered on top of
// the extension check — it only rejects files that are clearly something
// else (e.g. a renamed PDF or image), not ambiguous/empty types.
const ACCEPTED_MIME_TYPES = new Set([
  '',
  'text/csv',
  'application/csv',
  'text/plain',
  'text/x-csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream', // some OSes report this for .xlsx
])

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB
const MAX_ROWS = 1000
const PREVIEW_ROW_LIMIT = 5
const EXPANDED_PREVIEW_CAP = MAX_ROWS
const DUPLICATE_CHECK_DEBOUNCE_MS = 400
const DUPLICATE_CHECK_CHUNK_SIZE = 300
const IMPORT_CHUNK_SIZE = 500

// Human-readable labels for every validation flag a row can carry — reused
// by the breakdown panel, the per-cell tooltips, and the flagged-rows CSV
// export so the wording never drifts between the three.
const FLAG_LABELS = {
  missingPayee: 'Missing payee (no company or individual name provided)',
  missingPayeeFirstName: 'Missing payee first name (required when no company is given)',
  missingPayeeLastName: 'Missing payee last name (required when no company is given)',
  invalidPayeeFirstName: 'Payee first name must be letters only (no numbers, periods, or commas)',
  invalidPayeeMiddleName: 'Payee middle name must be letters only (no numbers, periods, or commas)',
  invalidPayeeLastName: 'Payee last name must be letters only (no numbers, periods, or commas)',
  bothPayeeProvided: 'Both a company and an individual name were given — the company name will be used',
  missingPayor: 'Missing payor',
  missingCheckNo: 'Missing check no.',
  invalidAmount: 'Invalid or zero amount',
  negativeAmount: 'Negative amount',
  missingDate: 'Missing or unreadable date',
  futureDate: 'Check dated in the future',
  duplicateCheckNo: 'Exact duplicate row (same bank, payee, payor, check no. & check date)',
  existsInSystem: 'This exact row is already imported',
  missingClientRefNo: 'Missing client ref. no.',
  invalidClientRefNo: 'Client ref. no. must be digits only (max 12 characters)',
  missingAccountNumber: 'Missing account number',
  invalidAccountNumber: 'Account number must be digits only (max 12 characters)',
  missingPickupBranch: 'Missing pickup branch',
  pickupBranchFormat: 'Pickup branch format looks unusual (expected e.g. "CSBA - Parqal")',
  invalidForm2307Attached: '2307 Attached must be Y or N',
}

// Builds the composite key duplicate detection is scoped to. A row is only
// a duplicate if EVERY ONE of bank, payee, payor, check no., and check
// date matches another row exactly — change any single field (a different
// payee, a different date, etc.) and it's a distinct, allowed row, even if
// everything else lines up. (Ref no./account number are NOT part of this
// key today — add them here later if duplicates should also be scoped by
// those fields.) `payee` here is always the RESOLVED name (company, or
// joined individual name) — never the raw split columns — so duplicate
// detection stays correct regardless of which payee format a row used.
function fullRowKey(bank, checkNo, payee, payor, checkDate) {
  return [bank, checkNo, payee, payor, checkDate]
    .map((v) => String(v ?? '').trim().toLowerCase())
    .join('::')
}

// best-effort auto-detection of column headers
function guessColumn(headers, field) {
  const patterns = {
    payee_company: /payee.?company|company.?name|^payee$/i,
    payee_first_name: /payee.?first|first.?name|given.?name/i,
    payee_middle_name: /payee.?middle|middle.?name/i,
    payee_last_name: /payee.?last|last.?name|surname/i,
    payor: /payor|payer/i,
    check_no: /check.?no|check.?number/i,
    check_date: /check.?date|date/i,
    amount: /amount|amt/i,
    client_ref_no: /client.?ref|ref.?no|reference/i,
    pickup_branch: /pickup.?branch|branch/i,
    account_number: /account.?(no|number|num)/i,
    form_2307_attached: /2307|attached/i,
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

// Validates a File object before it's ever read — extension, best-effort
// MIME type, emptiness, and the 5 MB size cap. Row-count validation
// happens later, once the file is actually parsed.
function validateFile(file) {
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    return `Unsupported file type "${ext || 'unknown'}". Please upload a ${ACCEPTED_EXTENSIONS.join(', ')} file.`
  }
  if (file.type && !ACCEPTED_MIME_TYPES.has(file.type)) {
    return `This doesn't look like a spreadsheet file (detected type: ${file.type}). Please export it as CSV or Excel and try again.`
  }
  if (file.size === 0) {
    return 'This file is empty.'
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `This file is ${formatFileSize(file.size)}, which exceeds the ${formatFileSize(
      MAX_FILE_SIZE_BYTES,
    )} limit. Please split it into smaller files.`
  }
  return null
}

// ---- Data normalization helpers -------------------------------------------

function normalizeText(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ')
}

function normalizeCheckNo(raw) {
  return String(raw ?? '').trim()
}

// Strips currency symbols, thousands separators, and stray characters;
// treats parenthesized values as negative (common in accounting exports),
// and rounds to cents so downstream sums/display are exact.
function normalizeAmountValue(raw) {
  if (raw === null || raw === undefined) return NaN
  const str = String(raw).trim()
  if (!str) return NaN
  const isParenNegative = /^\(.*\)$/.test(str)
  const cleaned = str.replace(/[^0-9.\-]/g, '')
  if (!cleaned || cleaned === '-' || cleaned === '.') return NaN
  let value = Number(cleaned)
  if (Number.isNaN(value)) return NaN
  if (isParenNegative) value = -Math.abs(value)
  return Math.round(value * 100) / 100
}

// Excel/Sheets sometimes stores an all-digit column as a genuine NUMBER
// rather than text. `toFixed(0)` avoids exponential notation (e.g.
// "1.2e+11") that plain String(raw) could otherwise produce for large
// values. NOTE: this can't recover leading zeros the source file already
// lost by typing that column as Number format instead of Text — that's a
// spreadsheet-formatting issue upstream of this app, not fixable here.
// Ask the source to format Client Ref No / Account Number columns as Text
// before export if this becomes a recurring problem.
function numericCellToString(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw.toFixed(0) : String(raw)
  }
  return String(raw ?? '').trim()
}

// Strictly digits-only, capped at maxLength. Blank is valid — these fields
// are optional for now (see EXTRA_FIELDS_REQUIRED above). Kept as a
// STRING, never parsed to Number, so leading zeros survive.
function normalizeDigitsOnly(raw, maxLength) {
  const value = numericCellToString(raw).trim()
  if (!value) return { value: '', present: false, valid: true }
  const valid = /^\d+$/.test(value) && value.length <= maxLength
  return { value, present: true, valid }
}

// Soft format check only — flags anything that doesn't look like
// "CODE - Location" (e.g. "CSBA - Parqal") for review, but NEVER blocks
// import, since real branch names will vary more than one pattern can
// fully anticipate.
const PICKUP_BRANCH_FORMAT_RE = /^[A-Za-z0-9.&']+(\s+[A-Za-z0-9.&']+)*\s-\s[A-Za-z0-9.&' ]+$/

function normalizePickupBranch(raw, maxLength) {
  const value = normalizeText(raw).slice(0, maxLength)
  if (!value) return { value: '', present: false, formatOk: true }
  return { value, present: true, formatOk: PICKUP_BRANCH_FORMAT_RE.test(value) }
}

// Individual name parts (first/middle/last) must be LETTERS ONLY — no
// digits, periods, or commas. A single space is still allowed so a
// legitimately two-word name part ("Mary Jane") isn't rejected, but
// nothing else (hyphens, apostrophes, etc.) passes — the spec here is
// deliberately strict. Blank is always valid: middle name is optional
// even for an individual payee, and a company payee doesn't need any of
// these three filled in at all.
function normalizeIndividualNamePart(raw, maxLength = PAYEE_NAME_PART_MAX_LENGTH) {
  const value = normalizeText(raw).slice(0, maxLength)
  if (!value) return { value: '', present: false, valid: true }
  const valid = /^[A-Za-z]+(?: [A-Za-z]+)*$/.test(value)
  return { value, present: true, valid }
}

// Company name is free text — punctuation like "Inc.", "&", "," is normal
// and expected in a legal company name — so it only gets the generic
// whitespace-collapsing normalization, never the letters-only check
// applied to individual name parts.
function normalizeCompanyName(raw, maxLength = COMPANY_NAME_MAX_LENGTH) {
  const value = normalizeText(raw).slice(0, maxLength)
  return { value, present: value.length > 0 }
}

// Accepts y/n or yes/no in any case, with surrounding whitespace, and
// collapses all of that down to a single canonical 'Y' or 'N' so the
// column only ever shows one of those two values. Anything unrecognized
// (blank, "N/A", a stray typo, etc.) is left alone and caught by the
// invalidForm2307Attached flag instead of being silently guessed at.
function normalizeYesNo(raw) {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return { value: '', present: false, valid: true }
  const lower = trimmed.toLowerCase()
  let normalized = null
  if (lower === 'y' || lower === 'yes') normalized = 'Y'
  else if (lower === 'n' || lower === 'no') normalized = 'N'
  return { value: normalized ?? trimmed, present: true, valid: normalized !== null }
}

// The single source of truth for "what payee name actually gets saved."
// Company takes priority when BOTH a company and an individual name were
// supplied (the `bothPayeeProvided` flag surfaces this combination for
// review rather than silently dropping the individual name). Otherwise
// the individual's name parts are joined in first/middle/last order,
// skipping whichever parts are blank.
function resolvePayeeName({ company, first, middle, last }) {
  if (company) return company
  return [first, middle, last].filter(Boolean).join(' ')
}

function downloadTemplate() {
  const csvContent = [
    'Payee Company,Payee First Name,Payee Middle Name,Payee Last Name,Payor,Check No,Check Date,Amount,Client Ref No,Pickup Branch,Account Number,2307 Attached',
    'Acme Corp,,,,Acme Corp,00123,2024-01-15,250.00,123456789012,CSBA - Parqal,000123456789,Y',
    ',Jane,Marie,Doe,Acme Corp,00124,2024-02-03,1050.75,,,,N',
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

// Exports the currently-flagged rows (with a plain-English reason column)
// so an admin can hand the list to whoever owns the source file instead of
// hunting through the on-screen preview row by row.
function downloadFlaggedRows(rows, fileNameBase) {
  if (rows.length === 0) return
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const header =
    'Row,Bank,Payee (Resolved),Payee Company,Payee First Name,Payee Middle Name,Payee Last Name,Payor,Check No,Check Date,Amount,Client Ref No,Pickup Branch,Account Number,2307 Attached,Issues'
  const lines = rows.map((r) => {
    const issues = Object.entries(FLAG_LABELS)
      .filter(([key]) => r.flags[key])
      .map(([, label]) => label)
      .join('; ')
    return [
      r.rowNumber,
      esc(r.bank),
      esc(r.payee),
      esc(r.payee_company),
      esc(r.payee_first_name),
      esc(r.payee_middle_name),
      esc(r.payee_last_name),
      esc(r.payor),
      esc(r.check_no),
      esc(r.check_date || ''),
      r.amount,
      esc(r.client_ref_no || ''),
      esc(r.pickup_branch || ''),
      esc(r.account_number || ''),
      esc(r.form_2307_attached || ''),
      esc(issues),
    ].join(',')
  })
  const csv = [header, ...lines].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${fileNameBase.replace(/\.[^.]+$/, '') || 'import'}-flagged-rows.csv`
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
  const [importedBank, setImportedBank] = useState('') // snapshot for the success screen
  const [showAllRows, setShowAllRows] = useState(false)

  // Which bank this file's checks belong to. Selected up front and required
  // before a file can even be chosen, so every row that ever enters the
  // pipeline is guaranteed to carry a valid, non-empty bank.
  const [selectedBank, setSelectedBank] = useState('')
  const [customBank, setCustomBank] = useState('')

  // Advanced preview controls
  const [excludedRows, setExcludedRows] = useState(() => new Set()) // indices (into rawRows) excluded from import
  const [previewSearch, setPreviewSearch] = useState('')
  const [showFlaggedOnly, setShowFlaggedOnly] = useState(false)
  const [showDupHelp, setShowDupHelp] = useState(false)

  // Cross-checks the mapped (bank, check no., payee, payor, check date)
  // combinations against what's already in the database, so re-uploading
  // the same batch (or an overlapping one) gets caught before it creates
  // duplicate register entries. Only an EXACT match across all five fields
  // counts — change any one of them and it's a distinct, allowed entry.
  const [existingCheckNos, setExistingCheckNos] = useState(() => new Set())
  const [checkingDuplicates, setCheckingDuplicates] = useState(false)

  const inputRef = useRef(null)
  const { push } = useToast()

  const hasFile = headers.length > 0

  // The payee columns are a conditional pair rather than plain required
  // fields: an admin must map EITHER Payee Company, OR both Payee First
  // Name and Payee Last Name (middle name is always optional, for both a
  // company and an individual). That can't be expressed as a single
  // FIELD_DEFS `required: true` flag, so it's checked here and folded into
  // mappingComplete alongside the ordinary required fields.
  const payeeMappingValid = !!mapping.payee_company || (!!mapping.payee_first_name && !!mapping.payee_last_name)
  const mappingComplete = REQUIRED_FIELDS.every(({ key }) => mapping[key]) && payeeMappingValid

  // Resolves the dropdown + free-text "Other" combo down to a single,
  // trimmed bank name every other piece of state can depend on.
  const bankValue = useMemo(() => {
    if (!selectedBank) return ''
    if (selectedBank === OTHER_BANK_VALUE) return normalizeText(customBank)
    return selectedBank
  }, [selectedBank, customBank])
  const bankValid = bankValue.length > 0
  const needsCustomBankName = selectedBank === OTHER_BANK_VALUE && customBank.trim().length === 0

  // ---- Normalization + validation pipeline --------------------------------
  // Every row is normalized once here (trimmed text, parsed currency,
  // standardized dates, the resolved payee name, and the selected bank)
  // and tagged with every applicable validation flag. Everything
  // downstream — the KPI cards, the preview table, the CSV export, and
  // the actual import — reads from this single source of truth so
  // normalization can never drift between what's shown and what's saved.
  const normalizedRows = useMemo(() => {
    if (!mappingComplete || !bankValid || rawRows.length === 0) return []

    const payeeCompanyIdx = mapping.payee_company ? headers.indexOf(mapping.payee_company) : -1
    const payeeFirstNameIdx = mapping.payee_first_name ? headers.indexOf(mapping.payee_first_name) : -1
    const payeeMiddleNameIdx = mapping.payee_middle_name ? headers.indexOf(mapping.payee_middle_name) : -1
    const payeeLastNameIdx = mapping.payee_last_name ? headers.indexOf(mapping.payee_last_name) : -1
    const payorIdx = headers.indexOf(mapping.payor)
    const checkNoIdx = headers.indexOf(mapping.check_no)
    const dateIdx = headers.indexOf(mapping.check_date)
    const amountIdx = headers.indexOf(mapping.amount)
    // Optional for now — only look up an index if the column was actually
    // mapped; -1 means "not present in this file," which is allowed.
    const clientRefIdx = mapping.client_ref_no ? headers.indexOf(mapping.client_ref_no) : -1
    const pickupBranchIdx = mapping.pickup_branch ? headers.indexOf(mapping.pickup_branch) : -1
    const accountNumberIdx = mapping.account_number ? headers.indexOf(mapping.account_number) : -1
    const form2307Idx = mapping.form_2307_attached ? headers.indexOf(mapping.form_2307_attached) : -1

    const draft = rawRows.map((row, i) => {
      const rawAmount = normalizeAmountValue(row[amountIdx])
      const clientRef = normalizeDigitsOnly(clientRefIdx >= 0 ? row[clientRefIdx] : '', CLIENT_REF_MAX_LENGTH)
      const accountNumber = normalizeDigitsOnly(
        accountNumberIdx >= 0 ? row[accountNumberIdx] : '',
        ACCOUNT_NUMBER_MAX_LENGTH,
      )
      const pickupBranch = normalizePickupBranch(
        pickupBranchIdx >= 0 ? row[pickupBranchIdx] : '',
        PICKUP_BRANCH_MAX_LENGTH,
      )

      // ---- Payee: company OR individual, resolved intelligently -------
      const company = normalizeCompanyName(payeeCompanyIdx >= 0 ? row[payeeCompanyIdx] : '')
      const firstName = normalizeIndividualNamePart(payeeFirstNameIdx >= 0 ? row[payeeFirstNameIdx] : '')
      const middleName = normalizeIndividualNamePart(payeeMiddleNameIdx >= 0 ? row[payeeMiddleNameIdx] : '')
      const lastName = normalizeIndividualNamePart(payeeLastNameIdx >= 0 ? row[payeeLastNameIdx] : '')
      const payeeType = company.present
        ? 'company'
        : firstName.present || lastName.present
        ? 'individual'
        : 'none'
      const resolvedPayee = resolvePayeeName({
        company: company.value,
        first: firstName.value,
        middle: middleName.value,
        last: lastName.value,
      })

      const form2307 = normalizeYesNo(form2307Idx >= 0 ? row[form2307Idx] : '')

      return {
        index: i,
        rowNumber: i + 2, // +2 accounts for the header row occupying row 1
        bank: bankValue,
        // Resolved value — what actually gets saved as `payee`.
        payee: resolvedPayee,
        payee_company: company.value,
        payee_first_name: firstName.value,
        payee_middle_name: middleName.value,
        payee_last_name: lastName.value,
        payeeType,
        payeeCompanyPresent: company.present,
        payeeFirstNamePresent: firstName.present,
        payeeFirstNameValid: firstName.valid,
        payeeMiddleNamePresent: middleName.present,
        payeeMiddleNameValid: middleName.valid,
        payeeLastNamePresent: lastName.present,
        payeeLastNameValid: lastName.valid,
        payor: normalizeText(row[payorIdx]),
        check_no: normalizeCheckNo(row[checkNoIdx]),
        check_date: normalizeDate(row[dateIdx]),
        amount: Number.isNaN(rawAmount) ? 0 : rawAmount,
        amountInvalid: Number.isNaN(rawAmount),
        client_ref_no: clientRef.value,
        clientRefPresent: clientRef.present,
        clientRefValid: clientRef.valid,
        account_number: accountNumber.value,
        accountNumberPresent: accountNumber.present,
        accountNumberValid: accountNumber.valid,
        pickup_branch: pickupBranch.value,
        pickupBranchPresent: pickupBranch.present,
        pickupBranchFormatOk: pickupBranch.formatOk,
        form_2307_attached: form2307.value,
        form2307Present: form2307.present,
        form2307Valid: form2307.valid,
      }
    })

    // Duplicate detection requires every one of bank, check no., payee,
    // payor, AND check date to match — a row is only flagged if another
    // row in the file is identical across all five. Any single field
    // being different (a different payor, a different date, etc.) makes
    // it a distinct row, not a duplicate. `payee` here is always the
    // resolved name, so it stays correct whether a row used a company or
    // an individual name.
    const rowCounts = new Map()
    draft.forEach((r) => {
      if (!r.check_no) return
      const key = fullRowKey(r.bank, r.check_no, r.payee, r.payor, r.check_date)
      rowCounts.set(key, (rowCounts.get(key) || 0) + 1)
    })

    const todayEnd = new Date()
    todayEnd.setHours(23, 59, 59, 999)

    return draft.map((r) => {
      const flags = {
        // A completely blank payee (no company, no individual name at
        // all) gets just this one flag — the more specific
        // missingPayeeFirstName/LastName flags below only fire once the
        // row has committed to the "individual" path (i.e. at least one
        // of first/last was given) but left the other blank.
        missingPayee: r.payeeType === 'none',
        missingPayeeFirstName: r.payeeType === 'individual' && !r.payeeFirstNamePresent,
        missingPayeeLastName: r.payeeType === 'individual' && !r.payeeLastNamePresent,
        invalidPayeeFirstName: r.payeeFirstNamePresent && !r.payeeFirstNameValid,
        invalidPayeeMiddleName: r.payeeMiddleNamePresent && !r.payeeMiddleNameValid,
        invalidPayeeLastName: r.payeeLastNamePresent && !r.payeeLastNameValid,
        bothPayeeProvided: r.payeeCompanyPresent && (r.payeeFirstNamePresent || r.payeeLastNamePresent),
        missingPayor: !r.payor,
        missingCheckNo: !r.check_no,
        invalidAmount: r.amountInvalid || r.amount === 0,
        negativeAmount: !r.amountInvalid && r.amount < 0,
        missingDate: !r.check_date,
        futureDate: !!r.check_date && new Date(r.check_date) > todayEnd,
        duplicateCheckNo:
          !!r.check_no &&
          rowCounts.get(fullRowKey(r.bank, r.check_no, r.payee, r.payor, r.check_date)) > 1,
        missingClientRefNo: FIELD_DEFS_BY_KEY.client_ref_no.required && !r.clientRefPresent,
        invalidClientRefNo: r.clientRefPresent && !r.clientRefValid,
        missingAccountNumber: FIELD_DEFS_BY_KEY.account_number.required && !r.accountNumberPresent,
        invalidAccountNumber: r.accountNumberPresent && !r.accountNumberValid,
        missingPickupBranch: FIELD_DEFS_BY_KEY.pickup_branch.required && !r.pickupBranchPresent,
        pickupBranchFormat: r.pickupBranchPresent && !r.pickupBranchFormatOk,
        invalidForm2307Attached: r.form2307Present && !r.form2307Valid,
      }
      const hasIssue = Object.values(flags).some(Boolean)
      return { ...r, flags, hasIssue }
    })
  }, [mappingComplete, bankValid, bankValue, rawRows, headers, mapping])

  // Looks up mapped check numbers against the database (narrowed further
  // to an exact bank+payee+payor+date match client-side below). Debounced
  // and best-effort in the sense that a failed/slow lookup never blocks
  // the UI — but any exact match it does find is treated as a hard
  // duplicate (see the force-exclude effect below), not just a warning.
  useEffect(() => {
    if (normalizedRows.length === 0) {
      setExistingCheckNos(new Set())
      return
    }
    const uniqueNos = [...new Set(normalizedRows.map((r) => r.check_no).filter(Boolean))]
    if (uniqueNos.length === 0 || !bankValue) {
      setExistingCheckNos(new Set())
      return
    }

    let cancelled = false
    setCheckingDuplicates(true)
    const t = setTimeout(async () => {
      try {
        const found = new Set()
        for (let i = 0; i < uniqueNos.length; i += DUPLICATE_CHECK_CHUNK_SIZE) {
          const chunk = uniqueNos.slice(i, i + DUPLICATE_CHECK_CHUNK_SIZE)
          const { data, error } = await supabase
            .from('checks')
            .select('check_no, payee, payor, check_date')
            .eq('bank', bankValue) // scope to this bank only
            .in('check_no', chunk)
          if (!error && data) {
            data.forEach((d) => {
              if (d.check_no) {
                found.add(fullRowKey(bankValue, d.check_no, d.payee, d.payor, d.check_date))
              }
            })
          }
        }
        if (!cancelled) setExistingCheckNos(found)
      } catch {
        // Best-effort only — a failed lookup just means this particular
        // safety net doesn't fire; it never blocks the import itself.
      } finally {
        if (!cancelled) setCheckingDuplicates(false)
      }
    }, DUPLICATE_CHECK_DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [normalizedRows, bankValue])

  // Merges the synchronous validation flags with the async system-duplicate
  // check into the rows the rest of the UI actually renders from. `blocked`
  // marks rows that are strictly disallowed — an exact bank+payee+payor+
  // check no.+check date match, either within this file or already in the
  // system — and can never be included in the import.
  const enrichedRows = useMemo(() => {
    if (normalizedRows.length === 0) return []
    return normalizedRows.map((r) => {
      const existsInSystem =
        !!r.check_no &&
        existingCheckNos.has(fullRowKey(r.bank, r.check_no, r.payee, r.payor, r.check_date))
      const flags = { ...r.flags, existsInSystem }
      const blocked = flags.duplicateCheckNo || existsInSystem
      return { ...r, flags, hasIssue: r.hasIssue || existsInSystem, blocked }
    })
  }, [normalizedRows, existingCheckNos])

  // Exact-match rows (bank, check no., payee, payor & check date all the
  // same) are strictly not allowed — force them out of the included set
  // the moment they're detected, and keep them out even if excludedRows
  // gets reset elsewhere (e.g. "Include all").
  useEffect(() => {
    const blockedIndices = enrichedRows.filter((r) => r.blocked).map((r) => r.index)
    if (blockedIndices.length === 0) return
    setExcludedRows((prev) => {
      const alreadyExcluded = blockedIndices.every((i) => prev.has(i))
      if (alreadyExcluded) return prev
      const next = new Set(prev)
      blockedIndices.forEach((i) => next.add(i))
      return next
    })
  }, [enrichedRows])

  const existsInSystemCount = useMemo(
    () => enrichedRows.filter((r) => r.flags.existsInSystem).length,
    [enrichedRows],
  )

  const issueBreakdown = useMemo(() => {
    const counts = {}
    Object.keys(FLAG_LABELS).forEach((k) => {
      counts[k] = 0
    })
    enrichedRows.forEach((r) => {
      Object.keys(counts).forEach((k) => {
        if (r.flags[k]) counts[k] += 1
      })
    })
    return counts
  }, [enrichedRows])

  // KPI summary — total rows, how many are actually going to be imported
  // once exclusions (including forced ones) are applied, how many still
  // need review, how many are strictly blocked, and the dollar total of
  // what's about to be saved.
  const stats = useMemo(() => {
    if (enrichedRows.length === 0) return null
    const included = enrichedRows.filter((r) => !excludedRows.has(r.index))
    const flaggedIncluded = included.filter((r) => r.hasIssue)
    const validIncluded = included.filter((r) => !r.hasIssue)
    const totalAmount = included.reduce((s, r) => s + (Number.isFinite(r.amount) ? r.amount : 0), 0)
    return {
      total: enrichedRows.length,
      included: included.length,
      excluded: excludedRows.size,
      valid: validIncluded.length,
      flagged: flaggedIncluded.length,
      blocked: enrichedRows.filter((r) => r.blocked).length,
      totalAmount,
      duplicateCount: issueBreakdown.duplicateCheckNo,
    }
  }, [enrichedRows, excludedRows, issueBreakdown])

  // Search + "flagged only" filter applied on top of the enriched rows,
  // independent from pagination (showAllRows) so all three compose cleanly.
  const searchedRows = useMemo(() => {
    let list = enrichedRows
    if (showFlaggedOnly) list = list.filter((r) => r.hasIssue)
    const q = previewSearch.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (r) =>
          r.payee.toLowerCase().includes(q) ||
          r.payor.toLowerCase().includes(q) ||
          r.check_no.toLowerCase().includes(q),
      )
    }
    return list
  }, [enrichedRows, showFlaggedOnly, previewSearch])

  const previewRows = showAllRows ? searchedRows.slice(0, EXPANDED_PREVIEW_CAP) : searchedRows.slice(0, PREVIEW_ROW_LIMIT)

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
    setImportedBank('')
    setShowAllRows(false)
    setExcludedRows(new Set())
    setPreviewSearch('')
    setShowFlaggedOnly(false)
    setExistingCheckNos(new Set())
    // Deliberately NOT resetting selectedBank/customBank — admins commonly
    // upload several files from the same bank back to back, so the choice
    // persists until they explicitly change it.
    if (inputRef.current) inputRef.current.value = ''
  }

  function processFile(file) {
    if (!file) return

    if (!bankValid) {
      push({
        variant: 'error',
        title: 'Select a bank first',
        description: 'Choose which bank this file is coming from before uploading.',
      })
      return
    }

    const validationError = validateFile(file)
    if (validationError) {
      push({ variant: 'error', title: 'File not accepted', description: validationError })
      return
    }

    setParseError('')
    setImportedCount(null)
    setImportedBank('')
    setShowAllRows(false)
    setExcludedRows(new Set())
    setPreviewSearch('')
    setShowFlaggedOnly(false)
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

        if (bodyRows.length > MAX_ROWS) {
          push({
            variant: 'error',
            title: 'Too many rows',
            description: `This file has ${bodyRows.length.toLocaleString()} rows, which exceeds the ${MAX_ROWS.toLocaleString()}-row limit per file. Please split it into multiple files and upload them separately.`,
          })
          resetFileState()
          return
        }

        setHeaders(cleanHeaders)
        setRawRows(bodyRows)

        const autoMap = {}
        const detected = {}
        FIELD_DEFS.forEach(({ key }) => {
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
    if (!bankValid) {
      push({
        variant: 'error',
        title: 'Select a bank first',
        description: 'Choose which bank this file is coming from before uploading.',
      })
      return
    }
    if (e.dataTransfer.files?.length > 1) {
      push({
        variant: 'error',
        title: 'One file at a time',
        description: 'Drop a single CSV or Excel file — only the first one was used.',
      })
    }
    processFile(e.dataTransfer.files?.[0])
  }

  function handleBankSelectChange(e) {
    const value = e.target.value
    setSelectedBank(value)
    if (value !== OTHER_BANK_VALUE) setCustomBank('')
  }

  // Exact-match rows are strictly disallowed and cannot be manually
  // re-included — the checkbox for those rows is disabled in the UI, and
  // this is the second line of defense.
  function toggleRowExcluded(row) {
    if (row.blocked) return
    setExcludedRows((prev) => {
      const next = new Set(prev)
      if (next.has(row.index)) next.delete(row.index)
      else next.add(row.index)
      return next
    })
  }

  function excludeAllFlagged() {
    setExcludedRows((prev) => {
      const next = new Set(prev)
      enrichedRows.forEach((r) => {
        if (r.hasIssue) next.add(r.index)
      })
      return next
    })
  }

  function includeAllRows() {
    // Blocked rows (exact bank + check no. + payee + payor + date match)
    // stay excluded even on bulk include.
    setExcludedRows(new Set(enrichedRows.filter((r) => r.blocked).map((r) => r.index)))
  }

  async function handleImport() {
    if (!mappingComplete || !bankValid || saving) return

    // Defense in depth: never send a blocked (exact duplicate row) to the
    // database, regardless of what excludedRows currently holds.
    const includedRows = enrichedRows.filter((r) => !excludedRows.has(r.index) && !r.blocked)
    if (includedRows.length === 0) {
      push({
        variant: 'error',
        title: 'Nothing to import',
        description: 'Every row is excluded or blocked as a duplicate. Include at least one row before importing.',
      })
      return
    }

    setSaving(true)
    setImportProgress(0)

    // Rows already carry their normalized values (including the resolved
    // payee name and bank) from the pipeline above, so the saved data
    // always matches exactly what the preview showed. Both the resolved
    // `payee` (kept for backward compatibility / search / duplicate
    // checks) and the raw split columns are saved, so nothing is lost.
    const preparedRows = includedRows.map((r) => ({
      row_number: r.rowNumber,
      bank: r.bank,
      payee: r.payee,
      payee_company: r.payee_company || null,
      payee_first_name: r.payee_first_name || null,
      payee_middle_name: r.payee_middle_name || null,
      payee_last_name: r.payee_last_name || null,
      payor: r.payor,
      check_no: r.check_no,
      check_date: r.check_date,
      amount: r.amount,
      client_ref_no: r.client_ref_no || null,
      pickup_branch: r.pickup_branch || null,
      account_number: r.account_number || null,
      form_2307_attached: r.form_2307_attached || null,
    }))

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      const { data: batch, error: batchError } = await supabase
        .from('upload_batches')
        .insert({
          file_name: fileName,
          bank: bankValue,
          total_rows: preparedRows.length,
          uploaded_by: user?.id,
        })
        .select()
        .single()

      if (batchError) {
        push({ variant: 'error', title: 'Could not create upload batch', description: batchError.message })
        return
      }

      const toInsert = preparedRows.map((r) => ({ ...r, batch_id: batch.id, status: 'available' }))

      // insert in chunks to stay under request size limits
      for (let i = 0; i < toInsert.length; i += IMPORT_CHUNK_SIZE) {
        const chunk = toInsert.slice(i, i + IMPORT_CHUNK_SIZE)
        const { error } = await supabase.from('checks').insert(chunk)
        if (error) {
          push({ variant: 'error', title: 'Import failed partway', description: error.message })
          return
        }
        setImportProgress(Math.round((Math.min(i + chunk.length, toInsert.length) / toInsert.length) * 100))
      }

      logAuditEvent('checks_uploaded', {
        batch_id: batch.id,
        file_name: fileName,
        bank: bankValue,
        row_count: toInsert.length,
        excluded_count: enrichedRows.length - toInsert.length,
      }).catch(() => {})

      const excludedTotal = enrichedRows.length - toInsert.length
      push({
        variant: 'success',
        title: 'Import complete',
        description:
          excludedTotal > 0
            ? `${toInsert.length} ${bankValue} checks added from ${fileName} (${excludedTotal} excluded).`
            : `${toInsert.length} ${bankValue} checks added from ${fileName}.`,
      })
      setImportedBank(bankValue)
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

  const currentStep = importedCount !== null ? 4 : hasFile ? 3 : bankValid ? 2 : 1

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-ink-900">Upload a file</h1>
        <p className="mt-1 text-sm text-ink-400">
          Select the source bank, then import a CSV or Excel file (up to {formatFileSize(MAX_FILE_SIZE_BYTES)},{' '}
          {MAX_ROWS.toLocaleString()} rows max) with Payor, Check No, Check Date, and Amount columns. For the
          payee, map either a Payee Company column, or Payee First/Middle/Last Name columns for an individual —
          whichever one is filled in for a row is what gets saved. A row is only treated as a duplicate if its
          bank, payee, payor, check no., and check date all match another row exactly — change any one of those
          and it's a distinct row.
        </p>
      </div>

      <StepTracker step={currentStep} />

      <Card className="mt-4">
        <CardContent className="p-6">
          {importedCount !== null ? (
            <ImportedState
              count={importedCount}
              fileName={fileName}
              bank={importedBank}
              onUploadAnother={resetFileState}
            />
          ) : (
            <>
              <div className="mb-6">
                <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-500">
                  <Landmark className="h-3.5 w-3.5 text-teal-500" />
                  Bank <span className="text-red-500">*</span>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={selectedBank}
                    onChange={handleBankSelectChange}
                    disabled={saving}
                    className={cn('max-w-xs', !bankValid && 'ring-1 ring-orange-400/60')}
                  >
                    <option value="">— Select bank —</option>
                    {BANKS.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                    <option value={OTHER_BANK_VALUE}>Other (type manually)</option>
                  </Select>
                  {selectedBank === OTHER_BANK_VALUE && (
                    <input
                      type="text"
                      value={customBank}
                      onChange={(e) => setCustomBank(e.target.value.slice(0, MAX_CUSTOM_BANK_LENGTH))}
                      disabled={saving}
                      placeholder="Enter bank name"
                      maxLength={MAX_CUSTOM_BANK_LENGTH}
                      autoFocus
                      className={cn(
                        'w-56 rounded-md border px-3 py-1.5 text-sm text-ink-800 focus:outline-none focus:ring-1 focus:ring-teal-400',
                        needsCustomBankName ? 'border-orange-300' : 'border-ink-200',
                      )}
                    />
                  )}
                </div>
                {!bankValid ? (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-orange-600">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {needsCustomBankName
                      ? 'Type the bank name to continue.'
                      : 'Select which bank this file is coming from before uploading.'}
                  </p>
                ) : (
                  hasFile && (
                    <p className="mt-1.5 text-xs text-ink-400">
                      All {rawRows.length.toLocaleString()} rows will be tagged as{' '}
                      <span className="font-medium text-ink-600">{bankValue}</span>.
                    </p>
                  )
                )}
              </div>

              {!hasFile ? (
                <>
                  <label
                    htmlFor="file-upload"
                    onDragOver={(e) => {
                      e.preventDefault()
                      if (bankValid) setIsDragging(true)
                    }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={handleDrop}
                    onClick={(e) => {
                      if (!bankValid) {
                        e.preventDefault()
                        push({
                          variant: 'error',
                          title: 'Select a bank first',
                          description: 'Choose which bank this file is coming from before uploading.',
                        })
                      }
                    }}
                    className={cn(
                      'flex flex-col items-center gap-2 rounded-lg border-2 border-dashed py-12 text-center transition',
                      !bankValid && 'cursor-not-allowed opacity-60',
                      bankValid && 'cursor-pointer',
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
                      .csv, .xlsx, or .xls · up to {formatFileSize(MAX_FILE_SIZE_BYTES)} · max{' '}
                      {MAX_ROWS.toLocaleString()} rows per file
                    </p>
                    <input
                      ref={inputRef}
                      id="file-upload"
                      type="file"
                      accept={ACCEPTED_EXTENSIONS.join(',')}
                      onChange={handleFile}
                      disabled={!bankValid}
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
                        {formatFileSize(fileSize)} / {formatFileSize(MAX_FILE_SIZE_BYTES)} ·{' '}
                        {rawRows.length.toLocaleString()} / {MAX_ROWS.toLocaleString()} rows ·{' '}
                        <span className="text-teal-700">{bankValue}</span>
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
                    {FIELD_DEFS.map(({ key, label, required }) => (
                      <div key={key}>
                        <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-500">
                          {label}
                          {required ? (
                            <span className="text-red-500">*</span>
                          ) : (
                            <span className="text-[10px] font-normal text-ink-300">(optional)</span>
                          )}
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
                          className={cn(required && !mapping[key] && 'ring-1 ring-orange-400/60')}
                        >
                          <option value="">{required ? '— Select column —' : '— Not in this file —'}</option>
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
                    <div className="mt-3 space-y-1">
                      {!REQUIRED_FIELDS.every(({ key }) => mapping[key]) && (
                        <p className="flex items-center gap-1.5 text-xs font-medium text-orange-600">
                          <AlertTriangle className="h-3.5 w-3.5" /> Map all {REQUIRED_FIELDS.length} required
                          field{REQUIRED_FIELDS.length === 1 ? '' : 's'} to continue.
                        </p>
                      )}
                      {!payeeMappingValid && (
                        <p className="flex items-center gap-1.5 text-xs font-medium text-orange-600">
                          <AlertTriangle className="h-3.5 w-3.5" /> Map either Payee Company, or both Payee
                          First Name and Payee Last Name, to identify the payee.
                        </p>
                      )}
                    </div>
                  )}

                  {/* KPI summary row — same visual language as the checks
                      register and dashboard, so every admin page reads the
                      same way. Fed entirely by the normalization pipeline
                      above; no extra network calls beyond the debounced
                      duplicate-number lookup already running. */}
                  {mappingComplete && stats && (
                    <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
                      <KpiCard
                        icon={Layers}
                        label="Total rows"
                        value={stats.total}
                        secondary={stats.excluded > 0 ? `${stats.excluded} excluded` : 'None excluded'}
                        accent="lightTeal"
                      />
                      <KpiCard
                        icon={CheckCircle2}
                        label="Ready to import"
                        value={stats.included}
                        secondary={`${stats.valid} with no issues`}
                        accent="teal"
                      />
                      <KpiCard
                        icon={AlertTriangle}
                        label="Needs review"
                        value={stats.flagged}
                        secondary={
                          checkingDuplicates
                            ? 'Checking for duplicates…'
                            : `${stats.duplicateCount} duplicate check no.`
                        }
                        accent="orange"
                      />
                      <KpiCard
                        icon={Wallet}
                        label="Total amount"
                        value={formatCurrency(stats.totalAmount)}
                        secondary={`${stats.included} check${stats.included === 1 ? '' : 's'} included`}
                        accent="teal"
                      />
                    </div>
                  )}

                  {mappingComplete && stats && stats.blocked > 0 && (
                    <div className="mt-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3.5 py-3 text-xs text-red-700">
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <div>
                        <p className="font-medium">
                          {stats.blocked} row{stats.blocked === 1 ? '' : 's'} blocked — exact duplicate of another
                          row under {bankValue}
                        </p>
                        <p className="mt-0.5 text-red-600/90">
                          {existsInSystemCount > 0
                            ? `${existsInSystemCount} of these ${
                                existsInSystemCount === 1 ? 'is' : 'are'
                              } already imported with the same bank, payee, payor, check no., and check date. `
                            : ''}
                          A row only counts as a duplicate when every one of bank, payee, payor, check no., and
                          check date matches another row exactly — if even one field differs, it's allowed.
                          Matching rows are highlighted red below and excluded automatically — they can't be
                          re-included.
                        </p>
                      </div>
                    </div>
                  )}

                  {mappingComplete && stats && stats.flagged > 0 && (
                    <div className="mt-4 rounded-md border border-orange-200 bg-orange-50 px-3.5 py-3 text-xs text-ink-600">
                      <p className="flex items-center gap-1.5 font-medium text-orange-600">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Some rows may need a second look
                      </p>
                      <ul className="mt-1.5 space-y-0.5 pl-5 text-ink-500">
                        {Object.entries(issueBreakdown)
                          .filter(([, count]) => count > 0)
                          .map(([key, count]) => (
                            <li key={key} className="list-disc">
                              {count} row{count === 1 ? '' : 's'} — {FLAG_LABELS[key].toLowerCase()}
                            </li>
                          ))}
                      </ul>
                      <p className="mt-1.5 text-ink-400">
                        Rows that exactly duplicate another row (same bank, payee, payor, check no. & check date)
                        are locked and can't be re-included. Other flagged rows stay included by default — exclude
                        them below if you don't want them imported.
                      </p>
                    </div>
                  )}

                  {/* Preview toolbar — search, flagged-only filter, bulk
                      include/exclude actions, and a flagged-rows export. */}
                  <div className="mt-5 flex flex-wrap items-center gap-2">
                    <div className="relative min-w-[200px] flex-1">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
                      <input
                        type="text"
                        value={previewSearch}
                        onChange={(e) => setPreviewSearch(e.target.value)}
                        placeholder="Search payee, payor, or check no..."
                        className="w-full rounded-md border border-ink-200 py-1.5 pl-8 pr-7 text-xs text-ink-800 focus:outline-none focus:ring-1 focus:ring-teal-400"
                      />
                      {previewSearch && (
                        <button
                          onClick={() => setPreviewSearch('')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-300 hover:text-ink-600"
                          aria-label="Clear search"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowFlaggedOnly((v) => !v)}
                      aria-pressed={showFlaggedOnly}
                      className={cn(
                        'flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition',
                        showFlaggedOnly
                          ? 'border-orange-300 bg-orange-50 text-orange-700'
                          : 'border-ink-200 text-ink-500 hover:bg-ink-50',
                      )}
                    >
                      <Filter className="h-3.5 w-3.5" />
                      Flagged only
                    </button>
                    <button
                      type="button"
                      onClick={excludeAllFlagged}
                      disabled={!stats || stats.flagged === 0}
                      className="flex shrink-0 items-center gap-1 rounded-md border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-500 hover:bg-ink-50 disabled:opacity-40"
                    >
                      Exclude all flagged
                    </button>
                    <button
                      type="button"
                      onClick={includeAllRows}
                      disabled={excludedRows.size === 0 || excludedRows.size === (stats?.blocked ?? 0)}
                      className="flex shrink-0 items-center gap-1 rounded-md border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-500 hover:bg-ink-50 disabled:opacity-40"
                    >
                      Include all
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadFlaggedRows(enrichedRows.filter((r) => r.hasIssue), fileName)}
                      disabled={!stats || stats.flagged === 0}
                      className="flex shrink-0 items-center gap-1.5 rounded-md border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-teal-700 hover:bg-teal-50 disabled:opacity-40 disabled:text-ink-400 disabled:hover:bg-transparent"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download flagged rows
                    </button>
                  </div>

                  {/* Row color legend — makes the highlighting in the table
                      self-explanatory instead of something admins have to
                      infer from the banner text above. */}
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-400">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-sm bg-red-100 ring-1 ring-inset ring-red-300" />
                      Blocked duplicate
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-sm bg-amber-100 ring-1 ring-inset ring-amber-300" />
                      Needs review
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-sm bg-slate-100 ring-1 ring-inset ring-slate-300" />
                      Excluded
                    </span>
                  </div>

                  <div className="mt-3 overflow-x-auto rounded-md border border-ink-100">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-teal-50 text-teal-700">
                        <tr>
                          <th className="px-3 py-2 font-medium">Include</th>
                          <th className="px-3 py-2 font-medium">Row</th>
                          <th className="px-3 py-2 font-medium">Bank</th>
                          <th className="px-3 py-2 font-medium">Payee (Resolved)</th>
                          {CORE_FIELDS.map(({ key, label }) => (
                            <th key={key} className="px-3 py-2 font-medium">
                              {key === 'check_no' ? (
                                <span className="relative inline-flex items-center gap-1">
                                  {label}
                                  <button
                                    type="button"
                                    onClick={() => setShowDupHelp((v) => !v)}
                                    onBlur={() => setShowDupHelp(false)}
                                    aria-label="How duplicate check numbers are handled"
                                    className="text-teal-400 hover:text-teal-700"
                                  >
                                    <HelpCircle className="h-3 w-3" />
                                  </button>
                                  {showDupHelp && (
                                    <span className="absolute left-0 top-5 z-10 w-64 rounded-md border border-ink-200 bg-white p-2.5 text-[11px] font-normal normal-case text-ink-600 shadow-lg">
                                      A check no. can repeat freely — it's only a duplicate when the bank, payee,
                                      payor, check no., AND check date all match another row exactly.
                                    </span>
                                  )}
                                </span>
                              ) : (
                                label
                              )}
                            </th>
                          ))}
                          {EXTRA_FIELDS.map(({ key, label, required }) => (
                            <th key={key} className="px-3 py-2 font-medium">
                              {label}
                              {!required && (
                                <span className="ml-1 text-[10px] font-normal normal-case text-teal-400">
                                  (optional)
                                </span>
                              )}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-dashed divide-ink-100">
                        {previewRows.map((r) => {
                          const isExcluded = excludedRows.has(r.index)
                          const isCritical = r.flags.duplicateCheckNo || r.flags.existsInSystem
                          return (
                            <tr
                              key={r.index}
                              className={cn(
                                'transition',
                                isExcluded && 'bg-slate-50/70 opacity-60',
                                !isExcluded && isCritical && 'bg-red-50/70',
                                !isExcluded && !isCritical && r.hasIssue && 'bg-amber-50/50',
                                !isExcluded && !r.hasIssue && 'hover:bg-teal-50/50',
                              )}
                            >
                              <td className="px-3 py-2">
                                <button
                                  type="button"
                                  onClick={() => toggleRowExcluded(r)}
                                  disabled={r.blocked}
                                  aria-pressed={!isExcluded}
                                  aria-label={
                                    r.blocked
                                      ? `Row ${r.rowNumber} blocked — exact duplicate of another row`
                                      : isExcluded
                                      ? `Include row ${r.rowNumber}`
                                      : `Exclude row ${r.rowNumber}`
                                  }
                                  title={
                                    r.blocked
                                      ? 'Exact duplicate (same bank, payee, payor, check no. & check date) — cannot be imported'
                                      : undefined
                                  }
                                  className={cn(
                                    r.blocked
                                      ? 'cursor-not-allowed text-red-400'
                                      : isExcluded
                                      ? 'text-ink-300 hover:text-ink-500'
                                      : 'text-teal-600',
                                  )}
                                >
                                  {r.blocked ? (
                                    <Lock className="h-4 w-4" />
                                  ) : isExcluded ? (
                                    <Square className="h-4 w-4" />
                                  ) : (
                                    <CheckSquare className="h-4 w-4" />
                                  )}
                                </button>
                              </td>
                              <td className="px-3 py-2 font-mono text-ink-300">{r.rowNumber}</td>
                              <td className="px-3 py-2 text-ink-700">{r.bank}</td>

                              {/* Resolved payee — what actually gets saved
                                  as `payee`: the company name when given,
                                  otherwise the joined first/middle/last.
                                  Shown up front so an admin can sanity-
                                  check the combination at a glance instead
                                  of cross-referencing four columns. */}
                              <PreviewCell
                                value={r.payee}
                                missing={r.flags.missingPayee}
                                invalid={r.flags.bothPayeeProvided}
                                tooltip={
                                  r.flags.bothPayeeProvided
                                    ? 'Both a company and an individual name were given — using the company name'
                                    : undefined
                                }
                              />

                              <PreviewCell value={r.payee_company} missing={false} />
                              <PreviewCell
                                value={r.payee_first_name}
                                missing={r.flags.missingPayeeFirstName}
                                invalid={r.flags.invalidPayeeFirstName}
                                tooltip={
                                  r.flags.invalidPayeeFirstName
                                    ? 'Letters only — no numbers, periods, or commas'
                                    : undefined
                                }
                              />
                              <PreviewCell
                                value={r.payee_middle_name}
                                missing={false}
                                invalid={r.flags.invalidPayeeMiddleName}
                                tooltip={
                                  r.flags.invalidPayeeMiddleName
                                    ? 'Letters only — no numbers, periods, or commas'
                                    : undefined
                                }
                              />
                              <PreviewCell
                                value={r.payee_last_name}
                                missing={r.flags.missingPayeeLastName}
                                invalid={r.flags.invalidPayeeLastName}
                                tooltip={
                                  r.flags.invalidPayeeLastName
                                    ? 'Letters only — no numbers, periods, or commas'
                                    : undefined
                                }
                              />
                              <PreviewCell
                                value={r.payor}
                                missing={r.flags.missingPayor}
                              />
                              <td
                                className={cn(
                                  'px-3 py-2 font-mono',
                                  isCritical
                                    ? 'font-medium text-red-600'
                                    : r.flags.missingCheckNo
                                    ? 'font-medium text-orange-600'
                                    : 'text-ink-700',
                                )}
                                title={
                                  r.flags.duplicateCheckNo && r.flags.existsInSystem
                                    ? 'Exact duplicate within this file, and already imported'
                                    : r.flags.duplicateCheckNo
                                    ? 'Exact duplicate of another row within this file'
                                    : r.flags.existsInSystem
                                    ? 'This exact row is already imported for this bank'
                                    : undefined
                                }
                              >
                                {r.flags.missingCheckNo ? (
                                  <span className="inline-flex items-center gap-1">
                                    <AlertTriangle className="h-3 w-3 shrink-0" />
                                    Missing
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1">
                                    {isCritical && <AlertCircle className="h-3 w-3 shrink-0" />}
                                    {r.check_no}
                                  </span>
                                )}
                              </td>
                              <PreviewCell
                                value={r.check_date}
                                missing={r.flags.missingDate}
                                invalid={r.flags.futureDate}
                                missingLabel="Missing"
                                tooltip={r.flags.futureDate ? 'This check is dated in the future' : undefined}
                              />
                              <PreviewCell
                                value={r.flags.invalidAmount ? undefined : formatCurrency(r.amount)}
                                missing={r.flags.invalidAmount}
                                missingLabel="Invalid"
                                invalid={r.flags.negativeAmount}
                                tooltip={r.flags.negativeAmount ? 'Negative amount' : undefined}
                                mono
                              />
                              <PreviewCell
                                value={r.client_ref_no}
                                missing={r.flags.missingClientRefNo}
                                invalid={r.flags.invalidClientRefNo}
                                tooltip={
                                  r.flags.invalidClientRefNo
                                    ? `Must be digits only, max ${CLIENT_REF_MAX_LENGTH} characters`
                                    : undefined
                                }
                                mono
                              />
                              <PreviewCell
                                value={r.pickup_branch}
                                missing={r.flags.missingPickupBranch}
                                invalid={r.flags.pickupBranchFormat}
                                tooltip={
                                  r.flags.pickupBranchFormat ? 'Expected format e.g. "CSBA - Parqal"' : undefined
                                }
                              />
                              <PreviewCell
                                value={r.account_number}
                                missing={r.flags.missingAccountNumber}
                                invalid={r.flags.invalidAccountNumber}
                                tooltip={
                                  r.flags.invalidAccountNumber
                                    ? `Must be digits only, max ${ACCOUNT_NUMBER_MAX_LENGTH} characters`
                                    : undefined
                                }
                                mono
                              />
                              <PreviewCell
                                value={r.form_2307_attached}
                                missing={false}
                                invalid={r.flags.invalidForm2307Attached}
                                tooltip={r.flags.invalidForm2307Attached ? 'Must be Y or N' : undefined}
                              />
                            </tr>
                          )
                        })}
                        {previewRows.length === 0 && (
                          <tr>
                            <td colSpan={PREVIEW_COLSPAN} className="px-3 py-10 text-center text-ink-300">
                              <div className="flex flex-col items-center gap-1.5">
                                <Search className="h-5 w-5 text-ink-200" />
                                <span>No rows match your search or filter.</span>
                                {(previewSearch.trim() || showFlaggedOnly) && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setPreviewSearch('')
                                      setShowFlaggedOnly(false)
                                    }}
                                    className="mt-1 text-xs font-medium text-teal-700 hover:text-teal-800"
                                  >
                                    Clear filters
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-xs text-ink-300">
                      <FileSpreadsheet className="h-3.5 w-3.5 text-teal-400" />
                      Showing {previewRows.length} of {searchedRows.length} row{searchedRows.length === 1 ? '' : 's'}
                      {showFlaggedOnly || previewSearch.trim() ? ' matching your filters' : ' detected'}
                      {(showFlaggedOnly || previewSearch.trim()) &&
                        enrichedRows.length !== searchedRows.length &&
                        ` (${enrichedRows.length} total)`}
                    </p>
                    {searchedRows.length > PREVIEW_ROW_LIMIT && (
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
                            Show all {Math.min(searchedRows.length, EXPANDED_PREVIEW_CAP)} rows
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

                  {/* Sticky action bar — keeps the import decision visible
                      even after scrolling through a long preview table,
                      instead of forcing a scroll back up to act. */}
                  <div className="sticky bottom-0 -mx-6 mt-5 border-t border-ink-100 bg-white/95 px-6 py-3.5 backdrop-blur">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="flex items-center gap-1.5 text-xs text-ink-400">
                        <Info className="h-3.5 w-3.5 shrink-0" />
                        {stats && stats.blocked > 0
                          ? `${stats.blocked} row${stats.blocked === 1 ? '' : 's'} can't be imported due to duplicates.`
                          : 'Review the rows above, then import when ready.'}
                      </p>
                      <Button
                        onClick={handleImport}
                        disabled={!mappingComplete || !bankValid || saving || (stats && stats.included === 0)}
                        className="bg-orange-500 text-white hover:bg-orange-600 focus-visible:ring-orange-400 disabled:bg-ink-200 disabled:text-ink-400"
                      >
                        {saving ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        )}
                        {saving
                          ? 'Importing…'
                          : stats
                          ? `Import ${stats.included} check${stats.included === 1 ? '' : 's'}${
                              stats.excluded > 0 ? ` (${stats.excluded} excluded)` : ''
                            }`
                          : `Import ${rawRows.length} checks`}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// Generic preview-table cell: shows a "Missing"/"Invalid" pill with an
// icon when the value fails validation, otherwise the value itself
// (optionally flagged as needing review, e.g. a future-dated check or a
// negative amount that's present but still worth a second look).
// Extracted because this exact three-state pattern (missing / present-
// but-flagged / normal) was previously duplicated across 7+ table cells;
// keeping it in one place means a future styling tweak only happens once.
function PreviewCell({ value, missing, missingLabel = 'Missing', invalid, tooltip, mono = false }) {
  if (missing) {
    return (
      <td className="px-3 py-2 font-medium text-orange-600">
        <span className="inline-flex items-center gap-1">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {missingLabel}
        </span>
      </td>
    )
  }
  return (
    <td className={cn('px-3 py-2', mono && 'font-mono', invalid ? 'font-medium text-orange-600' : 'text-ink-700')}>
      <span className="inline-flex items-center gap-1" title={tooltip}>
        {invalid && <AlertTriangle className="h-3 w-3 shrink-0" />}
        {value || '—'}
      </span>
    </td>
  )
}

// Compact stat card — same pattern used on the dashboard and checks
// register, so every admin page reads the same way. Color usage follows
// the brand palette: teal for healthy/actionable states, light teal for
// the neutral aggregate total, and orange for anything needing review.
function KpiCard({ icon: Icon, label, value, secondary, accent = 'teal' }) {
  const accents = {
    teal: { badge: 'bg-teal-100 text-teal-700', ring: 'border-teal-300' },
    lightTeal: { badge: 'bg-teal-50 text-teal-600', ring: 'border-teal-200' },
    orange: { badge: 'bg-orange-100 text-orange-600', ring: 'border-orange-300' },
  }
  const style = accents[accent] || accents.teal
  const isLoading = value === null || value === undefined

  return (
    <Card>
      <CardContent className="relative overflow-hidden p-4">
        <div
          className={cn(
            'pointer-events-none absolute -right-4 -top-4 h-16 w-16 rounded-full border-2 border-dashed',
            style.ring,
          )}
          aria-hidden="true"
        />
        <div className="relative flex items-start gap-3">
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', style.badge)}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            {isLoading ? (
              <div className="h-6 w-14 animate-pulse rounded bg-ink-100" />
            ) : (
              <p className="truncate font-display text-lg font-semibold text-ink-900">
                {typeof value === 'number' ? value.toLocaleString() : value}
              </p>
            )}
            <p className="truncate text-xs text-ink-400">{label}</p>
            {!isLoading && secondary && (
              <p className="mt-0.5 truncate font-mono text-xs text-ink-500">{secondary}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function StepTracker({ step }) {
  const steps = [
    { n: 1, label: 'Select bank' },
    { n: 2, label: 'Upload file' },
    { n: 3, label: 'Map columns' },
    { n: 4, label: 'Imported' },
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

function ImportedState({ count, fileName, bank, onUploadAnother }) {
  return (
    <div className="flex flex-col items-center py-10 text-center">
      <span className="stamp-pop flex h-16 w-16 rotate-[-8deg] items-center justify-center rounded-full border-2 border-dashed border-teal-500 bg-teal-50 text-orange-500">
        <Stamp className="h-7 w-7" />
      </span>
      <p className="mt-4 font-display text-lg font-semibold text-ink-900">
        {count} check{count === 1 ? '' : 's'} added to the register
      </p>
      <p className="mt-1 max-w-sm text-sm text-ink-400">
        Imported from <span className="font-medium text-ink-600">{fileName}</span>
        {bank && (
          <>
            {' '}
            (<span className="font-medium text-ink-600">{bank}</span>)
          </>
        )}
        . They're now available for collectors to search and reserve.
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