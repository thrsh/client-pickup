// src/lib/reportReference.js
//
// Single source of truth for the reference/transmittal number printed on
// every generated report and transmittal across the app. Import this
// wherever a report or transmittal number is generated — the Reports page
// (AdminReports.jsx) and the Stale Watch page (StaleWatchPanel.jsx /
// StaleReportHistory.jsx) — so a reference number always has the same
// shape no matter where it was produced.
//
// Format:  <LOCATION>-<REPORT_TYPE>-<BANK>-<MMDDYY>-<RANDOM6>
// Example: CSBAPQL-SCR-MBT-080326-7K2N9P
//
//   LOCATION     CSBAPQL (CSBA Parañaque) or CSBABGC (CSBA BGC) — resolved
//                from a branch/location label (e.g. profile.pickupBranch).
//   REPORT_TYPE  3-letter report code — see REPORT_TYPE_CODES below.
//   BANK         3-letter bank code — see BANK_CODE_MAP below — or ALL when
//                the report covers every bank, or MUL when it covers more
//                than one specific bank.
//   MMDDYY       date the report was generated.
//   RANDOM6      6-character alphanumeric, unambiguous character set
//                (no 0/O or 1/I) so it can be read off a printout or
//                handwritten without being misread.

export const REPORT_TYPE_CODES = {
  unreleased: 'UCR', // Unreleased Check Report
  stale: 'SCR', // Stale Check Report / Transmittal
  released: 'RCR', // Released Check Report
  released_audit: 'RCR', // Released Check Report (full audit trail variant)
  or_ar: 'ORA', // OR / AR Report
  cwt_unreleased: 'CUR', // CWT Unreleased Report
  cwt_released: 'CRR', // CWT Released Report
  billing: 'BR', // Billing Report
  summary_released: 'SRR', // Summary Released Report
  summary_unreleased: 'SUR', // Summary Unreleased Report
}

const BANK_CODE_MAP = {
  BDO: 'BDO',
  BPI: 'BPI',
  METROBANK: 'MBT',
  LANDBANK: 'LBP',
  PNB: 'PNB',
  CHINABANK: 'CBC',
  SECURITYBANK: 'SBC',
  RCBC: 'RCB',
  UNIONBANK: 'UBP',
  EASTWEST: 'EWB',
  PSBANK: 'PSB',
}

const ALL_BANKS_CODE = 'ALL'
const MULTI_BANK_CODE = 'MUL'
const GENERIC_BANK_CODE = 'GEN'
const DEFAULT_LOCATION_CODE = 'CSBAPQL'

export function normalizeBankKey(bank) {
  if (!bank) return null
  const key = String(bank).toUpperCase().replace(/[^A-Z]/g, '')
  if (key.includes('BDO') || key.includes('BANCODEORO')) return 'BDO'
  if (key.includes('BPI') || key.includes('BANKOFTHEPHILIPPINEISLANDS')) return 'BPI'
  if (key.includes('METROBANK') || key.includes('METROPOLITANBANK')) return 'METROBANK'
  if (key.includes('LANDBANK')) return 'LANDBANK'
  if (key.includes('PNB') || key.includes('PHILIPPINENATIONALBANK')) return 'PNB'
  if (key.includes('CHINABANK') || key.includes('CHINABANKINGCORP')) return 'CHINABANK'
  if (key.includes('SECURITYBANK')) return 'SECURITYBANK'
  if (key.includes('RCBC') || key.includes('RIZALCOMMERCIALBANKING')) return 'RCBC'
  if (key.includes('UNIONBANK') || key.includes('UNIONBANKOFTHEPHILIPPINES')) return 'UNIONBANK'
  if (key.includes('EASTWEST') || key === 'EWB') return 'EASTWEST'
  if (key.includes('PSBANK') || key.includes('PHILIPPINESAVINGSBANK')) return 'PSBANK'
  return null
}

/**
 * @param {string|string[]|null} bankLabelOrLabels
 * @param {{ allSelected?: boolean }} [opts]
 */
export function resolveBankCode(bankLabelOrLabels, opts = {}) {
  if (opts.allSelected) return ALL_BANKS_CODE
  const list = Array.isArray(bankLabelOrLabels) ? bankLabelOrLabels : [bankLabelOrLabels]
  const distinctKeys = [...new Set(list.filter(Boolean).map(normalizeBankKey).filter(Boolean))]
  if (distinctKeys.length === 0) return ALL_BANKS_CODE
  if (distinctKeys.length > 1) return MULTI_BANK_CODE
  return BANK_CODE_MAP[distinctKeys[0]] || GENERIC_BANK_CODE
}

export function resolveLocationCode(branchLabel) {
  if (!branchLabel) return DEFAULT_LOCATION_CODE
  const key = String(branchLabel).toUpperCase().replace(/[^A-Z]/g, '')
  if (key.includes('BGC') || key.includes('BONIFACIO')) return 'CSBABGC'
  if (key.includes('PARANAQUE') || key.includes('PARQAL') || key.includes('PARANAQL') || key.includes('PQL')) return 'CSBAPQL'
  return DEFAULT_LOCATION_CODE
}

function randomAlphanumeric(length) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O or 1/I
  let out = ''
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

function datePartMMDDYY(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const yy = String(date.getFullYear()).slice(-2)
  return `${mm}${dd}${yy}`
}

/**
 * Builds the unified reference number used on every generated report and
 * transmittal across the app.
 *
 * @param {{
 *   location?: string|null,               // raw branch/location label, e.g. profile.pickupBranch
 *   reportType: keyof REPORT_TYPE_CODES,
 *   bank?: string|string[]|null,          // bank name(s); ignored when bankAll is true
 *   bankAll?: boolean,                    // true when the report covers "All Banks"
 *   date?: Date,
 * }} args
 * @returns {string}
 */
export function generateReportReferenceNumber({ location, reportType, bank, bankAll = false, date } = {}) {
  const locationCode = resolveLocationCode(location)
  const typeCode = REPORT_TYPE_CODES[reportType] || 'RPT'
  const bankCode = resolveBankCode(bank, { allSelected: bankAll })
  const datePart = datePartMMDDYY(date || new Date())
  const randomPart = randomAlphanumeric(6)
  return `${locationCode}-${typeCode}-${bankCode}-${datePart}-${randomPart}`
}
