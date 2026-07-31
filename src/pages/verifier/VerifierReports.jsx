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
  Landmark,
  Truck,
  CalendarRange,
  Layers,
  LayoutGrid,
  Receipt,
  PieChart,
} from 'lucide-react'
import ExcelJS from 'exceljs'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { supabase } from '../../lib/supabaseClient'
import { useProfile } from '../../context/ProfileContext'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { useToast } from '../../components/ui/toast'
import { formatCurrency } from '../../lib/utils'
import { logAuditEvent } from '../../lib/adminAuditApi'

const BRAND = {
  teal: '#0d9488',
  orange: '#f97316',
  gray: '#64748b',
}
const BRAND_TEAL_RGB = [13, 148, 136]

const MANUAL_FILL_COLOR = 'FFFFFBEA'
const STALE_FILL_COLOR = 'FFFDE7CB'
const HEADER_FILL_COLOR = 'FF0D9488'
const BORDER_COLOR = 'FFD1D5DB'

const ALL_PAYEES_LABEL = 'All Payees'
const ALL_BANKS_LABEL = 'All Banks'
const STALE_FIXED_MONTHS = 6

const LOGO_URL = '/logo.png'

const BANK_LOGO_PATHS = {
  BDO: '/bdo_logo.png',
  BPI: '/bpi_logo.png',
  CHINABANK: '/chinabank_logo.png',
  LANDBANK: '/landbank_logo.png',
  METROBANK: '/metrobank_logo.png',
  PNB: '/pnb_logo.svg',
  PSBANK: '/psbank_logo.svg',
  RCBC: '/rcbc_logo.png',
  SECURITYBANK: '/securitybank_logo.png',
  UNIONBANK: '/unionbank_logo.png',
}

function normalizeBankKey(bank) {
  if (!bank) return null
  const key = String(bank).toUpperCase().replace(/[^A-Z]/g, '')
  if (key.includes('BDO') || key.includes('BANCODEORO')) return 'BDO'
  if (key.includes('BPI') || key.includes('BANKOFTHEPHILIPPINEISLANDS')) return 'BPI'
  if (key.includes('CHINABANK') || key.includes('CHINABANKINGCORP')) return 'CHINABANK'
  if (key.includes('LANDBANK')) return 'LANDBANK'
  if (key.includes('METROBANK') || key.includes('METROPOLITANBANK')) return 'METROBANK'
  if (key.includes('PNB') || key.includes('PHILIPPINENATIONALBANK')) return 'PNB'
  if (key.includes('PSBANK') || key.includes('PHILIPPINESAVINGSBANK')) return 'PSBANK'
  if (key.includes('RCBC') || key.includes('RIZALCOMMERCIALBANKING')) return 'RCBC'
  if (key.includes('SECURITYBANK')) return 'SECURITYBANK'
  if (key.includes('UNIONBANK') || key.includes('UNIONBANKOFTHEPHILIPPINES')) return 'UNIONBANK'
  return null
}

function getClientName(row) {
  return row.payor || ''
}

function statusLabel(status) {
  if (status === 'picked_up') return 'Picked Up'
  if (status === 'available') return 'Available'
  return status || ''
}

function releasedStatusLabel(status) {
  return status === 'picked_up' ? 'Released' : statusLabel(status)
}

function releasedUnreleasedLabel(status) {
  return status === 'picked_up' ? 'Released' : 'Unreleased'
}

function arCollectedLabel(value) {
  if (value === true) return 'Y'
  if (value === false) return 'N'
  return ''
}

function attached2307Label(value) {
  if (value === true) return 'Y'
  if (value === false) return 'N'
  return ''
}

function remarksLabel(status) {
  return status === 'picked_up' ? 'Released' : ''
}

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

function todayDateInputValue() {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function monthsAgoDateInputValue(months) {
  const now = new Date()
  now.setMonth(now.getMonth() - months)
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function isStale(checkDate) {
  if (!checkDate) return false
  const cutoff = new Date(monthsAgoDateInputValue(STALE_FIXED_MONTHS))
  return new Date(checkDate) <= cutoff
}

function formatMultiSelectDisplay(allSelected, values, allLabel) {
  if (allSelected) return allLabel
  if (!values || values.length === 0) return '—'
  if (values.length <= 3) return values.join(', ')
  return `${values.length} selected (${values.slice(0, 2).join(', ')}, +${values.length - 2} more)`
}

function multiSelectFileTag(allSelected, values, allTag) {
  if (allSelected) return allTag
  if (!values || values.length === 0) return allTag
  if (values.length === 1) return values[0].replace(/[^a-z0-9]+/gi, '_')
  return `${values.length}-selected`
}

function thinBorder() {
  return {
    top: { style: 'thin', color: { argb: BORDER_COLOR } },
    left: { style: 'thin', color: { argb: BORDER_COLOR } },
    bottom: { style: 'thin', color: { argb: BORDER_COLOR } },
    right: { style: 'thin', color: { argb: BORDER_COLOR } },
  }
}

function formatCellDisplay(cell) {
  if (cell.value instanceof Date) {
    return cell.value.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
  }
  if (typeof cell.value === 'number' && cell.numFmt === '#,##0.00') {
    return cell.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  return cell.value === '' || cell.value == null ? '' : String(cell.value)
}

function friendlyError(err) {
  const msg = err?.message || ''
  const lower = msg.toLowerCase()
  if (lower.includes('permission denied')) return "You don't have access to this data. Contact an admin."
  if (lower.includes('jwt') || lower.includes('auth')) return 'Your session expired — please refresh and sign in again.'
  if (lower.includes('failed to fetch') || lower.includes('network')) return 'Network error — check your connection and try again.'
  return msg || 'Something went wrong loading this report. Please try again.'
}

async function loadImageAsset(url) {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Image request failed with status ${res.status}`)
    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    try {
      const img = await new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('Failed to decode image'))
        image.src = objectUrl
      })
      const width = img.naturalWidth || img.width || 1
      const height = img.naturalHeight || img.height || 1
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, width, height)
      const dataUrl = canvas.toDataURL('image/png')
      const arrayBuffer = await (await fetch(dataUrl)).arrayBuffer()
      return { dataUrl, arrayBuffer, width, height, aspect: width / height }
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  } catch (err) {
    console.warn(`Could not load image asset at ${url}:`, err)
    return null
  }
}

function fitToHeight(asset, targetHeight, maxWidth = Infinity) {
  const aspect = asset?.aspect || 1
  let width = targetHeight * aspect
  let height = targetHeight
  if (width > maxWidth) {
    width = maxWidth
    height = maxWidth / aspect
  }
  return { width, height }
}

let _logoAssetPromise = null
function loadLogoAssets() {
  if (!_logoAssetPromise) _logoAssetPromise = loadImageAsset(LOGO_URL)
  return _logoAssetPromise
}

const _bankLogoAssetPromises = new Map()
function loadBankLogoAsset(bankRaw) {
  const key = normalizeBankKey(bankRaw)
  if (!key || !BANK_LOGO_PATHS[key]) return Promise.resolve(null)
  if (!_bankLogoAssetPromises.has(key)) {
    _bankLogoAssetPromises.set(key, loadImageAsset(BANK_LOGO_PATHS[key]))
  }
  return _bankLogoAssetPromises.get(key)
}

function generateTransmittalNumber(bankLabel) {
  const now = new Date()
  const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const rawBankCode = bankLabel && bankLabel !== ALL_BANKS_LABEL ? bankLabel : 'MULTI'
  const bankCode = (rawBankCode.replace(/[^A-Za-z0-9]+/g, '').slice(0, 6) || 'BANK').toUpperCase()
  const randomSuffix = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `TRM-${bankCode}-${datePart}-${randomSuffix}`
}

// --- Excel column-width -> pixel helpers, used to place the letterhead logo
// flush against the right edge of the sheet so it never sits on top of the
// left-aligned company / report details. ---
function excelColWidthToPixels(width) {
  const w = Number(width) || 8.43
  return Math.round(w * 7 + 5)
}

function computeRightAlignedImageAnchor(columns, imageWidthPx, marginPx = 6) {
  const pixelWidths = columns.map((c) => excelColWidthToPixels(c.width))
  const totalWidth = pixelWidths.reduce((a, b) => a + b, 0)
  let targetLeftPx = totalWidth - imageWidthPx - marginPx
  if (targetLeftPx < 0) targetLeftPx = 0
  let cumulative = 0
  for (let i = 0; i < pixelWidths.length; i++) {
    if (cumulative + pixelWidths[i] > targetLeftPx) {
      const fraction = pixelWidths[i] > 0 ? (targetLeftPx - cumulative) / pixelWidths[i] : 0
      return { col: i + fraction, row: 0.15 }
    }
    cumulative += pixelWidths[i]
  }
  return { col: Math.max(0, pixelWidths.length - 1), row: 0.15 }
}

const REPORT_CONFIG = {
  released: {
    category: 'released',
    fileTag: 'released-check-report',
    title: 'RELEASED CHECK REPORT',
    statusFilter: 'picked_up',
    requiresPayor: true,
    showReleasedDateField: true,
    extraDateColumn: null,
    extraDateLabel: null,
    showStaleness: false,
    cwtAttachedOnly: false,
    amountColIndex: 7,
    legendText: 'Highlighted cells are blank in the file — fill them in manually after export.',
    columns: [
      { header: 'NO', width: 6 },
      { header: 'Bank', width: 20 },
      { header: 'Check Date', width: 14 },
      { header: 'Date Uploaded', width: 14 },
      { header: 'Payee', width: 26 },
      { header: 'Check No.', width: 16 },
      { header: 'Check Amount', width: 16 },
      { header: 'Client Name', width: 26 },
      { header: 'Status', width: 14 },
      { header: 'Date Released', width: 14 },
      { header: 'Aging (Days)', width: 12 },
      { header: 'OR No.', width: 14 },
      { header: 'AR Collected (Y/N)', width: 16 },
      { header: '2307 Attached (Y/N)', width: 16 },
      { header: 'Remarks', width: 24 },
    ],
    buildRow: (r, no) => [
      { value: no, align: 'center' },
      { value: r.bank || '', align: 'center' },
      { value: r.check_date ? new Date(r.check_date) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: r.created_at ? new Date(r.created_at) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: r.payee || '' },
      { value: r.check_no || '', align: 'center' },
      { value: Number(r.amount || 0), numFmt: '#,##0.00', align: 'right' },
      { value: getClientName(r) },
      { value: releasedStatusLabel(r.status), align: 'center' },
      { value: r.picked_up_at ? new Date(r.picked_up_at) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: daysBetween(r.created_at, r.picked_up_at) ?? '', align: 'center' },
      { value: r.or_no || '', align: 'center', fill: r.or_no ? undefined : MANUAL_FILL_COLOR },
      { value: arCollectedLabel(r.ar_collected), align: 'center', fill: r.ar_collected == null ? MANUAL_FILL_COLOR : undefined },
      { value: attached2307Label(r.attached_2307), align: 'center', fill: r.attached_2307 == null ? MANUAL_FILL_COLOR : undefined },
      { value: remarksLabel(r.status) },
    ],
  },

  released_audit: {
    category: 'released',
    fileTag: 'released-check-report-audit-trail',
    title: 'RELEASED CHECK REPORT — FULL AUDIT TRAIL',
    statusFilter: 'picked_up',
    requiresPayor: true,
    showReleasedDateField: true,
    extraDateColumn: null,
    extraDateLabel: null,
    showStaleness: false,
    cwtAttachedOnly: false,
    amountColIndex: 9,
    legendText:
      'Highlighted cells indicate missing audit data — the step may not have happened yet, or the record predates this tracking.',
    columns: [
      { header: 'NO', width: 6 },
      { header: 'Bank', width: 20 },
      { header: 'Check Date', width: 14 },
      { header: 'Date Uploaded', width: 14 },
      { header: 'Uploaded By', width: 20 },
      { header: 'Payee', width: 24 },
      { header: 'Check No.', width: 16 },
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
      { header: '2307 Attached (Y/N)', width: 16 },
      { header: 'Remarks', width: 22 },
    ],
    buildRow: (r, no) => [
      { value: no, align: 'center' },
      { value: r.bank || '', align: 'center' },
      { value: r.check_date ? new Date(r.check_date) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: r.created_at ? new Date(r.created_at) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: r.uploadedByName || '', align: 'center', fill: r.uploadedByName ? undefined : MANUAL_FILL_COLOR },
      { value: r.payee || '' },
      { value: r.check_no || '', align: 'center' },
      { value: r.payor || '' },
      { value: Number(r.amount || 0), numFmt: '#,##0.00', align: 'right' },
      { value: getClientName(r) },
      { value: releasedStatusLabel(r.status), align: 'center' },
      { value: r.collector_name || '', align: 'center', fill: r.collector_name ? undefined : MANUAL_FILL_COLOR },
      {
        value: r.pickup_reservations?.reserved_at ? new Date(r.pickup_reservations.reserved_at) : null,
        numFmt: 'mm/dd/yyyy',
        align: 'center',
        fill: r.pickup_reservations?.reserved_at ? undefined : MANUAL_FILL_COLOR,
      },
      { value: r.submitted_by_name || '', align: 'center', fill: r.submitted_by_name ? undefined : MANUAL_FILL_COLOR },
      {
        value: r.submitted_at ? new Date(r.submitted_at) : null,
        numFmt: 'mm/dd/yyyy',
        align: 'center',
        fill: r.submitted_at ? undefined : MANUAL_FILL_COLOR,
      },
      { value: r.approved_by_name || '', align: 'center', fill: r.approved_by_name ? undefined : MANUAL_FILL_COLOR },
      {
        value: r.approved_at ? new Date(r.approved_at) : null,
        numFmt: 'mm/dd/yyyy',
        align: 'center',
        fill: r.approved_at ? undefined : MANUAL_FILL_COLOR,
      },
      {
        value: r.picked_up_at ? new Date(r.picked_up_at) : null,
        numFmt: 'mm/dd/yyyy',
        align: 'center',
        fill: r.picked_up_at ? undefined : MANUAL_FILL_COLOR,
      },
      { value: daysBetween(r.created_at, r.picked_up_at) ?? '', align: 'center' },
      { value: r.or_no || '', align: 'center', fill: r.or_no ? undefined : MANUAL_FILL_COLOR },
      { value: arCollectedLabel(r.ar_collected), align: 'center', fill: r.ar_collected == null ? MANUAL_FILL_COLOR : undefined },
      { value: attached2307Label(r.attached_2307), align: 'center', fill: r.attached_2307 == null ? MANUAL_FILL_COLOR : undefined },
      { value: remarksLabel(r.status) },
    ],
  },

  unreleased: {
    category: 'unreleased',
    fileTag: 'unreleased-check-report',
    title: 'UNRELEASED CHECK REPORT',
    statusFilter: 'available',
    requiresPayor: false,
    showReleasedDateField: false,
    extraDateColumn: 'created_at',
    extraDateLabel: 'Date uploaded',
    showStaleness: true,
    cwtAttachedOnly: false,
    amountColIndex: 6,
    legendText: `Rows tagged "Stale (${STALE_FIXED_MONTHS}mo+)" are ${STALE_FIXED_MONTHS}+ months old measured from check date (fixed, not editable). Use "Generate BPI Transmittal" below to produce a bank-ready transmittal for those checks.`,
    columns: [
      { header: 'No', width: 6 },
      { header: 'Bank', width: 20 },
      { header: 'Payee Name', width: 26 },
      { header: 'Check No.', width: 16 },
      { header: 'Check Date', width: 14 },
      { header: 'Check Amount', width: 16 },
      { header: 'Client Name', width: 26 },
      { header: 'Date Uploaded', width: 14 },
      { header: 'Aging (Days)', width: 12 },
      { header: 'Aging Status', width: 16 },
    ],
    buildRow: (r, no) => {
      const stale = isStale(r.check_date)
      return [
        { value: no, align: 'center' },
        { value: r.bank || '', align: 'center' },
        { value: r.payee || '' },
        { value: r.check_no || '', align: 'center' },
        { value: r.check_date ? new Date(r.check_date) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
        { value: Number(r.amount || 0), numFmt: '#,##0.00', align: 'right' },
        { value: getClientName(r) },
        { value: r.created_at ? new Date(r.created_at) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
        { value: daysBetween(r.check_date, null) ?? '', align: 'center' },
        {
          value: stale ? `Stale (${STALE_FIXED_MONTHS}mo+)` : 'Current',
          align: 'center',
          fill: stale ? STALE_FILL_COLOR : undefined,
        },
      ]
    },
  },

  or_ar: {
    category: 'released',
    fileTag: 'or-ar-report',
    title: 'OR / AR REPORT',
    statusFilter: 'picked_up',
    requiresPayor: true,
    showReleasedDateField: true,
    extraDateColumn: null,
    extraDateLabel: null,
    showStaleness: false,
    cwtAttachedOnly: false,
    amountColIndex: 10,
    legendText: 'Highlighted cells are blank in the file — fill them in manually after export.',
    columns: [
      { header: 'No', width: 6 },
      { header: 'Bank', width: 20 },
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
      { header: 'Receipt', width: 14 },
      { header: 'AR Collected (Y/N)', width: 16 },
    ],
    buildRow: (r, no) => [
      { value: no, align: 'center' },
      { value: r.bank || '', align: 'center' },
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

  cwt_released: {
    category: 'released',
    fileTag: 'cwt-report-released',
    title: 'CWT REPORT — RELEASED',
    statusFilter: 'picked_up',
    requiresPayor: false,
    showReleasedDateField: false,
    extraDateColumn: 'picked_up_at',
    extraDateLabel: 'Released date',
    showStaleness: false,
    cwtAttachedOnly: true,
    amountColIndex: 7,
    legendText: 'Only checks with a 2307 on file are included in this report — checks without one are excluded automatically.',
    columns: [
      { header: 'NO', width: 6 },
      { header: 'Bank', width: 20 },
      { header: 'Check Date', width: 14 },
      { header: 'Date Uploaded', width: 14 },
      { header: 'Payee', width: 26 },
      { header: 'Check No.', width: 16 },
      { header: 'Check Amount', width: 16 },
      { header: 'Client Name', width: 26 },
      { header: 'Status', width: 14 },
      { header: 'Date Released', width: 14 },
      { header: '2307 (Y/N)', width: 14 },
    ],
    buildRow: (r, no) => [
      { value: no, align: 'center' },
      { value: r.bank || '', align: 'center' },
      { value: r.check_date ? new Date(r.check_date) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: r.created_at ? new Date(r.created_at) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: r.payee || '' },
      { value: r.check_no || '', align: 'center' },
      { value: Number(r.amount || 0), numFmt: '#,##0.00', align: 'right' },
      { value: getClientName(r) },
      { value: releasedUnreleasedLabel(r.status), align: 'center' },
      { value: r.picked_up_at ? new Date(r.picked_up_at) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: attached2307Label(r.attached_2307), align: 'center' },
    ],
  },

  cwt_unreleased: {
    category: 'unreleased',
    fileTag: 'cwt-report-unreleased',
    title: 'CWT REPORT — UNRELEASED',
    statusFilter: 'available',
    requiresPayor: false,
    showReleasedDateField: false,
    extraDateColumn: 'created_at',
    extraDateLabel: 'Date uploaded',
    showStaleness: false,
    cwtAttachedOnly: true,
    amountColIndex: 7,
    legendText: 'Only checks with a 2307 on file are included in this report — checks without one are excluded automatically.',
    columns: [
      { header: 'NO', width: 6 },
      { header: 'Bank', width: 20 },
      { header: 'Check Date', width: 14 },
      { header: 'Date Uploaded', width: 14 },
      { header: 'Payee', width: 26 },
      { header: 'Check No.', width: 16 },
      { header: 'Check Amount', width: 16 },
      { header: 'Client Name', width: 26 },
      { header: 'Status', width: 14 },
      { header: '2307 (Y/N)', width: 14 },
    ],
    buildRow: (r, no) => [
      { value: no, align: 'center' },
      { value: r.bank || '', align: 'center' },
      { value: r.check_date ? new Date(r.check_date) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: r.created_at ? new Date(r.created_at) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
      { value: r.payee || '' },
      { value: r.check_no || '', align: 'center' },
      { value: Number(r.amount || 0), numFmt: '#,##0.00', align: 'right' },
      { value: getClientName(r) },
      { value: releasedUnreleasedLabel(r.status), align: 'center' },
      { value: attached2307Label(r.attached_2307), align: 'center' },
    ],
  },
}

const REPORT_TYPE_LABELS = {
  released: 'Released check report',
  or_ar: 'OR / AR report',
  cwt_released: 'CWT report — released',
  unreleased: 'Unreleased checks (all / stale)',
  cwt_unreleased: 'CWT report — unreleased',
}

const REPORT_TYPE_GROUPS = [
  { label: 'Released Reports', options: ['released', 'or_ar', 'cwt_released'] },
  { label: 'Unreleased Reports', options: ['unreleased', 'cwt_unreleased'] },
]

const PAGE_SIZE_OPTIONS = [25, 50, 100]

function effectiveReportKey(reportType, includeAuditTrail) {
  return reportType === 'released' && includeAuditTrail ? 'released_audit' : reportType
}

async function fetchAllRows(buildQuery) {
  const PAGE = 1000
  let from = 0
  let all = []
  while (true) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1)
    if (error) throw error
    all = all.concat(data || [])
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  return all
}

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
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false)
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

function MultiSelectFilter({
  label,
  allLabel,
  icon: Icon = Users,
  options,
  selected,
  onChangeSelected,
  allSelected,
  onSelectAll,
  onClearAll,
  searchPlaceholder,
}) {
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
            <Icon className="h-3 w-3" />
            {allLabel}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onClearAll()
              }}
              className="text-teal-500 hover:text-teal-700"
              aria-label={`Clear ${label.toLowerCase()}`}
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
            placeholder={selected.length === 0 ? searchPlaceholder : ''}
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
                <Icon className="h-3.5 w-3.5" />
                {allLabel}
              </button>
            </li>
            {filtered.length === 0 && <li className="px-3 py-2 text-xs text-gray-400">No matching options.</li>}
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

function CategoryBadge({ category }) {
  const isReleased = category === 'released'
  return (
    <span
      className={
        'rounded-full px-2 py-0.5 text-xs font-medium ' +
        (isReleased ? 'bg-teal-50 text-teal-700' : 'bg-amber-50 text-amber-700')
      }
    >
      {isReleased ? 'Released' : 'Unreleased'}
    </span>
  )
}

const TABS = [
  { key: 'checks', label: 'Check Reports', icon: LayoutGrid },
  { key: 'billing', label: 'Billing Report', icon: Receipt },
  { key: 'summary', label: 'Summary Reports', icon: PieChart },
]

export default function AdminReports() {
  const [activeTab, setActiveTab] = useState('checks')

  return (
    <div className="w-full space-y-6 pb-12">
      <div className="px-1">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Reports</h1>
        <p className="text-sm text-gray-500">
          Build formatted check reports, a half-month billing breakdown, or a released / unreleased summary —
          preview any of them, then download as Excel or PDF.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-gray-200">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const active = activeTab === tab.key
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={
                'flex items-center gap-1.5 rounded-t-md px-4 py-2 text-sm font-medium transition-colors ' +
                (active ? 'border-b-2 border-teal-600 text-teal-700' : 'text-gray-500 hover:text-gray-700')
              }
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          )
        })}
      </div>

      {activeTab === 'checks' && <CheckReportsWizard />}
      {activeTab === 'billing' && <BillingReport />}
      {activeTab === 'summary' && <SummaryReports />}
    </div>
  )
}

const CHECK_SELECT_COLUMNS =
  'id, check_no, check_date, bank, payee, payor, amount, status, picked_up_by, picked_up_at, created_at, ' +
  'or_no, ar_collected, attached_2307, collector_name, submitted_by_name, submitted_at, approved_by_name, ' +
  'approved_at, reservation_id, pickup_reservations(reserved_at, collector_name), upload_batches(uploaded_by)'

function CheckReportsWizard() {
  const [step, setStep] = useState('form')

  const [reportType, setReportType] = useState('released')
  const [includeAuditTrail, setIncludeAuditTrail] = useState(false)
  const [stalenessFilter, setStalenessFilter] = useState('all')
  const [extraDateFrom, setExtraDateFrom] = useState('')
  const [extraDateTo, setExtraDateTo] = useState('')
  const [reportPayees, setReportPayees] = useState([])
  const [reportPayeeAll, setReportPayeeAll] = useState(false)
  const [reportBanks, setReportBanks] = useState([])
  const [reportBankAll, setReportBankAll] = useState(true)
  const [reportPayor, setReportPayor] = useState('')
  const [releasedDate, setReleasedDate] = useState('')
  const [reportDateFrom, setReportDateFrom] = useState('')
  const [reportDateTo, setReportDateTo] = useState('')
  const [formError, setFormError] = useState('')
  const [payeeOptions, setPayeeOptions] = useState([])
  const [payorOptions, setPayorOptions] = useState([])
  const [bankOptions, setBankOptions] = useState([])

  const [rawRows, setRawRows] = useState([])
  const [previewMeta, setPreviewMeta] = useState(null)
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [downloadingPdf, setDownloadingPdf] = useState(false)

  const [searchTerm, setSearchTerm] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const [pdfState, setPdfState] = useState({ open: false, url: '', generating: false })
  const [transmittalState, setTransmittalState] = useState({
    open: false,
    url: '',
    generating: false,
    transmittalNumber: '',
    staleCount: 0,
  })

  const { push } = useToast()

  const activeFormConfig = REPORT_CONFIG[effectiveReportKey(reportType, includeAuditTrail)]

  useEffect(() => {
    loadDistinctNames()
  }, [])

  useEffect(() => {
    return () => {
      if (pdfState.url) URL.revokeObjectURL(pdfState.url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfState.url])

  useEffect(() => {
    return () => {
      if (transmittalState.url) URL.revokeObjectURL(transmittalState.url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transmittalState.url])

  async function loadDistinctNames() {
    try {
      const data = await fetchAllRows(() => supabase.from('checks').select('payee, payor, bank'))
      setPayeeOptions([...new Set((data || []).map((r) => r.payee).filter(Boolean))].sort())
      setPayorOptions([...new Set((data || []).map((r) => r.payor).filter(Boolean))].sort())
      setBankOptions([...new Set((data || []).map((r) => r.bank).filter(Boolean))].sort())
    } catch {
      // suggestions only
    }
  }

  async function fetchAllChecks({
    payees,
    payeeAll,
    payor,
    banks,
    bankAll,
    statusFilter,
    dateFrom,
    dateTo,
    extraDateColumn,
    extraFrom,
    extraTo,
    staleFilter,
    cwtAttachedOnly,
  }) {
    const PAGE = 1000
    let from = 0
    let all = []
    while (true) {
      let req = supabase
        .from('checks')
        .select(CHECK_SELECT_COLUMNS)
        .eq('status', statusFilter)
        .order('check_date', { ascending: true })
        .range(from, from + PAGE - 1)

      if (!payeeAll && payees.length > 0) req = req.in('payee', payees)
      if (payor && payor.trim()) req = req.ilike('payor', `%${payor.trim()}%`)
      if (!bankAll && banks.length > 0) req = req.in('bank', banks)
      if (dateFrom) req = req.gte('check_date', dateFrom)
      if (dateTo) req = req.lte('check_date', dateTo)
      if (extraDateColumn && extraFrom) req = req.gte(extraDateColumn, `${extraFrom}T00:00:00`)
      if (extraDateColumn && extraTo) req = req.lte(extraDateColumn, `${extraTo}T23:59:59`)
      if (staleFilter === 'stale') req = req.lte('check_date', monthsAgoDateInputValue(STALE_FIXED_MONTHS))
      if (staleFilter === 'fresh') req = req.gt('check_date', monthsAgoDateInputValue(STALE_FIXED_MONTHS))

      const { data, error } = await req
      if (error) throw error

      all = all.concat(data || [])
      if (!data || data.length < PAGE) break
      from += PAGE
    }

    const uploaderIds = [...new Set(all.map((r) => r.upload_batches?.uploaded_by).filter(Boolean))]
    let uploaderNameById = new Map()
    if (uploaderIds.length > 0) {
      const { data: profileRows, error: profileError } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', uploaderIds)
      if (!profileError) {
        uploaderNameById = new Map((profileRows || []).map((p) => [p.id, p.full_name || '']))
      }
    }

    const checkIds = all.map((r) => r.id)
    const activityByCheckId = new Map()
    const LOG_BATCH = 200
    for (let i = 0; i < checkIds.length; i += LOG_BATCH) {
      const batchIds = checkIds.slice(i, i + LOG_BATCH)
      if (batchIds.length === 0) continue
      const { data: logRows, error: logError } = await supabase
        .from('check_activity_log')
        .select('check_id, action, performed_at, submitted_by_name, approved_by_name, or_no, ar_collected, attached_2307')
        .in('check_id', batchIds)
        .in('action', ['submitted_for_approval', 'approved', 'released', 'picked_up'])
        .order('performed_at', { ascending: true })
      if (logError) continue
      for (const log of logRows || []) {
        const entry = activityByCheckId.get(log.check_id) || {}
        if (log.action === 'submitted_for_approval') {
          entry.submittedAt = log.performed_at
          entry.submittedByName = log.submitted_by_name || entry.submittedByName
        } else if (log.action === 'approved') {
          entry.approvedAt = log.performed_at
          entry.approvedByName = log.approved_by_name || entry.approvedByName
        } else if (log.action === 'released' || log.action === 'picked_up') {
          entry.releasedAt = log.performed_at
          if (log.or_no) entry.orNo = log.or_no
          if (log.ar_collected != null) entry.arCollected = log.ar_collected
          if (log.attached_2307 != null) entry.attached2307 = log.attached_2307
        }
        activityByCheckId.set(log.check_id, entry)
      }
    }

    const merged = all.map((r) => {
      const activity = activityByCheckId.get(r.id) || {}
      return {
        ...r,
        collector_name: r.collector_name || r.pickup_reservations?.collector_name || '',
        uploadedByName: uploaderNameById.get(r.upload_batches?.uploaded_by) || '',
        submitted_at: r.submitted_at || activity.submittedAt || null,
        submitted_by_name: r.submitted_by_name || activity.submittedByName || '',
        approved_at: r.approved_at || activity.approvedAt || null,
        approved_by_name: r.approved_by_name || activity.approvedByName || '',
        picked_up_at: r.picked_up_at || activity.releasedAt || null,
        or_no: r.or_no || activity.orNo || '',
        ar_collected: r.ar_collected != null ? r.ar_collected : activity.arCollected != null ? activity.arCollected : null,
        attached_2307:
          r.attached_2307 != null ? r.attached_2307 : activity.attached2307 != null ? activity.attached2307 : null,
      }
    })

    // CWT reports only ever include checks that actually have a 2307 on file.
    // Checks without one (attached_2307 is not exactly true) are dropped here
    // so they never appear in a CWT report, released or unreleased.
    return cwtAttachedOnly ? merged.filter((r) => r.attached_2307 === true) : merged
  }

  function validateForm() {
    const configKey = effectiveReportKey(reportType, includeAuditTrail)
    const config = REPORT_CONFIG[configKey]
    if (config.requiresPayor && !reportPayor.trim()) {
      return 'Please enter a payor.'
    }
    if (!reportPayeeAll && reportPayees.length === 0) {
      return `Please select at least one payee, or choose "${ALL_PAYEES_LABEL}".`
    }
    if (!reportBankAll && reportBanks.length === 0) {
      return `Please select at least one bank, or choose "${ALL_BANKS_LABEL}".`
    }
    if (config.showReleasedDateField) {
      if (!releasedDate) return 'Please select a released date.'
      if (releasedDate > todayDateInputValue()) return 'Released date cannot be in the future.'
    }
    if (reportDateFrom && reportDateTo && reportDateFrom > reportDateTo) {
      return 'The check date "from" must be before the check date "to".'
    }
    if (config.extraDateColumn && extraDateFrom && extraDateTo && extraDateFrom > extraDateTo) {
      return `The ${config.extraDateLabel.toLowerCase()} "from" must be before the "to".`
    }
    return ''
  }

  function handleReportTypeChange(e) {
    const value = e.target.value
    setReportType(value)
    if (value !== 'released') setIncludeAuditTrail(false)
    if (value !== 'unreleased') setStalenessFilter('all')
    setExtraDateFrom('')
    setExtraDateTo('')
    setFormError('')
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
        banks: reportBanks,
        bankAll: reportBankAll,
        statusFilter: config.statusFilter,
        dateFrom: reportDateFrom,
        dateTo: reportDateTo,
        extraDateColumn: config.extraDateColumn,
        extraFrom: config.extraDateColumn ? extraDateFrom : '',
        extraTo: config.extraDateColumn ? extraDateTo : '',
        staleFilter: config.showStaleness ? stalenessFilter : 'all',
        cwtAttachedOnly: !!config.cwtAttachedOnly,
      })

      if (rows.length === 0) {
        setFormError(
          config.cwtAttachedOnly
            ? 'No matching checks with a 2307 on file were found for that filter combination.'
            : 'No matching checks found for that filter combination.'
        )
        return
      }

      setRawRows(rows)
      setPreviewMeta({
        reportType,
        configKey,
        includeAuditTrail: configKey === 'released_audit',
        payees: reportPayeeAll ? [] : reportPayees,
        payeeAll: reportPayeeAll,
        banks: reportBankAll ? [] : reportBanks,
        bankAll: reportBankAll,
        payor: reportPayor.trim(),
        releasedDate,
        dateFrom: reportDateFrom,
        dateTo: reportDateTo,
        extraDateColumn: config.extraDateColumn,
        extraDateLabel: config.extraDateLabel,
        extraDateFrom: config.extraDateColumn ? extraDateFrom : '',
        extraDateTo: config.extraDateColumn ? extraDateTo : '',
        stalenessFilter: config.showStaleness ? stalenessFilter : 'all',
      })
      setSearchTerm('')
      setPage(1)
      setStep('preview')
    } catch (err) {
      setFormError(friendlyError(err))
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
        banks: previewMeta.banks,
        bankAll: previewMeta.bankAll,
        statusFilter: config.statusFilter,
        dateFrom: previewMeta.dateFrom,
        dateTo: previewMeta.dateTo,
        extraDateColumn: previewMeta.extraDateColumn,
        extraFrom: previewMeta.extraDateFrom,
        extraTo: previewMeta.extraDateTo,
        staleFilter: previewMeta.stalenessFilter,
        cwtAttachedOnly: !!config.cwtAttachedOnly,
      })
      setRawRows(rows)
      setPage(1)
      push?.({ variant: 'success', title: 'Preview refreshed', description: `${rows.length} record${rows.length === 1 ? '' : 's'} loaded.` })
    } catch (err) {
      setFetchError(friendlyError(err))
    } finally {
      setFetching(false)
    }
  }

  function handleBackToFilters() {
    setStep('form')
    setFetchError('')
  }

  function addHeaderRow(sheet, rowNum, colCount, text, style = {}, startCol = 1) {
    sheet.mergeCells(rowNum, startCol, rowNum, colCount)
    const cell = sheet.getRow(rowNum).getCell(startCol)
    cell.value = text
    cell.font = { bold: !!style.bold, size: style.size || 11, color: style.color ? { argb: style.color } : undefined }
    cell.alignment = { vertical: 'middle', horizontal: style.align || 'left' }
    sheet.getRow(rowNum).height = style.height || 18
  }

  function buildHeaderLines(configKey, { payeeDisplay, bankDisplay, payor, releasedDateValue, dateFrom, dateTo, extraDateLabel, extraDateFrom, extraDateTo }) {
    const config = REPORT_CONFIG[configKey]
    const lines = [{ text: `Client Name: ${payor || '—'}`, size: 11, bold: true }]
    lines.push({ text: `Payee: ${payeeDisplay || '—'}`, size: 10 })
    lines.push({ text: `Bank: ${bankDisplay || '—'}`, size: 10 })
    lines.push({ text: `Report Date: ${formatExcelDateLabel(new Date())}`, size: 10 })
    if (dateFrom || dateTo) {
      const fromLabel = dateFrom ? formatExcelDateLabel(new Date(dateFrom)) : '—'
      const toLabel = dateTo ? formatExcelDateLabel(new Date(dateTo)) : '—'
      lines.push({ text: `Check Date Range: ${fromLabel} to ${toLabel}`, size: 10 })
    }
    if (extraDateLabel && (extraDateFrom || extraDateTo)) {
      const fromLabel = extraDateFrom ? formatExcelDateLabel(new Date(extraDateFrom)) : '—'
      const toLabel = extraDateTo ? formatExcelDateLabel(new Date(extraDateTo)) : '—'
      lines.push({ text: `${extraDateLabel} Range: ${fromLabel} to ${toLabel}`, size: 10 })
    }
    if (config.showReleasedDateField) {
      const releasedLabel = releasedDateValue ? formatExcelDateLabel(new Date(releasedDateValue)) : '—'
      lines.push({ text: `Released Date: ${releasedLabel}`, size: 10 })
    }
    return lines
  }

  async function buildWorkbook(configKey, rows, headerArgs, bankBreakdown = []) {
    const config = REPORT_CONFIG[configKey]
    const colCount = config.columns.length
    const logo = await loadLogoAssets()

    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'Check Disbursement System'
    workbook.created = new Date()

    const sheet = workbook.addWorksheet(config.title.slice(0, 31), {
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
      views: [{ showGridLines: false }],
    })

    sheet.columns = config.columns.map((c) => ({ width: c.width }))

    // Letterhead logo is anchored to the top-right corner of the sheet so it
    // never sits on top of the left-aligned company name / report details,
    // regardless of how narrow the first column is for a given report.
    const logoBox = logo ? fitToHeight(logo, 46, 110) : null
    if (logo?.arrayBuffer && logoBox) {
      try {
        const imageId = workbook.addImage({ buffer: logo.arrayBuffer, extension: 'png' })
        const anchor = computeRightAlignedImageAnchor(config.columns, logoBox.width)
        sheet.addImage(imageId, { tl: anchor, ext: { width: logoBox.width, height: logoBox.height } })
      } catch (err) {
        console.warn('Could not embed logo into workbook:', err)
      }
    }

    const headerStartCol = 1
    let r = 1

    addHeaderRow(sheet, r, colCount, `Company Name: ${headerArgs.payor || '—'}`, { bold: true, size: 14 }, headerStartCol)
    r++
    addHeaderRow(sheet, r, colCount, config.title, { bold: true, size: 13, color: HEADER_FILL_COLOR }, headerStartCol)
    r++

    for (const line of buildHeaderLines(configKey, headerArgs)) {
      addHeaderRow(sheet, r, colCount, line.text, { bold: line.bold, size: line.size }, headerStartCol)
      r++
    }

    if (configKey === 'unreleased' && bankBreakdown.length > 0) {
      r++
      addHeaderRow(
        sheet,
        r,
        colCount,
        `STALE CHECKS BY BANK (${STALE_FIXED_MONTHS}MO+, FOR TRANSMITTAL)`,
        { bold: true, size: 10, color: HEADER_FILL_COLOR },
        headerStartCol
      )
      r++
      for (const b of bankBreakdown) {
        addHeaderRow(
          sheet,
          r,
          colCount,
          `${b.bank}: ${b.count} check${b.count === 1 ? '' : 's'} — ${formatCurrency(b.totalAmount)}`,
          { size: 9 },
          headerStartCol
        )
        r++
      }
    }

    const rowsUsedSoFar = r - 1
    const logoRowSpan = logoBox ? Math.ceil(logoBox.height / 18) + 1 : 0
    r += Math.max(1, logoRowSpan - rowsUsedSoFar)

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
        if (val.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: val.fill } }
      })
      total += Number(row.amount || 0)
      r++
    })

    const totalRow = sheet.getRow(r)
    for (let c = 1; c <= colCount; c++) totalRow.getCell(c).border = thinBorder()
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

    sheet.views = [{ state: 'frozen', ySplit: headerRowIndex }]

    return workbook
  }

  async function buildPdfDocument(configKey, rows, headerArgs, bankBreakdown = []) {
    const config = REPORT_CONFIG[configKey]
    const logo = await loadLogoAssets()
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
    const margin = 32
    const pageWidth = doc.internal.pageSize.getWidth()

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(14)
    doc.setTextColor(20, 20, 20)
    doc.text(`Company Name: ${headerArgs.payor || '—'}`, margin, 40)

    doc.setFontSize(13)
    doc.setTextColor(...BRAND_TEAL_RGB)
    doc.text(config.title, margin, 60)

    if (logo?.dataUrl) {
      try {
        const { width: logoW, height: logoH } = fitToHeight(logo, 48, 110)
        doc.addImage(logo.dataUrl, 'PNG', pageWidth - margin - logoW, 16, logoW, logoH)
      } catch (err) {
        console.warn('Could not embed logo into PDF:', err)
      }
    }

    let y = 78
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(60, 60, 60)
    for (const line of buildHeaderLines(configKey, headerArgs)) {
      if (line.bold) doc.setFont('helvetica', 'bold')
      doc.text(line.text, margin, y)
      if (line.bold) doc.setFont('helvetica', 'normal')
      y += 14
    }

    if (configKey === 'unreleased' && bankBreakdown.length > 0) {
      y += 6
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9)
      doc.setTextColor(...BRAND_TEAL_RGB)
      doc.text(`STALE CHECKS BY BANK (${STALE_FIXED_MONTHS}MO+, FOR TRANSMITTAL)`, margin, y)
      y += 13
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.setTextColor(60, 60, 60)
      for (const b of bankBreakdown) {
        doc.text(`${b.bank}: ${b.count} check${b.count === 1 ? '' : 's'} — ${formatCurrency(b.totalAmount)}`, margin, y)
        y += 12
      }
      y += 2
    }

    const head = [config.columns.map((c) => c.header)]
    let total = 0
    const body = rows.map((row, idx) => {
      const cells = config.buildRow(row, idx + 1)
      total += Number(row.amount || 0)
      return cells.map((cell) => formatCellDisplay(cell) || '')
    })
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

  async function buildTransmittalPdf(transmittalNumber, staleRows, { payorLabel }) {
    const logo = await loadLogoAssets()
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' })
    const margin = 40
    const pageWidth = doc.internal.pageSize.getWidth()
    const pageHeight = doc.internal.pageSize.getHeight()

    const byBank = new Map()
    for (const r of staleRows) {
      const bank = r.bank || 'Unspecified'
      if (!byBank.has(bank)) byBank.set(bank, [])
      byBank.get(bank).push(r)
    }
    const bankEntries = [...byBank.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    const grandTotalAmount = staleRows.reduce((sum, r) => sum + Number(r.amount || 0), 0)
    const bankLogoByName = new Map(await Promise.all(bankEntries.map(async ([bank]) => [bank, await loadBankLogoAsset(bank)])))

    const logoBox = logo ? fitToHeight(logo, 52, 130) : null
    if (logo?.dataUrl && logoBox) {
      try {
        doc.addImage(logo.dataUrl, 'PNG', margin, 28, logoBox.width, logoBox.height)
      } catch (err) {
        console.warn('Could not embed logo into transmittal:', err)
      }
    }
    const textX = margin + (logoBox ? logoBox.width + 16 : 0)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(14)
    doc.setTextColor(20, 20, 20)
    doc.text('CREDIT SOLUTIONS & BUSINESS ALLIANCES, INC.', textX, 46, { maxWidth: pageWidth - margin - textX })

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(90, 90, 90)
    doc.text('Check Transmittal — Stale / Unreleased Checks Return to Bank', textX, 62, { maxWidth: pageWidth - margin - textX })

    let y = Math.max(28 + (logoBox?.height || 0) + 16, 90)
    doc.setDrawColor(...BRAND_TEAL_RGB)
    doc.setLineWidth(1)
    doc.line(margin, y, pageWidth - margin, y)
    y += 20

    const banksLabel = bankEntries.map(([bank]) => bank).join(', ') || 'None'

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(20, 20, 20)
    doc.text(`Transmittal No: ${transmittalNumber}`, margin, y)
    doc.text(
      `Date Generated: ${formatExcelDateLabel(new Date())}, ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
      margin,
      y + 16
    )

    doc.setFont('helvetica', 'normal')
    doc.text(`Client / Payor: ${payorLabel || 'Multiple / All Clients'}`, margin, y + 32, { maxWidth: pageWidth - margin * 2 })
    doc.text(`Banks Included: ${banksLabel}`, margin, y + 48, { maxWidth: pageWidth - margin * 2 })
    doc.text(
      `Total Checks: ${staleRows.length}  ·  Grand Total: PHP ${grandTotalAmount.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}  ·  Aging threshold: ${STALE_FIXED_MONTHS}+ months from check date (fixed)`,
      margin,
      y + 64,
      { maxWidth: pageWidth - margin * 2 }
    )

    y += 88

    let grandTotal = 0
    for (const [bank, rowsForBank] of bankEntries) {
      const bankLogo = bankLogoByName.get(bank)
      const bankLogoBox = bankLogo ? fitToHeight(bankLogo, 24, 70) : null

      if (y > pageHeight - 170) {
        doc.addPage()
        y = 40
      }

      let bankTextX = margin
      if (bankLogo?.dataUrl && bankLogoBox) {
        try {
          doc.addImage(bankLogo.dataUrl, 'PNG', margin, y - bankLogoBox.height + 4, bankLogoBox.width, bankLogoBox.height)
          bankTextX = margin + bankLogoBox.width + 8
        } catch (err) {
          console.warn(`Could not embed logo for bank "${bank}":`, err)
        }
      }

      doc.setFont('helvetica', 'bold')
      doc.setFontSize(11)
      doc.setTextColor(...BRAND_TEAL_RGB)
      doc.text(`RETURN TO: ${bank.toUpperCase()}`, bankTextX, y)
      y += 18

      const head = [['No', 'Check No.', 'Payee', 'Client Name', 'Check Date', 'Aging (Days)', 'Amount']]
      let bankTotal = 0
      const body = rowsForBank.map((r, i) => {
        bankTotal += Number(r.amount || 0)
        return [
          String(i + 1),
          r.check_no || '',
          r.payee || '',
          getClientName(r),
          r.check_date ? new Date(r.check_date).toLocaleDateString('en-US') : '',
          String(daysBetween(r.check_date, null) ?? ''),
          Number(r.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        ]
      })
      body.push(['', '', '', '', '', 'Subtotal', bankTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })])
      grandTotal += bankTotal
      const subtotalRowIndex = body.length - 1

      autoTable(doc, {
        head,
        body,
        startY: y + 6,
        margin: { left: margin, right: margin },
        styles: { fontSize: 8, cellPadding: 4, textColor: [55, 65, 81], lineColor: [209, 213, 219], lineWidth: 0.5 },
        headStyles: { fillColor: BRAND_TEAL_RGB, textColor: 255, fontStyle: 'bold', halign: 'center' },
        columnStyles: { 6: { halign: 'right' } },
        didParseCell: (data) => {
          if (data.row.section === 'body' && data.row.index === subtotalRowIndex) data.cell.styles.fontStyle = 'bold'
        },
      })
      y = doc.lastAutoTable.finalY + 24
    }

    if (y > pageHeight - 130) {
      doc.addPage()
      y = 60
    }

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(20, 20, 20)
    doc.text(
      `GRAND TOTAL: ${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      pageWidth - margin - 230,
      y
    )
    y += 46

    doc.setDrawColor(120, 120, 120)
    doc.setLineWidth(0.75)
    const sigY = Math.min(Math.max(y, pageHeight - 90), pageHeight - 60)
    doc.line(margin, sigY, margin + 190, sigY)
    doc.line(pageWidth - margin - 190, sigY, pageWidth - margin, sigY)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(60, 60, 60)
    doc.text('Prepared by / Signature over printed name', margin, sigY + 13)
    doc.text('Received by (Bank Representative)', pageWidth - margin - 190, sigY + 13)

    const pageCount = doc.internal.getNumberOfPages()
    for (let p = 1; p <= pageCount; p++) {
      doc.setPage(p)
      doc.setFontSize(8)
      doc.setTextColor(150, 150, 150)
      doc.text(`Transmittal ${transmittalNumber} · Page ${p} of ${pageCount}`, margin, pageHeight - 20)
    }

    return doc
  }

  function reportMetaArgs() {
    return {
      payeeDisplay: formatMultiSelectDisplay(previewMeta.payeeAll, previewMeta.payees, ALL_PAYEES_LABEL),
      bankDisplay: formatMultiSelectDisplay(previewMeta.bankAll, previewMeta.banks, ALL_BANKS_LABEL),
      payor: previewMeta.payor,
      releasedDateValue: previewMeta.releasedDate,
      dateFrom: previewMeta.dateFrom,
      dateTo: previewMeta.dateTo,
      extraDateLabel: previewMeta.extraDateLabel,
      extraDateFrom: previewMeta.extraDateFrom,
      extraDateTo: previewMeta.extraDateTo,
    }
  }

  function reportFilename(config) {
    const stamp = new Date().toISOString().slice(0, 10)
    const safePayor = (previewMeta.payor || 'all-clients').replace(/[^a-z0-9]+/gi, '_')
    const payeeTag = multiSelectFileTag(previewMeta.payeeAll, previewMeta.payees, 'all-payees')
    const bankTag = multiSelectFileTag(previewMeta.bankAll, previewMeta.banks, 'all-banks')
    return `${config.fileTag}-${safePayor}-${payeeTag}-${bankTag}-${stamp}`
  }

  async function handleDownload() {
    if (!previewMeta || rawRows.length === 0) return
    setDownloading(true)
    try {
      const config = REPORT_CONFIG[previewMeta.configKey]
      const workbook = await buildWorkbook(
        previewMeta.configKey,
        rawRows,
        reportMetaArgs(),
        previewMeta.reportType === 'unreleased' ? staleBankBreakdown : []
      )

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${reportFilename(config)}.xlsx`
      a.click()
      URL.revokeObjectURL(url)

      push?.({
        variant: 'success',
        title: 'Report downloaded',
        description: `${rawRows.length} check${rawRows.length === 1 ? '' : 's'} included in the ${config.title.toLowerCase()}.`,
      })
      logAuditEvent('report_generated', {
        format: 'xlsx',
        report_type: previewMeta.configKey,
        row_count: rawRows.length,
        payor: previewMeta.payor || null,
        bank_filter: previewMeta.bankAll ? 'all' : previewMeta.banks,
      }).catch(() => {})
    } catch (err) {
      push?.({ variant: 'error', title: 'Download failed', description: friendlyError(err) })
    } finally {
      setDownloading(false)
    }
  }

  async function handlePreviewPdf() {
    if (!previewMeta || rawRows.length === 0) return
    setPdfState((s) => ({ ...s, generating: true }))
    try {
      const doc = await buildPdfDocument(
        previewMeta.configKey,
        rawRows,
        reportMetaArgs(),
        previewMeta.reportType === 'unreleased' ? staleBankBreakdown : []
      )
      const blobUrl = doc.output('bloburl')
      setPdfState((s) => {
        if (s.url) URL.revokeObjectURL(s.url)
        return { open: true, url: blobUrl, generating: false }
      })
    } catch (err) {
      push?.({ variant: 'error', title: 'PDF preview failed', description: friendlyError(err) })
      setPdfState((s) => ({ ...s, generating: false }))
    }
  }

  function closePdfPreview() {
    setPdfState((s) => {
      if (s.url) URL.revokeObjectURL(s.url)
      return { open: false, url: '', generating: false }
    })
  }

  async function handleDownloadPdf() {
    if (!previewMeta || rawRows.length === 0) return
    setDownloadingPdf(true)
    try {
      const config = REPORT_CONFIG[previewMeta.configKey]
      const doc = await buildPdfDocument(
        previewMeta.configKey,
        rawRows,
        reportMetaArgs(),
        previewMeta.reportType === 'unreleased' ? staleBankBreakdown : []
      )
      doc.save(`${reportFilename(config)}.pdf`)
      logAuditEvent('report_generated', {
        format: 'pdf',
        report_type: previewMeta.configKey,
        row_count: rawRows.length,
        payor: previewMeta.payor || null,
        bank_filter: previewMeta.bankAll ? 'all' : previewMeta.banks,
      }).catch(() => {})
    } catch (err) {
      push?.({ variant: 'error', title: 'PDF download failed', description: friendlyError(err) })
    } finally {
      setDownloadingPdf(false)
    }
  }

  async function handleGenerateTransmittal() {
    if (!previewMeta || previewMeta.reportType !== 'unreleased') return
    const staleRows = rawRows.filter((r) => isStale(r.check_date))
    if (staleRows.length === 0) {
      push?.({
        variant: 'error',
        title: 'No stale checks in this preview',
        description: `None of the loaded checks are ${STALE_FIXED_MONTHS}+ months aged from check date. Try the "Stale" or "All checks" aging filter.`,
      })
      return
    }
    setTransmittalState((s) => ({ ...s, generating: true }))
    try {
      const bankLabel = formatMultiSelectDisplay(previewMeta.bankAll, previewMeta.banks, ALL_BANKS_LABEL)
      const transmittalNumber = generateTransmittalNumber(bankLabel)
      const doc = await buildTransmittalPdf(transmittalNumber, staleRows, { payorLabel: previewMeta.payor })
      const blobUrl = doc.output('bloburl')
      setTransmittalState((s) => {
        if (s.url) URL.revokeObjectURL(s.url)
        return { open: true, url: blobUrl, generating: false, transmittalNumber, staleCount: staleRows.length }
      })
      logAuditEvent('transmittal_generated', {
        transmittal_no: transmittalNumber,
        check_count: staleRows.length,
        total_amount: staleRows.reduce((sum, r) => sum + Number(r.amount || 0), 0),
        payor: previewMeta.payor || null,
        banks: [...new Set(staleRows.map((r) => r.bank).filter(Boolean))],
        aging_threshold_months: STALE_FIXED_MONTHS,
      }).catch(() => {})
    } catch (err) {
      push?.({ variant: 'error', title: 'Transmittal generation failed', description: friendlyError(err) })
      setTransmittalState((s) => ({ ...s, generating: false }))
    }
  }

  function handleDownloadTransmittal() {
    if (!transmittalState.url || !transmittalState.transmittalNumber) return
    const a = document.createElement('a')
    a.href = transmittalState.url
    a.download = `bpi-transmittal-${transmittalState.transmittalNumber}.pdf`
    a.click()
  }

  function closeTransmittalPreview() {
    setTransmittalState((s) => {
      if (s.url) URL.revokeObjectURL(s.url)
      return { open: false, url: '', generating: false, transmittalNumber: '', staleCount: 0 }
    })
  }

  const activeConfig = previewMeta ? REPORT_CONFIG[previewMeta.configKey] : null

  const numberedRows = useMemo(() => rawRows.map((row, i) => ({ no: i + 1, row })), [rawRows])

  const filteredRows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) return numberedRows
    return numberedRows.filter(({ row }) =>
      [row.payee, row.payor, row.check_no, row.bank].some((v) => String(v || '').toLowerCase().includes(term))
    )
  }, [numberedRows, searchTerm])

  const totalAmount = useMemo(() => rawRows.reduce((sum, row) => sum + Number(row.amount || 0), 0), [rawRows])

  const banksInResults = useMemo(() => [...new Set(rawRows.map((r) => r.bank).filter(Boolean))].sort(), [rawRows])

  const staleRowCount = useMemo(() => rawRows.filter((r) => isStale(r.check_date)).length, [rawRows])

  const staleBankBreakdown = useMemo(() => {
    const map = new Map()
    for (const row of rawRows) {
      if (!isStale(row.check_date)) continue
      const bank = row.bank || 'Unspecified'
      const entry = map.get(bank) || { bank, count: 0, totalAmount: 0 }
      entry.count += 1
      entry.totalAmount += Number(row.amount || 0)
      map.set(bank, entry)
    }
    return [...map.values()].sort((a, b) => b.totalAmount - a.totalAmount)
  }, [rawRows])

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
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-sm">
        <StepBadge active={step === 'form'} done={step === 'preview'} label="1. Configure" />
        <div className="h-px flex-1 bg-gray-200" />
        <StepBadge active={step === 'preview'} done={false} label="2. Preview & download" />
      </div>

      {step === 'form' && (
        <Card className="border-gray-100 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              Report filters
              <CategoryBadge category={activeFormConfig.category} />
            </CardTitle>
            <CardDescription>Choose a report type, then enter the bank, payee(s), and payor to include.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Report type</label>
                <Select value={reportType} onChange={handleReportTypeChange}>
                  {REPORT_TYPE_GROUPS.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map((value) => (
                        <option key={value} value={value}>{REPORT_TYPE_LABELS[value]}</option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </div>

              {activeFormConfig.showReleasedDateField && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-500">Released date</label>
                  <Input type="date" value={releasedDate} max={todayDateInputValue()} onChange={(e) => setReleasedDate(e.target.value)} />
                </div>
              )}
            </div>

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

            {activeFormConfig.cwtAttachedOnly && (
              <p className="flex items-start gap-1.5 rounded-md border border-teal-100 bg-teal-50/60 px-3 py-2 text-xs text-teal-800">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                CWT reports only include checks that already have a 2307 on file. Checks without one are left out automatically.
              </p>
            )}

            {activeFormConfig.showStaleness && (
              <div className="space-y-3 rounded-md border border-gray-200 bg-gray-50/60 px-3 py-3">
                <div>
                  <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-gray-500">
                    <Layers className="h-3.5 w-3.5" /> Aging status
                  </label>
                  <div className="inline-flex rounded-md border border-gray-200 bg-white p-0.5">
                    {[
                      { value: 'all', label: 'All checks' },
                      { value: 'fresh', label: 'Not yet stale' },
                      { value: 'stale', label: `Stale (${STALE_FIXED_MONTHS}mo+)` },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setStalenessFilter(opt.value)}
                        className={
                          'rounded px-3 py-1.5 text-xs font-medium transition-colors ' +
                          (stalenessFilter === opt.value ? 'bg-teal-600 text-white' : 'text-gray-600 hover:bg-gray-100')
                        }
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-xs text-gray-500">
                    Staleness is measured from the check date and fixed at {STALE_FIXED_MONTHS} months — this
                    threshold cannot be changed.
                  </p>
                </div>
              </div>
            )}

            {activeFormConfig.extraDateColumn && (
              <div className="grid gap-4 rounded-md border border-gray-200 bg-gray-50/60 px-3 py-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500">
                    <CalendarRange className="h-3.5 w-3.5" /> {activeFormConfig.extraDateLabel} from
                  </label>
                  <Input type="date" value={extraDateFrom} onChange={(e) => setExtraDateFrom(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500">
                    <CalendarRange className="h-3.5 w-3.5" /> {activeFormConfig.extraDateLabel} to
                  </label>
                  <Input type="date" value={extraDateTo} onChange={(e) => setExtraDateTo(e.target.value)} />
                </div>
              </div>
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

            <div className="grid gap-4 sm:grid-cols-3">
              <MultiSelectFilter
                label="Bank(s)"
                allLabel={ALL_BANKS_LABEL}
                icon={Landmark}
                options={bankOptions}
                selected={reportBanks}
                onChangeSelected={setReportBanks}
                allSelected={reportBankAll}
                onSelectAll={() => {
                  setReportBankAll(true)
                  setReportBanks([])
                }}
                onClearAll={() => setReportBankAll(false)}
                searchPlaceholder="Search or select banks…"
              />

              <MultiSelectFilter
                label="Payee(s)"
                allLabel={ALL_PAYEES_LABEL}
                icon={Users}
                options={payeeOptions}
                selected={reportPayees}
                onChangeSelected={setReportPayees}
                allSelected={reportPayeeAll}
                onSelectAll={() => {
                  setReportPayeeAll(true)
                  setReportPayees([])
                }}
                onClearAll={() => setReportPayeeAll(false)}
                searchPlaceholder="Search or select payees…"
              />

              <NameCombobox
                label={activeFormConfig.requiresPayor ? 'Payor' : 'Payor (optional)'}
                value={reportPayor}
                onChange={setReportPayor}
                onSelectOption={setReportPayor}
                options={payorOptions}
                placeholder={activeFormConfig.requiresPayor ? 'Enter payor' : 'Leave blank to include all clients'}
              />
            </div>

            {formError && (
              <p className="flex items-center gap-1.5 text-xs text-red-600">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {formError}
              </p>
            )}

            <div className="flex justify-end pt-2">
              <Button onClick={handlePreview} disabled={fetching} className="bg-teal-600 text-white hover:bg-teal-700">
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
                  <CategoryBadge category={activeConfig.category} />
                  {previewMeta.includeAuditTrail && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">Full audit trail</span>
                  )}
                  {activeConfig.cwtAttachedOnly && (
                    <span className="rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700">2307 on file only</span>
                  )}
                  {previewMeta.reportType === 'unreleased' && previewMeta.stalenessFilter !== 'all' && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                      {previewMeta.stalenessFilter === 'stale' ? `Stale only (${STALE_FIXED_MONTHS}mo+)` : 'Not yet stale only'}
                    </span>
                  )}
                </CardTitle>
                <CardDescription>
                  Client Name (Payor):{' '}
                  <span className="font-medium text-gray-700">{previewMeta.payor || 'All clients'}</span>
                  {' · '}Bank(s):{' '}
                  <span className="font-medium text-gray-700">
                    {formatMultiSelectDisplay(previewMeta.bankAll, previewMeta.banks, ALL_BANKS_LABEL)}
                  </span>
                  {' · '}Payee(s):{' '}
                  <span className="font-medium text-gray-700">
                    {formatMultiSelectDisplay(previewMeta.payeeAll, previewMeta.payees, ALL_PAYEES_LABEL)}
                  </span>
                  {(previewMeta.dateFrom || previewMeta.dateTo) && (
                    <>
                      {' · '}Check dates:{' '}
                      <span className="font-medium text-gray-700">{previewMeta.dateFrom || '—'} to {previewMeta.dateTo || '—'}</span>
                    </>
                  )}
                  {previewMeta.extraDateLabel && (previewMeta.extraDateFrom || previewMeta.extraDateTo) && (
                    <>
                      {' · '}{previewMeta.extraDateLabel}:{' '}
                      <span className="font-medium text-gray-700">{previewMeta.extraDateFrom || '—'} to {previewMeta.extraDateTo || '—'}</span>
                    </>
                  )}
                  {activeConfig.showReleasedDateField && previewMeta.releasedDate && (
                    <> {' · '}Released: <span className="font-medium text-gray-700">{previewMeta.releasedDate}</span></>
                  )}
                </CardDescription>
              </div>
              <Button variant="outline" onClick={handleBackToFilters} disabled={downloading || downloadingPdf}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Edit filters
              </Button>
            </div>

            <div className={'grid grid-cols-2 gap-3 sm:grid-cols-4' + (previewMeta.reportType === 'unreleased' ? ' lg:grid-cols-5' : '')}>
              <SummaryStat label="Total rows" value={rawRows.length.toLocaleString()} />
              <SummaryStat label="Total amount" value={formatCurrency(totalAmount)} accent="teal" />
              <SummaryStat label="Banks included" value={previewMeta.bankAll ? ALL_BANKS_LABEL : `${banksInResults.length.toLocaleString()}`} />
              <SummaryStat
                label="Filtered results"
                value={searchTerm ? `${filteredRows.length.toLocaleString()} of ${rawRows.length.toLocaleString()}` : 'All shown'}
              />
              {previewMeta.reportType === 'unreleased' && (
                <SummaryStat
                  label={`Stale (${STALE_FIXED_MONTHS}mo+)`}
                  value={staleRowCount.toLocaleString()}
                  accent={staleRowCount > 0 ? 'amber' : undefined}
                />
              )}
            </div>

            {previewMeta.reportType === 'unreleased' && staleBankBreakdown.length > 0 && (
              <div className="rounded-lg border border-amber-100 bg-amber-50/40 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Stale checks by bank — use this to route BPI transmittals
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {staleBankBreakdown.map((b) => (
                    <div key={b.bank} className="flex items-center justify-between rounded-md border border-amber-100 bg-white px-3 py-2 text-sm">
                      <span className="font-medium text-gray-700">{b.bank}</span>
                      <span className="text-gray-500">{b.count} check{b.count === 1 ? '' : 's'} · {formatCurrency(b.totalAmount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <Input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Quick search by bank, payee, payor, or check no."
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
                    const rowIsStale = previewMeta.reportType === 'unreleased' && isStale(row.check_date)
                    return (
                      <tr
                        key={row.id ?? no}
                        className={'border-b border-gray-100 last:border-0 ' + (rowIsStale ? 'bg-amber-50/50' : 'even:bg-gray-50/50')}
                      >
                        {cells.map((cell, i) => {
                          const col = activeConfig.columns[i]
                          const isAgingStatusCol = col?.header === 'Aging Status'
                          return (
                            <td
                              key={i}
                              className="whitespace-nowrap px-3 py-1.5 text-gray-700"
                              style={{ textAlign: cell.align || 'left', backgroundColor: !isAgingStatusCol && cell.fill ? '#fffbea' : undefined }}
                            >
                              {isAgingStatusCol ? (
                                <span
                                  className={
                                    'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
                                    (String(cell.value).startsWith('Stale') ? 'bg-amber-100 text-amber-800' : 'bg-emerald-50 text-emerald-700')
                                  }
                                >
                                  {cell.value}
                                </span>
                              ) : (
                                formatCellDisplay(cell) || <span className="text-gray-300">—</span>
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

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <span className="inline-block h-3 w-3 rounded-sm border border-amber-200" style={{ backgroundColor: '#fffbea' }} />
                {activeConfig.legendText || 'Highlighted cells are blank in the file — fill them in manually after export.'}
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <span>Page {currentPage} of {totalPages}</span>
                <Button variant="outline" className="h-8 w-8 p-0" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" className="h-8 w-8 p-0" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages}>
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
                {previewMeta.reportType === 'unreleased' && (
                  <Button
                    variant="outline"
                    onClick={handleGenerateTransmittal}
                    disabled={transmittalState.generating || staleRowCount === 0}
                    className="border-amber-300 text-amber-700 hover:bg-amber-50"
                    title={staleRowCount === 0 ? `No stale (${STALE_FIXED_MONTHS}mo+) checks loaded — adjust the aging filter to include them.` : undefined}
                  >
                    {transmittalState.generating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Truck className="mr-2 h-4 w-4" />}
                    {transmittalState.generating ? 'Preparing…' : `Generate Transmittal${staleRowCount ? ` (${staleRowCount})` : ''}`}
                  </Button>
                )}
                <Button variant="outline" onClick={handlePreviewPdf} disabled={pdfState.generating || rawRows.length === 0}>
                  {pdfState.generating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}
                  Preview PDF
                </Button>
                <Button variant="outline" onClick={handleDownloadPdf} disabled={downloadingPdf || rawRows.length === 0}>
                  {downloadingPdf ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                  {downloadingPdf ? 'Preparing…' : 'Download PDF'}
                </Button>
                <Button onClick={handleDownload} disabled={downloading || rawRows.length === 0} className="shrink-0 bg-teal-600 text-white hover:bg-teal-700">
                  {downloading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
                  {downloading ? 'Preparing…' : 'Download Excel'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {pdfState.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={closePdfPreview} role="dialog" aria-modal="true">
          <div className="flex h-full max-h-[90vh] w-full max-w-5xl flex-col rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <h3 className="text-sm font-semibold text-gray-900">PDF preview — {activeConfig?.title}</h3>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleDownloadPdf} disabled={downloadingPdf} className="bg-teal-600 text-white hover:bg-teal-700">
                  {downloadingPdf ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
                  Download
                </Button>
                <button onClick={closePdfPreview} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label="Close PDF preview">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <iframe title="PDF preview" src={pdfState.url} className="flex-1 rounded-b-lg" />
          </div>
        </div>
      )}

      {transmittalState.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={closeTransmittalPreview} role="dialog" aria-modal="true">
          <div className="flex h-full max-h-[90vh] w-full max-w-5xl flex-col rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                  <Truck className="h-4 w-4 text-teal-600" />
                  BPI Transmittal — {transmittalState.transmittalNumber}
                </h3>
                <p className="text-xs text-gray-500">
                  {transmittalState.staleCount} check{transmittalState.staleCount === 1 ? '' : 's'} included, grouped by bank with subtotals.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleDownloadTransmittal} className="bg-teal-600 text-white hover:bg-teal-700">
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  Download
                </Button>
                <button onClick={closeTransmittalPreview} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label="Close transmittal preview">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <iframe title="BPI transmittal preview" src={transmittalState.url} className="flex-1 rounded-b-lg" />
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
        (active ? 'bg-teal-600 text-white' : done ? 'bg-teal-50 text-teal-700' : 'bg-gray-100 text-gray-400')
      }
    >
      {label}
    </span>
  )
}

function SummaryStat({ label, value, accent }) {
  const accentClass = accent === 'teal' ? 'border-l-4 border-l-teal-500' : accent === 'amber' ? 'border-l-4 border-l-amber-400' : ''
  return (
    <div className={'rounded-lg border border-gray-100 bg-white p-3 ' + accentClass}>
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="mt-0.5 text-base font-semibold text-gray-900">{value}</div>
    </div>
  )
}

// Business runs on Philippine time regardless of the browser's local
// timezone, so billing periods and per-day buckets are always computed
// against Asia/Manila (UTC+8). This keeps "uploaded" / "delivered" counts
// from silently dropping records that fall near a period's midnight
// boundary when a user's browser is set to a different timezone.
const MANILA_OFFSET_MINUTES = 8 * 60

function toManilaDateKey(isoString) {
  if (!isoString) return null
  const utcMs = new Date(isoString).getTime()
  const manilaMs = utcMs + MANILA_OFFSET_MINUTES * 60000
  const d = new Date(manilaMs)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function manilaDayBoundsToUtcIso(year, month, day) {
  // Midnight Manila time for the given local calendar day, expressed as a
  // UTC instant, plus the corresponding end-of-day instant.
  const startUtcMs = Date.UTC(year, month, day, 0, 0, 0) - MANILA_OFFSET_MINUTES * 60000
  const endUtcMs = Date.UTC(year, month, day, 23, 59, 59, 999) - MANILA_OFFSET_MINUTES * 60000
  return { startIso: new Date(startUtcMs).toISOString(), endIso: new Date(endUtcMs).toISOString() }
}

// The billing period list ("has this half-month fully elapsed yet?") must
// be judged against the actual Manila calendar date — never the browser's
// local date. A browser running behind or ahead of UTC+8 would otherwise
// either show the still-in-progress period as billable early, or hide a
// period that has, in Manila, already closed.
function getManilaNowParts() {
  const manilaMs = Date.now() + MANILA_OFFSET_MINUTES * 60000
  const d = new Date(manilaMs)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() }
}

function todayManilaDateInputValue() {
  const { year, month, day } = getManilaNowParts()
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function buildPeriodOptions() {
  const options = []
  const { year: nowYear, month: nowMonth } = getManilaNowParts()
  for (let i = 0; i < 13; i++) {
    const d = new Date(nowYear, nowMonth - i, 1)
    const year = d.getFullYear()
    const month = d.getMonth()
    const monthLabel = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    const lastDay = new Date(year, month + 1, 0).getDate()
    options.push({ value: `${year}-${String(month + 1).padStart(2, '0')}-1`, label: `${monthLabel} 1-15`, startDay: 1, endDay: 15, year, month })
    options.push({ value: `${year}-${String(month + 1).padStart(2, '0')}-16`, label: `${monthLabel} 16-${lastDay}`, startDay: 16, endDay: lastDay, year, month })
  }
  return options
}

function periodDateRange(period) {
  const start = new Date(period.year, period.month, period.startDay)
  const end = new Date(period.year, period.month, period.endDay, 23, 59, 59)
  const days = []
  for (let d = period.startDay; d <= period.endDay; d++) days.push(new Date(period.year, period.month, d))
  return { start, end, days }
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function periodEndDateInputValue(period) {
  return `${period.year}-${String(period.month + 1).padStart(2, '0')}-${String(period.endDay).padStart(2, '0')}`
}

function BillingReport() {
  const {
    pickupBranch,
    isAllBranches,
    loading: profileLoading,
    error: profileError,
  } = useProfile()

  const allPeriods = useMemo(() => buildPeriodOptions(), [])
  // A period can only be billed once it has fully elapsed, judged against
  // Manila time (see todayManilaDateInputValue above) — not the browser's
  // local clock. Comparing with "<" (not "<=") means the period containing
  // today is excluded until tomorrow, so the most recent selectable period
  // is always the last one that has actually closed as of the current
  // Manila date.
  const completedPeriods = useMemo(
    () => allPeriods.filter((p) => periodEndDateInputValue(p) < todayManilaDateInputValue()),
    [allPeriods]
  )
  const [periodValue, setPeriodValue] = useState(completedPeriods[0]?.value || '')
  const [bank, setBank] = useState('')
  const [bankOptions, setBankOptions] = useState([])
  const [unitCost, setUnitCost] = useState('')
  const [checkDateFrom, setCheckDateFrom] = useState('')
  const [checkDateTo, setCheckDateTo] = useState('')
  const [rows, setRows] = useState(null)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const { push } = useToast()

  // Bank options — and every query below — are scoped to the signed-in
  // verifier's own branch (unless they're an 'all_branches' profile or
  // admin), the same defense-in-depth pattern used elsewhere: the RPC/RLS
  // is the real security boundary, this just fails closed if they drift.
  useEffect(() => {
    if (profileLoading) return
    if (!isAllBranches && !pickupBranch) return
    ;(async () => {
      try {
        const data = await fetchAllRows(() => {
          let query = supabase.from('checks').select('bank')
          if (!isAllBranches) query = query.eq('pickup_branch', pickupBranch)
          return query
        })
        setBankOptions([...new Set((data || []).map((r) => r.bank).filter(Boolean))].sort())
      } catch {
        // suggestions only
      }
    })()
  }, [profileLoading, isAllBranches, pickupBranch])

  const selectedPeriod = useMemo(() => completedPeriods.find((p) => p.value === periodValue), [completedPeriods, periodValue])

  async function handleGenerate() {
    if (profileLoading) {
      setError('Still loading your profile — please wait a moment and try again.')
      return
    }
    if (!isAllBranches && !pickupBranch) {
      setError("Your account isn't assigned to a branch, so a billing report can't be scoped correctly. Ask an admin to set your branch in your profile.")
      return
    }
    if (completedPeriods.length === 0) {
      setError('No half-month period has fully elapsed yet, so there is nothing to bill.')
      return
    }
    if (!selectedPeriod) {
      setError('Please select a period.')
      return
    }
    if (!bank) {
      setError('Please select a bank.')
      return
    }
    const costNum = Number(unitCost)
    if (!unitCost || Number.isNaN(costNum) || costNum <= 0) {
      setError('Please enter a unit cost greater than zero.')
      return
    }
    if (checkDateFrom && checkDateTo && checkDateFrom > checkDateTo) {
      setError('The check date "from" must be before the check date "to".')
      return
    }
    setError('')
    setFetching(true)
    try {
      const { days } = periodDateRange(selectedPeriod)

      // Manila-local day boundaries for the whole period, used for the
      // Supabase query range so records right at the edges of the period
      // aren't missed because of a browser-timezone mismatch.
      const { startIso } = manilaDayBoundsToUtcIso(selectedPeriod.year, selectedPeriod.month, selectedPeriod.startDay)
      const { endIso } = manilaDayBoundsToUtcIso(selectedPeriod.year, selectedPeriod.month, selectedPeriod.endDay)

      // Uploaded volume: every row in `checks` corresponds to exactly one
      // row uploaded via the Upload page for this branch and bank, so
      // counting `checks.created_at` in range is the authoritative source
      // for "Uploaded Dispatch Soft File Volume" — scoped to this
      // verifier's own branch so billing never mixes in another branch's
      // uploads.
      //
      // Delivered (released) volume is an independent measure, fetched as
      // a separate explicit query rather than one combined OR query — this
      // keeps each count accurate even when a check's created_at and
      // picked_up_at fall in different periods.
      const uploadedRows = await fetchAllRows(() => {
        let query = supabase
          .from('checks')
          .select('id, created_at, check_date, pickup_branch')
          .eq('bank', bank)
          .gte('created_at', startIso)
          .lte('created_at', endIso)
        if (!isAllBranches) query = query.eq('pickup_branch', pickupBranch)
        if (checkDateFrom) query = query.gte('check_date', checkDateFrom)
        if (checkDateTo) query = query.lte('check_date', checkDateTo)
        return query
      })

      const releasedRows = await fetchAllRows(() => {
        let query = supabase
          .from('checks')
          .select('id, picked_up_at, check_date, pickup_branch')
          .eq('bank', bank)
          .eq('status', 'picked_up')
          .gte('picked_up_at', startIso)
          .lte('picked_up_at', endIso)
        if (!isAllBranches) query = query.eq('pickup_branch', pickupBranch)
        if (checkDateFrom) query = query.gte('check_date', checkDateFrom)
        if (checkDateTo) query = query.lte('check_date', checkDateTo)
        return query
      })

      const byDay = new Map(days.map((d) => [dateKey(d), { uploaded: 0, released: 0 }]))

      for (const r of uploadedRows || []) {
        const k = toManilaDateKey(r.created_at)
        if (k && byDay.has(k)) byDay.get(k).uploaded += 1
      }
      for (const r of releasedRows || []) {
        const k = toManilaDateKey(r.picked_up_at)
        if (k && byDay.has(k)) byDay.get(k).released += 1
      }

      const builtRows = days.map((d) => {
        const bucket = byDay.get(dateKey(d))
        const subtotal = bucket.uploaded * costNum
        return { date: d, uploaded: bucket.uploaded, unitCost: costNum, subtotal, released: bucket.released, totalBilling: subtotal }
      })

      setRows(builtRows)
      push?.({ variant: 'success', title: 'Billing report generated', description: `${builtRows.length} day(s) loaded.` })
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setFetching(false)
    }
  }

  const totals = useMemo(() => {
    if (!rows) return null
    const totalNetOfVat = rows.reduce((sum, r) => sum + r.totalBilling, 0)
    const vat = totalNetOfVat * 0.12
    return { totalNetOfVat, vat, grandTotal: totalNetOfVat + vat }
  }, [rows])

  function filenameBase() {
    const stamp = todayDateInputValue()
    const safeBank = (bank || 'bank').replace(/[^a-z0-9]+/gi, '_')
    const safePeriod = (selectedPeriod?.label || 'period').replace(/[^a-z0-9]+/gi, '_')
    return `billing-report-${safeBank}-${safePeriod}-${stamp}`
  }

  async function handleDownloadExcel() {
    if (!rows || !totals) return
    setDownloading(true)
    try {
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Check Disbursement System'
      workbook.created = new Date()
      const sheet = workbook.addWorksheet('Billing Report', {
        pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
        views: [{ showGridLines: false }],
      })
      const columns = [
        { header: 'Productivity Date', width: 16 },
        { header: 'Uploaded Dispatch Soft File Volume', width: 22 },
        { header: 'Unit Cost of Items Processed', width: 18 },
        { header: 'Subtotal Amount Processed', width: 20 },
        { header: 'Volume of Processed Delivered', width: 20 },
        { header: 'Volume of RTS', width: 14 },
        { header: 'Total Amount of Billing', width: 18 },
      ]
      sheet.columns = columns.map((c) => ({ width: c.width }))

      sheet.mergeCells(1, 1, 1, columns.length)
      sheet.getCell(1, 1).value = 'BILLING REPORT'
      sheet.getCell(1, 1).font = { bold: true, size: 14, color: { argb: HEADER_FILL_COLOR } }

      sheet.mergeCells(2, 1, 2, columns.length)
      const rangeLabel = checkDateFrom || checkDateTo ? ` · Check Dates: ${checkDateFrom || '—'} to ${checkDateTo || '—'}` : ''
      const branchLabel = isAllBranches ? 'All Branches' : pickupBranch || '—'
      sheet.getCell(2, 1).value = `Branch: ${branchLabel} · Bank: ${bank} · Period: ${selectedPeriod?.label || '—'}${rangeLabel}`
      sheet.getCell(2, 1).font = { size: 10 }

      let r = 4
      const headerRow = sheet.getRow(r)
      columns.forEach((c, i) => {
        const cell = headerRow.getCell(i + 1)
        cell.value = c.header
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_COLOR } }
        cell.border = thinBorder()
      })
      headerRow.height = 28
      r++

      for (const row of rows) {
        const excelRow = sheet.getRow(r)
        const values = [
          row.date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }),
          row.uploaded,
          row.unitCost,
          row.subtotal,
          row.released,
          '',
          row.totalBilling,
        ]
        values.forEach((v, i) => {
          const cell = excelRow.getCell(i + 1)
          cell.value = v
          if (i === 2 || i === 3 || i === 6) cell.numFmt = '#,##0.00'
          cell.alignment = { vertical: 'middle', horizontal: i === 0 ? 'center' : i >= 2 ? 'right' : 'center' }
          cell.border = thinBorder()
          if (i === 5) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MANUAL_FILL_COLOR } }
        })
        r++
      }

      const totalsStartRow = r + 1
      const totalLines = [
        ['Total Net of VAT', totals.totalNetOfVat],
        ['12% VAT', totals.vat],
        ['Total Billing Amount', totals.grandTotal],
      ]
      totalLines.forEach(([label, value], i) => {
        const row = sheet.getRow(totalsStartRow + i)
        sheet.mergeCells(totalsStartRow + i, 1, totalsStartRow + i, columns.length - 1)
        const labelCell = row.getCell(1)
        labelCell.value = label
        labelCell.font = { bold: true }
        labelCell.alignment = { horizontal: 'right' }
        const valueCell = row.getCell(columns.length)
        valueCell.value = value
        valueCell.numFmt = '#,##0.00'
        valueCell.font = { bold: true }
        valueCell.alignment = { horizontal: 'right' }
      })

      sheet.views = [{ state: 'frozen', ySplit: 4 }]

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${filenameBase()}.xlsx`
      a.click()
      URL.revokeObjectURL(url)

      logAuditEvent('report_generated', {
        format: 'xlsx',
        report_type: 'billing',
        bank,
        period: selectedPeriod?.label,
        branch: isAllBranches ? 'all_branches' : pickupBranch,
      }).catch(() => {})
    } catch (err) {
      push?.({ variant: 'error', title: 'Download failed', description: friendlyError(err) })
    } finally {
      setDownloading(false)
    }
  }

  async function handleDownloadPdf() {
    if (!rows || !totals) return
    setDownloadingPdf(true)
    try {
      const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
      const margin = 32
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(13)
      doc.setTextColor(...BRAND_TEAL_RGB)
      doc.text('BILLING REPORT', margin, 40)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(10)
      doc.setTextColor(60, 60, 60)
      const rangeLabel = checkDateFrom || checkDateTo ? ` · Check Dates: ${checkDateFrom || '—'} to ${checkDateTo || '—'}` : ''
      const branchLabel = isAllBranches ? 'All Branches' : pickupBranch || '—'
      doc.text(`Branch: ${branchLabel} · Bank: ${bank} · Period: ${selectedPeriod?.label || '—'}${rangeLabel}`, margin, 58)

      const head = [['Productivity Date', 'Uploaded Volume', 'Unit Cost', 'Subtotal', 'Delivered', 'RTS', 'Total Billing']]
      const body = rows.map((row) => [
        row.date.toLocaleDateString('en-US'),
        String(row.uploaded),
        row.unitCost.toLocaleString('en-US', { minimumFractionDigits: 2 }),
        row.subtotal.toLocaleString('en-US', { minimumFractionDigits: 2 }),
        String(row.released),
        '',
        row.totalBilling.toLocaleString('en-US', { minimumFractionDigits: 2 }),
      ])

      autoTable(doc, {
        head,
        body,
        startY: 74,
        margin: { left: margin, right: margin },
        styles: { fontSize: 8, cellPadding: 4, lineColor: [209, 213, 219], lineWidth: 0.5, textColor: [55, 65, 81] },
        headStyles: { fillColor: BRAND_TEAL_RGB, textColor: 255, fontStyle: 'bold', halign: 'center' },
        columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 6: { halign: 'right' } },
        didParseCell: (data) => {
          if (data.row.section === 'body' && data.column.index === 5) data.cell.styles.fillColor = [255, 251, 234]
        },
      })

      let y = doc.lastAutoTable.finalY + 24
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10)
      doc.setTextColor(20, 20, 20)
      doc.text(`Total Net of VAT: ${totals.totalNetOfVat.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, margin, y)
      y += 16
      doc.text(`12% VAT: ${totals.vat.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, margin, y)
      y += 16
      doc.text(`Total Billing Amount: ${totals.grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, margin, y)

      doc.save(`${filenameBase()}.pdf`)
      logAuditEvent('report_generated', {
        format: 'pdf',
        report_type: 'billing',
        bank,
        period: selectedPeriod?.label,
        branch: isAllBranches ? 'all_branches' : pickupBranch,
      }).catch(() => {})
    } catch (err) {
      push?.({ variant: 'error', title: 'PDF download failed', description: friendlyError(err) })
    } finally {
      setDownloadingPdf(false)
    }
  }

  if (profileError) {
    return (
      <Card className="border-gray-100 shadow-sm">
        <CardContent className="pt-6">
          <p className="flex items-center gap-1.5 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Could not load your profile: {profileError}
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-gray-100 shadow-sm">
      <CardHeader>
        <CardTitle className="text-lg">Billing report</CardTitle>
        <CardDescription>
          Half-month daily breakdown of uploaded and delivered volume, with VAT totals.
          {!profileLoading && !isAllBranches && pickupBranch && <> Scoped to your branch: <span className="font-medium text-gray-700">{pickupBranch}</span>.</>}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!profileLoading && !isAllBranches && !pickupBranch ? (
          <p className="flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Your account isn't assigned to a branch, so a billing report can't be scoped correctly. Ask an admin to set your branch in your profile.
          </p>
        ) : completedPeriods.length === 0 ? (
          <p className="flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            No half-month period has fully elapsed yet — check back once the current period ends.
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Period</label>
                <Select value={periodValue} onChange={(e) => setPeriodValue(e.target.value)}>
                  {completedPeriods.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </Select>
                <p className="mt-1 text-xs text-gray-400">Only fully-elapsed half-month periods can be billed — the period in progress isn't listed yet.</p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Bank</label>
                <Select value={bank} onChange={(e) => setBank(e.target.value)} disabled={profileLoading}>
                  <option value="">Select bank…</option>
                  {bankOptions.map((b) => (<option key={b} value={b}>{b}</option>))}
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Unit cost (₱ per item)</label>
                <Input type="number" min="0" step="0.01" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder="e.g. 5.00" />
              </div>
            </div>

            <div className="grid gap-4 rounded-md border border-gray-200 bg-gray-50/60 px-3 py-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500">
                  <CalendarRange className="h-3.5 w-3.5" /> Check date from (optional)
                </label>
                <Input type="date" value={checkDateFrom} onChange={(e) => setCheckDateFrom(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500">
                  <CalendarRange className="h-3.5 w-3.5" /> Check date to (optional)
                </label>
                <Input type="date" value={checkDateTo} onChange={(e) => setCheckDateTo(e.target.value)} />
              </div>
            </div>

            {error && (
              <p className="flex items-center gap-1.5 text-xs text-red-600">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {error}
              </p>
            )}

            <div className="flex justify-end">
              <Button onClick={handleGenerate} disabled={fetching || profileLoading} className="bg-teal-600 text-white hover:bg-teal-700">
                {fetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                {fetching ? 'Generating…' : 'Generate preview'}
              </Button>
            </div>
          </>
        )}

        {rows && totals && (
          <>
            <div className="overflow-auto rounded-lg border border-gray-200" style={{ maxHeight: 420 }}>
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 z-10">
                  <tr>
                    {['Date', 'Uploaded Vol.', 'Unit Cost', 'Subtotal', 'Delivered', 'RTS', 'Total Billing'].map((h) => (
                      <th key={h} className="whitespace-nowrap border-b border-gray-200 bg-teal-600 px-3 py-2 text-left text-xs font-semibold text-white">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={dateKey(row.date)} className="border-b border-gray-100 last:border-0 even:bg-gray-50/50">
                      <td className="px-3 py-1.5 text-center">{row.date.toLocaleDateString('en-US')}</td>
                      <td className="px-3 py-1.5 text-center">{row.uploaded}</td>
                      <td className="px-3 py-1.5 text-right">{row.unitCost.toFixed(2)}</td>
                      <td className="px-3 py-1.5 text-right">{row.subtotal.toFixed(2)}</td>
                      <td className="px-3 py-1.5 text-center">{row.released}</td>
                      <td className="px-3 py-1.5 text-center" style={{ backgroundColor: '#fffbea' }}>
                        <span className="text-gray-300">—</span>
                      </td>
                      <td className="px-3 py-1.5 text-right">{row.totalBilling.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="inline-block h-3 w-3 rounded-sm border border-amber-200" style={{ backgroundColor: '#fffbea' }} />
              RTS isn't tracked in this system yet, so that column is left blank for manual entry.
            </p>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-gray-50 p-3 text-sm">
              <div className="space-y-0.5 text-gray-700">
                <div>Total Net of VAT: <span className="font-semibold">{formatCurrency(totals.totalNetOfVat)}</span></div>
                <div>12% VAT: <span className="font-semibold">{formatCurrency(totals.vat)}</span></div>
                <div>Total Billing Amount: <span className="font-semibold text-teal-700">{formatCurrency(totals.grandTotal)}</span></div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={handleDownloadPdf} disabled={downloadingPdf}>
                  {downloadingPdf ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}
                  Download PDF
                </Button>
                <Button onClick={handleDownloadExcel} disabled={downloading} className="bg-teal-600 text-white hover:bg-teal-700">
                  {downloading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
                  Download Excel
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

const SUMMARY_GROUP_BY_OPTIONS = [
  { value: 'bank', label: 'Bank' },
  { value: 'payor', label: 'Client (Payor)' },
]

function StatusSummaryReport({ status, dateField, dateFieldLabel, title, description, fileTag, accentClass }) {
  const [groupBy, setGroupBy] = useState('bank')
  const [bank, setBank] = useState('')
  const [payor, setPayor] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [checkDateFrom, setCheckDateFrom] = useState('')
  const [checkDateTo, setCheckDateTo] = useState('')
  const [bankOptions, setBankOptions] = useState([])
  const [rows, setRows] = useState(null)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const [pdfState, setPdfState] = useState({ open: false, url: '', generating: false })
  const requestIdRef = useRef(0)
  const { push } = useToast()

  useEffect(() => {
    return () => {
      if (pdfState.url) URL.revokeObjectURL(pdfState.url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfState.url])

  useEffect(() => {
    ;(async () => {
      try {
        const data = await fetchAllRows(() => supabase.from('checks').select('bank').eq('status', status))
        setBankOptions([...new Set((data || []).map((r) => r.bank).filter(Boolean))].sort())
      } catch {
        // suggestions only
      }
    })()
  }, [status])

  async function handleGenerate() {
    setError('')
    if (dateFrom && dateTo && dateFrom > dateTo) {
      setError(`The ${dateFieldLabel.toLowerCase()} "from" must be before the "to".`)
      return
    }
    if (checkDateFrom && checkDateTo && checkDateFrom > checkDateTo) {
      setError('The check date "from" must be before the check date "to".')
      return
    }
    const myRequestId = ++requestIdRef.current
    setFetching(true)
    try {
      const data = await fetchAllRows(() => {
        let query = supabase.from('checks').select('bank, payor, amount, check_date').eq('status', status)
        if (bank) query = query.eq('bank', bank)
        if (payor.trim()) query = query.ilike('payor', `%${payor.trim()}%`)
        if (dateFrom) query = query.gte(dateField, `${dateFrom}T00:00:00`)
        if (dateTo) query = query.lte(dateField, `${dateTo}T23:59:59`)
        if (checkDateFrom) query = query.gte('check_date', checkDateFrom)
        if (checkDateTo) query = query.lte('check_date', checkDateTo)
        return query
      })

      const groups = new Map()
      for (const r of data || []) {
        const key = (groupBy === 'payor' ? r.payor : r.bank) || '(blank)'
        if (!groups.has(key)) groups.set(key, { key, count: 0, amount: 0 })
        const g = groups.get(key)
        g.count += 1
        g.amount += Number(r.amount || 0)
      }

      const built = [...groups.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)))
      if (myRequestId !== requestIdRef.current) return
      setRows(built)
      push?.({ variant: 'success', title: `${title} generated`, description: `${built.length} group(s) loaded.` })
    } catch (err) {
      if (myRequestId !== requestIdRef.current) return
      setError(friendlyError(err))
    } finally {
      if (myRequestId === requestIdRef.current) setFetching(false)
    }
  }

  const grandTotals = useMemo(() => {
    if (!rows) return null
    return rows.reduce((acc, r) => ({ count: acc.count + r.count, amount: acc.amount + r.amount }), { count: 0, amount: 0 })
  }, [rows])

  function summaryFilenameBase() {
    return `${fileTag}-${groupBy}-${todayDateInputValue()}`
  }

  const groupLabel = SUMMARY_GROUP_BY_OPTIONS.find((g) => g.value === groupBy)?.label || 'Group'

  async function handleDownloadExcel() {
    if (!rows || !grandTotals) return
    setDownloading(true)
    try {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet(title.slice(0, 31), { views: [{ showGridLines: false }] })
      const columns = [
        { header: groupLabel, width: 26 },
        { header: 'Count', width: 14 },
        { header: 'Amount (₱)', width: 18 },
      ]
      sheet.columns = columns.map((c) => ({ width: c.width }))
      sheet.mergeCells(1, 1, 1, columns.length)
      sheet.getCell(1, 1).value = title.toUpperCase()
      sheet.getCell(1, 1).font = { bold: true, size: 13, color: { argb: HEADER_FILL_COLOR } }

      let r = 3
      const headerRow = sheet.getRow(r)
      columns.forEach((c, i) => {
        const cell = headerRow.getCell(i + 1)
        cell.value = c.header
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_COLOR } }
        cell.alignment = { horizontal: 'center' }
        cell.border = thinBorder()
      })
      r++

      for (const row of rows) {
        const excelRow = sheet.getRow(r)
        const values = [row.key, row.count, row.amount]
        values.forEach((v, i) => {
          const cell = excelRow.getCell(i + 1)
          cell.value = v
          if (i === 2) cell.numFmt = '#,##0.00'
          cell.alignment = { horizontal: i === 0 ? 'left' : 'right' }
          cell.border = thinBorder()
        })
        r++
      }

      const totalRow = sheet.getRow(r)
      const totalValues = ['TOTAL', grandTotals.count, grandTotals.amount]
      totalValues.forEach((v, i) => {
        const cell = totalRow.getCell(i + 1)
        cell.value = v
        if (i === 2) cell.numFmt = '#,##0.00'
        cell.font = { bold: true }
        cell.alignment = { horizontal: i === 0 ? 'left' : 'right' }
      })

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${summaryFilenameBase()}.xlsx`
      a.click()
      URL.revokeObjectURL(url)

      logAuditEvent('report_generated', { format: 'xlsx', report_type: fileTag, group_by: groupBy }).catch(() => {})
    } catch (err) {
      push?.({ variant: 'error', title: 'Download failed', description: friendlyError(err) })
    } finally {
      setDownloading(false)
    }
  }

  async function buildSummaryPdfDocument() {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
    const margin = 32

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(13)
    doc.setTextColor(...BRAND_TEAL_RGB)
    doc.text(title.toUpperCase(), margin, 40)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(60, 60, 60)
    doc.text(`Grouped by: ${groupLabel} · Bank: ${bank || 'All'} · Payor: ${payor || 'All'}`, margin, 58)

    const head = [[groupLabel, 'Count', 'Amount (₱)']]
    const body = rows.map((r) => [
      String(r.key),
      String(r.count),
      r.amount.toLocaleString('en-US', { minimumFractionDigits: 2 }),
    ])
    body.push(['TOTAL', String(grandTotals.count), grandTotals.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })])
    const totalRowIndex = body.length - 1

    autoTable(doc, {
      head,
      body,
      startY: 74,
      margin: { left: margin, right: margin },
      styles: { fontSize: 8, cellPadding: 4, lineColor: [209, 213, 219], lineWidth: 0.5, textColor: [55, 65, 81] },
      headStyles: { fillColor: BRAND_TEAL_RGB, textColor: 255, fontStyle: 'bold', halign: 'center' },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
      didParseCell: (data) => {
        if (data.row.section === 'body' && data.row.index === totalRowIndex) data.cell.styles.fontStyle = 'bold'
      },
    })

    return doc
  }

  async function handlePreviewPdf() {
    if (!rows || !grandTotals) return
    setPdfState((s) => ({ ...s, generating: true }))
    try {
      const doc = await buildSummaryPdfDocument()
      const blobUrl = doc.output('bloburl')
      setPdfState((s) => {
        if (s.url) URL.revokeObjectURL(s.url)
        return { open: true, url: blobUrl, generating: false }
      })
    } catch (err) {
      push?.({ variant: 'error', title: 'PDF preview failed', description: friendlyError(err) })
      setPdfState((s) => ({ ...s, generating: false }))
    }
  }

  function closePdfPreview() {
    setPdfState((s) => {
      if (s.url) URL.revokeObjectURL(s.url)
      return { open: false, url: '', generating: false }
    })
  }

  async function handleDownloadPdf() {
    if (!rows || !grandTotals) return
    setDownloadingPdf(true)
    try {
      const doc = await buildSummaryPdfDocument()
      doc.save(`${summaryFilenameBase()}.pdf`)
      logAuditEvent('report_generated', { format: 'pdf', report_type: fileTag, group_by: groupBy }).catch(() => {})
    } catch (err) {
      push?.({ variant: 'error', title: 'PDF download failed', description: friendlyError(err) })
    } finally {
      setDownloadingPdf(false)
    }
  }

  return (
    <Card className={'border-gray-100 shadow-sm ' + (accentClass || '')}>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Group by</label>
            <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              {SUMMARY_GROUP_BY_OPTIONS.map((g) => (<option key={g.value} value={g.value}>{g.label}</option>))}
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Bank</label>
            <Select value={bank} onChange={(e) => setBank(e.target.value)}>
              <option value="">All banks</option>
              {bankOptions.map((b) => (<option key={b} value={b}>{b}</option>))}
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Payor contains</label>
            <Input value={payor} onChange={(e) => setPayor(e.target.value)} placeholder="Optional" />
          </div>
        </div>

        <div className="grid gap-4 rounded-md border border-gray-200 bg-gray-50/60 px-3 py-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500">
              <CalendarRange className="h-3.5 w-3.5" /> {dateFieldLabel} from
            </label>
            <Input type="date" value={dateFrom} max={todayDateInputValue()} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500">
              <CalendarRange className="h-3.5 w-3.5" /> {dateFieldLabel} to
            </label>
            <Input type="date" value={dateTo} max={todayDateInputValue()} onChange={(e) => setDateTo(e.target.value)} />
          </div>
        </div>

        <div className="grid gap-4 rounded-md border border-gray-200 bg-gray-50/60 px-3 py-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500">
              <CalendarRange className="h-3.5 w-3.5" /> Check date from (optional)
            </label>
            <Input type="date" value={checkDateFrom} onChange={(e) => setCheckDateFrom(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500">
              <CalendarRange className="h-3.5 w-3.5" /> Check date to (optional)
            </label>
            <Input type="date" value={checkDateTo} onChange={(e) => setCheckDateTo(e.target.value)} />
          </div>
        </div>

        {error && (
          <p className="flex items-center gap-1.5 text-xs text-red-600">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}

        <div className="flex justify-end">
          <Button onClick={handleGenerate} disabled={fetching} className="bg-teal-600 text-white hover:bg-teal-700">
            {fetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {fetching ? 'Generating…' : 'Generate summary'}
          </Button>
        </div>

        {rows && grandTotals && (
          <>
            <div className="overflow-auto rounded-lg border border-gray-200">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    {[groupLabel, 'Count', 'Amount (₱)'].map((h) => (
                      <th key={h} className="whitespace-nowrap border-b border-gray-200 bg-teal-600 px-3 py-2 text-left text-xs font-semibold text-white">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key} className="border-b border-gray-100 last:border-0 even:bg-gray-50/50">
                      <td className="px-3 py-1.5">{row.key}</td>
                      <td className="px-3 py-1.5 text-right">{row.count}</td>
                      <td className="px-3 py-1.5 text-right">{formatCurrency(row.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-300 font-semibold">
                    <td className="px-3 py-2">TOTAL</td>
                    <td className="px-3 py-2 text-right">{grandTotals.count}</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(grandTotals.amount)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={handlePreviewPdf} disabled={pdfState.generating}>
                {pdfState.generating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}
                Preview PDF
              </Button>
              <Button variant="outline" onClick={handleDownloadPdf} disabled={downloadingPdf}>
                {downloadingPdf ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                Download PDF
              </Button>
              <Button onClick={handleDownloadExcel} disabled={downloading} className="bg-teal-600 text-white hover:bg-teal-700">
                {downloading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
                Download Excel
              </Button>
            </div>
          </>
        )}
      </CardContent>

      {pdfState.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={closePdfPreview} role="dialog" aria-modal="true">
          <div className="flex h-full max-h-[90vh] w-full max-w-5xl flex-col rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <h3 className="text-sm font-semibold text-gray-900">PDF preview — {title}</h3>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleDownloadPdf} disabled={downloadingPdf} className="bg-teal-600 text-white hover:bg-teal-700">
                  {downloadingPdf ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
                  Download
                </Button>
                <button onClick={closePdfPreview} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label="Close PDF preview">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <iframe title="PDF preview" src={pdfState.url} className="flex-1 rounded-b-lg" />
          </div>
        </div>
      )}
    </Card>
  )
}

const SUMMARY_SUBTABS = [
  { key: 'released', label: 'Released Summary' },
  { key: 'unreleased', label: 'Unreleased Summary' },
]

function SummaryReports() {
  const [subTab, setSubTab] = useState('released')

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md border border-gray-200 bg-white p-0.5">
        {SUMMARY_SUBTABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setSubTab(tab.key)}
            className={
              'rounded px-4 py-1.5 text-sm font-medium transition-colors ' +
              (subTab === tab.key ? 'bg-teal-600 text-white' : 'text-gray-600 hover:bg-gray-100')
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      {subTab === 'released' ? (
        <StatusSummaryReport
          key="released-summary"
          status="picked_up"
          dateField="picked_up_at"
          dateFieldLabel="Released date"
          title="Released Summary"
          description="Pivot totals of released checks by bank or client, narrowed by released date and check date."
          fileTag="released-summary-report"
          accentClass="border-l-4 border-l-teal-500"
        />
      ) : (
        <StatusSummaryReport
          key="unreleased-summary"
          status="available"
          dateField="created_at"
          dateFieldLabel="Uploaded date"
          title="Unreleased Summary"
          description="Pivot totals of unreleased checks by bank or client, narrowed by uploaded date and check date."
          fileTag="unreleased-summary-report"
          accentClass="border-l-4 border-l-amber-400"
        />
      )}
    </div>
  )
}