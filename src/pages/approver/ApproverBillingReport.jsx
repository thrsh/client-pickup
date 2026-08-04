// src/pages/approver/ApproverBillingReport.jsx
//
// This page is the "Billing Report" feature from
// src/pages/admin/AdminReports.jsx (the BillingReport component), ported
// over unchanged so approvers can generate the exact same half-month
// billing breakdown Admin Reports produces — same filters, same Manila-
// time period logic, same Excel/PDF exports, same branch scoping rules.
//
// Nothing about the generation logic has been altered. The only addition
// is the thin page wrapper (ApproverBillingReport) at the bottom, so this
// can be dropped in as a standalone route under /approver.
import React, { useEffect, useMemo, useState } from 'react'
import {
  Loader2,
  FileSpreadsheet,
  FileText,
  AlertTriangle,
  RefreshCw,
  CalendarRange,
  Landmark,
  Info,
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
import { generateReportReferenceNumber } from '../../lib/reportReference'

const BRAND = {
  teal: '#0d9488',
  orange: '#f97316',
  gray: '#64748b',
}
const BRAND_TEAL_RGB = [13, 148, 136]

const HEADER_FILL_COLOR = 'FF0D9488'
const BORDER_COLOR = 'FFD1D5DB'
const FUTURE_FILL_COLOR = 'FFF3F4F6' // light gray — marks an in-progress period's not-yet-happened days

const LOGO_URL = '/logo.png'

function thinBorder() {
  return {
    top: { style: 'thin', color: { argb: BORDER_COLOR } },
    left: { style: 'thin', color: { argb: BORDER_COLOR } },
    bottom: { style: 'thin', color: { argb: BORDER_COLOR } },
    right: { style: 'thin', color: { argb: BORDER_COLOR } },
  }
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

// Dropdown is capped to the current calendar month plus the previous 2
// months (3 months total, 6 half-month periods) — NOT the full 13-month
// history this used to build. The still-in-progress half is included
// (flagged via `isCurrent`) rather than hidden, so a reviewer can preview
// it; `handleGenerate` further below is what blanks out any day within it
// that hasn't happened yet.
const PERIOD_DROPDOWN_MONTHS_BACK = 3

function buildPeriodOptions() {
  const options = []
  const { year: nowYear, month: nowMonth, day: nowDay } = getManilaNowParts()
  for (let i = 0; i < PERIOD_DROPDOWN_MONTHS_BACK; i++) {
    const d = new Date(nowYear, nowMonth - i, 1)
    const year = d.getFullYear()
    const month = d.getMonth()
    const monthLabel = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    const lastDay = new Date(year, month + 1, 0).getDate()
    const halves = [
      { startDay: 1, endDay: 15, baseLabel: `${monthLabel} 1-15` },
      { startDay: 16, endDay: lastDay, baseLabel: `${monthLabel} 16-${lastDay}` },
    ]
    halves.forEach((h) => {
      const isCurrent = year === nowYear && month === nowMonth && nowDay >= h.startDay && nowDay <= h.endDay
      options.push({
        value: `${year}-${String(month + 1).padStart(2, '0')}-${h.startDay}`,
        label: isCurrent ? `${h.baseLabel} (In Progress)` : h.baseLabel,
        startDay: h.startDay,
        endDay: h.endDay,
        year,
        month,
        isCurrent,
      })
    })
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

function isFutureManilaDay(d) {
  return dateKey(d) > todayManilaDateInputValue()
}

const ALL_BRANCHES_LABEL = 'All Branches'
const ALL_BRANCHES_VALUE = '__all_branches__'

function BillingReport() {
  const {
    pickupBranch,
    isAllBranches,
    loading: profileLoading,
    error: profileError,
    fullName,
  } = useProfile()

  const periodOptions = useMemo(() => buildPeriodOptions(), [])
  const defaultPeriodValue = periodOptions.find((p) => p.isCurrent)?.value || periodOptions[0]?.value || ''
  const [periodValue, setPeriodValue] = useState(defaultPeriodValue)
  const [bank, setBank] = useState('')
  const [bankOptions, setBankOptions] = useState([])

  const [branch, setBranch] = useState(ALL_BRANCHES_VALUE)
  const [branchOptions, setBranchOptions] = useState([])

  const [unitCost, setUnitCost] = useState('') // rate per item UPLOADED
  const [deliveredRate, setDeliveredRate] = useState('') // rate per item DELIVERED
  const [checkDateFrom, setCheckDateFrom] = useState('')
  const [checkDateTo, setCheckDateTo] = useState('')
  const [rows, setRows] = useState(null)
  const [branchBreakdown, setBranchBreakdown] = useState([])

  const [reportMeta, setReportMeta] = useState(null)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const { push } = useToast()

 useEffect(() => {
    if (profileLoading) return
    if (!isAllBranches && !pickupBranch) return
    ;(async () => {
      try {
        const data = await fetchAllRows(() => {
          let query = supabase.from('checks').select('bank, pickup_branch')
          if (!isAllBranches) query = query.eq('pickup_branch', pickupBranch)
          return query
        })
        setBankOptions([...new Set((data || []).map((r) => r.bank).filter(Boolean))].sort())
        // Branch-locked users only ever see their own branch; "all
        // branches" users see every distinct branch that has ever appeared
        // on an uploaded check.
        setBranchOptions(
          isAllBranches
            ? [...new Set((data || []).map((r) => r.pickup_branch).filter(Boolean))].sort()
            : [pickupBranch].filter(Boolean)
        )
      } catch {
        // suggestions only
      }
    })()
  }, [profileLoading, isAllBranches, pickupBranch])

  // Defense in depth: a branch-locked user can never end up scoping a
  // report to a different branch (or to "All Branches"), even if `branch`
  // was left at its default sentinel before the profile finished loading.
  useEffect(() => {
    if (profileLoading) return
    if (!isAllBranches && pickupBranch) setBranch(pickupBranch)
  }, [profileLoading, isAllBranches, pickupBranch])

  const selectedPeriod = useMemo(() => periodOptions.find((p) => p.value === periodValue), [periodOptions, periodValue])

  async function handleGenerate() {
    if (profileLoading) {
      setError('Still loading your profile — please wait a moment and try again.')
      return
    }
    if (!isAllBranches && !pickupBranch) {
      setError("Your account isn't assigned to a branch, so a billing report can't be scoped correctly. Ask an admin to set your branch in your profile.")
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
    if (isAllBranches && !branch) {
      setError(`Please select a branch, or "${ALL_BRANCHES_LABEL}".`)
      return
    }
    const uploadedRateNum = Number(unitCost)
    if (!unitCost || Number.isNaN(uploadedRateNum) || uploadedRateNum <= 0) {
      setError('Please enter an uploaded rate greater than zero.')
      return
    }
    const deliveredRateNum = Number(deliveredRate)
    if (!deliveredRate || Number.isNaN(deliveredRateNum) || deliveredRateNum <= 0) {
      setError('Please enter a delivered rate greater than zero.')
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
      const { startIso } = manilaDayBoundsToUtcIso(selectedPeriod.year, selectedPeriod.month, selectedPeriod.startDay)
      const { endIso } = manilaDayBoundsToUtcIso(selectedPeriod.year, selectedPeriod.month, selectedPeriod.endDay)

      const effectiveBranch = isAllBranches ? branch : pickupBranch
      const aggregateAllBranches = isAllBranches && effectiveBranch === ALL_BRANCHES_VALUE

      const uploadedRows = await fetchAllRows(() => {
        let query = supabase
          .from('checks')
          .select('id, created_at, check_date, pickup_branch')
          .eq('bank', bank)
          .gte('created_at', startIso)
          .lte('created_at', endIso)
        if (!aggregateAllBranches) query = query.eq('pickup_branch', effectiveBranch)
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
        if (!aggregateAllBranches) query = query.eq('pickup_branch', effectiveBranch)
        if (checkDateFrom) query = query.gte('check_date', checkDateFrom)
        if (checkDateTo) query = query.lte('check_date', checkDateTo)
        return query
      })

    const byDay = new Map(days.map((d) => [dateKey(d), { uploaded: 0, released: 0 }]))
      const byBranch = new Map()
      function branchBucket(branchName) {
        const key = branchName || '(unassigned)'
        if (!byBranch.has(key)) {
          byBranch.set(key, { branch: key, uploaded: 0, released: 0, uploadedAmount: 0, releasedAmount: 0 })
        }
        return byBranch.get(key)
      }

      for (const r of uploadedRows || []) {
        const k = toManilaDateKey(r.created_at)
        if (k && byDay.has(k)) byDay.get(k).uploaded += 1
        if (aggregateAllBranches) {
          const b = branchBucket(r.pickup_branch)
          b.uploaded += 1
          b.uploadedAmount += uploadedRateNum
        }
      }
      for (const r of releasedRows || []) {
        const k = toManilaDateKey(r.picked_up_at)
        if (k && byDay.has(k)) byDay.get(k).released += 1
        if (aggregateAllBranches) {
          const b = branchBucket(r.pickup_branch)
          b.released += 1
          b.releasedAmount += deliveredRateNum
        }
      }

     const builtRows = days.map((d) => {
        // Days that haven't happened yet in Manila time (only relevant
        // when the selected period is still in progress) have no real
        // data — `hasData: false` marks them so the preview table and
        // both exports render "—" instead of a misleading "0", which
        // would otherwise look identical to a genuine zero-volume day.
        if (isFutureManilaDay(d)) {
          return {
            date: d,
            hasData: false,
            uploaded: null,
            unitCost: uploadedRateNum,
            subtotal: null,
            released: null,
            deliveredRate: deliveredRateNum,
            deliveredSubtotal: null,
            totalBilling: null,
          }
        }
        const bucket = byDay.get(dateKey(d))
        const uploadedSubtotal = bucket.uploaded * uploadedRateNum
        const deliveredSubtotal = bucket.released * deliveredRateNum
        return {
          date: d,
          hasData: true,
          uploaded: bucket.uploaded,
          unitCost: uploadedRateNum,
          subtotal: uploadedSubtotal,
          released: bucket.released,
          deliveredRate: deliveredRateNum,
          deliveredSubtotal,
          totalBilling: uploadedSubtotal + deliveredSubtotal,
        }
      })

      const builtBranchBreakdown = aggregateAllBranches
        ? [...byBranch.values()]
            .map((b) => ({ ...b, totalAmount: b.uploadedAmount + b.releasedAmount }))
            .sort((a, b) => b.totalAmount - a.totalAmount)
        : []

      const branchLabel = !isAllBranches ? pickupBranch || '—' : aggregateAllBranches ? ALL_BRANCHES_LABEL : effectiveBranch
      const referenceNumber = generateReportReferenceNumber({
        location: !isAllBranches ? pickupBranch : aggregateAllBranches ? null : effectiveBranch,
        reportType: 'billing',
        bank,
        bankAll: false,
        date: new Date(),
      })

      setRows(builtRows)
      setBranchBreakdown(builtBranchBreakdown)
      setReportMeta({
        referenceNumber,
        bank,
        branchLabel,
        branchTag: !isAllBranches ? pickupBranch : aggregateAllBranches ? 'all_branches' : effectiveBranch,
        uploadedRate: uploadedRateNum,
        deliveredRate: deliveredRateNum,
        periodLabel: selectedPeriod.label,
        checkDateFrom,
        checkDateTo,
      })
      push?.({ variant: 'success', title: 'Billing report generated', description: `${builtRows.length} day(s) loaded.` })
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setFetching(false)
    }
  }

const totals = useMemo(() => {
    if (!rows) return null
    const totalUploadedAmount = rows.reduce((sum, r) => sum + (r.hasData ? r.subtotal : 0), 0)
    const totalDeliveredAmount = rows.reduce((sum, r) => sum + (r.hasData ? r.deliveredSubtotal : 0), 0)
    const totalNetOfVat = totalUploadedAmount + totalDeliveredAmount
    const vat = totalNetOfVat * 0.12
    return { totalUploadedAmount, totalDeliveredAmount, totalNetOfVat, vat, grandTotal: totalNetOfVat + vat }
  }, [rows])
function filenameBase() {
    const safeBank = (reportMeta?.bank || bank || 'bank').replace(/[^a-z0-9]+/gi, '_')
    const safeBranch = (reportMeta?.branchTag || 'all_branches').replace(/[^a-z0-9]+/gi, '_')
    const safePeriod = (reportMeta?.periodLabel || selectedPeriod?.label || 'period').replace(/[^a-z0-9]+/gi, '_')
    const ref = reportMeta?.referenceNumber || ''
    return `billing-report-${safeBank}-${safeBranch}-${safePeriod}${ref ? `-${ref}` : ''}`
  }
async function handleDownloadExcel() {
    if (!rows || !totals || !reportMeta) return
    setDownloading(true)
    try {
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Check Disbursement System'
      workbook.created = new Date()
      const sheet = workbook.addWorksheet('Billing Report', {
        pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
        views: [{ showGridLines: false }],
      })
      // RTS ("Volume of RTS") column removed — it was never tracked by
      // this system and existed only as a manual-entry placeholder.
      const columns = [
        { header: 'Productivity Date', width: 16 },
        { header: 'Uploaded Dispatch Soft File Volume', width: 22 },
        { header: 'Uploaded Rate', width: 14 },
        { header: 'Subtotal Amount Uploaded', width: 20 },
        { header: 'Volume of Processed Delivered', width: 20 },
        { header: 'Delivered Rate', width: 14 },
        { header: 'Subtotal Amount Delivered', width: 20 },
        { header: 'Total Amount of Billing', width: 18 },
      ]
      sheet.columns = columns.map((c) => ({ width: c.width }))

      // Letterhead logo, anchored top-right — mirrors the check reports'
      // workbook so every export produced by this page carries the same
      // branded header treatment.
      const logo = await loadLogoAssets()
      const logoBox = logo ? fitToHeight(logo, 44, 110) : null
      if (logo?.arrayBuffer && logoBox) {
        try {
          const imageId = workbook.addImage({ buffer: logo.arrayBuffer, extension: 'png' })
          const anchor = computeRightAlignedImageAnchor(columns, logoBox.width)
          sheet.addImage(imageId, { tl: anchor, ext: { width: logoBox.width, height: logoBox.height } })
        } catch (err) {
          console.warn('Could not embed logo into billing workbook:', err)
        }
      }

      const rangeLabel = reportMeta.checkDateFrom || reportMeta.checkDateTo
        ? ` · Check Dates: ${reportMeta.checkDateFrom || '—'} to ${reportMeta.checkDateTo || '—'}`
        : ''

      // Structured, multi-line letterhead (company name → report title →
      // reference no. → scope details) instead of two dense merged rows,
      // for a clearer reading order and stronger visual hierarchy.
      let r = 1
      sheet.mergeCells(r, 1, r, columns.length)
      sheet.getCell(r, 1).value = 'CREDIT SOLUTIONS & BUSINESS ALLIANCES, INC.'
      sheet.getCell(r, 1).font = { bold: true, size: 14 }
      sheet.getRow(r).height = 20
      r++

      sheet.mergeCells(r, 1, r, columns.length)
      sheet.getCell(r, 1).value = 'BILLING REPORT'
      sheet.getCell(r, 1).font = { bold: true, size: 13, color: { argb: HEADER_FILL_COLOR } }
      sheet.getRow(r).height = 18
      r++

      const detailLines = [
        { text: `Reference No: ${reportMeta.referenceNumber || '—'}`, bold: true, color: HEADER_FILL_COLOR },
        { text: `Branch: ${reportMeta.branchLabel} · Bank: ${reportMeta.bank} · Period: ${reportMeta.periodLabel}${rangeLabel}` },
        { text: `Report Date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}` },
      ]
      detailLines.forEach((line) => {
        sheet.mergeCells(r, 1, r, columns.length)
        const cell = sheet.getCell(r, 1)
        cell.value = line.text
        cell.font = { bold: !!line.bold, size: 10, color: line.color ? { argb: line.color } : undefined }
        sheet.getRow(r).height = 16
        r++
      })
      r++ // spacer row before the table

      const rowsUsedSoFar = r - 1
      const logoRowSpan = logoBox ? Math.ceil(logoBox.height / 16) + 1 : 0
      r += Math.max(0, logoRowSpan - rowsUsedSoFar)

      const headerRowIndex = r
      const headerRow = sheet.getRow(headerRowIndex)
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

      // Named indices instead of re-counted by eye — a future column
      // insertion can't silently misalign the numFmt/fill logic below.
      const MONEY_COL_INDICES = [2, 3, 5, 6, 7] // both rates, both subtotals, total (0-based)

      for (const row of rows) {
        const excelRow = sheet.getRow(r)
        const values = row.hasData
          ? [
              row.date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }),
              row.uploaded,
              row.unitCost,
              row.subtotal,
              row.released,
              row.deliveredRate,
              row.deliveredSubtotal,
              row.totalBilling,
            ]
          : [
              row.date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }),
              '', '', '', '', '', '', '',
            ]
        values.forEach((v, i) => {
          const cell = excelRow.getCell(i + 1)
          cell.value = v
          if (row.hasData && MONEY_COL_INDICES.includes(i)) cell.numFmt = '#,##0.00'
          cell.alignment = { vertical: 'middle', horizontal: i === 0 ? 'center' : i >= 2 ? 'right' : 'center' }
          cell.border = thinBorder()
          if (!row.hasData) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FUTURE_FILL_COLOR } }
          }
        })
        r++
      }

      const summaryTitleRow = r + 1
      sheet.mergeCells(summaryTitleRow, 1, summaryTitleRow, columns.length)
      sheet.getCell(summaryTitleRow, 1).value = 'BILLING SUMMARY'
      sheet.getCell(summaryTitleRow, 1).font = { bold: true, size: 11, color: { argb: HEADER_FILL_COLOR } }
      sheet.getRow(summaryTitleRow).height = 18

      const totalsStartRow = summaryTitleRow + 1
      const totalLines = [
        ['Total Amount Uploaded', totals.totalUploadedAmount],
        ['Total Amount Delivered', totals.totalDeliveredAmount],
        ['Total Net of VAT', totals.totalNetOfVat],
        ['12% VAT', totals.vat],
        ['Total Billing Amount', totals.grandTotal],
      ]
      totalLines.forEach(([label, value], i) => {
        const rowNum = totalsStartRow + i
        const row = sheet.getRow(rowNum)
        sheet.mergeCells(rowNum, 1, rowNum, columns.length - 1)
        const labelCell = row.getCell(1)
        labelCell.value = label
        labelCell.font = { bold: true }
        labelCell.alignment = { horizontal: 'right' }
        const valueCell = row.getCell(columns.length)
        valueCell.value = value
        valueCell.numFmt = '#,##0.00'
        valueCell.font = { bold: true }
        valueCell.alignment = { horizontal: 'right' }

        // Grand total gets its own visually distinct, bordered row so it
        // reads as the answer to the report, not just another line item.
        if (label === 'Total Billing Amount') {
          for (let c = 1; c <= columns.length; c++) {
            row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDFA' } }
            row.getCell(c).border = thinBorder()
          }
          labelCell.font = { bold: true, size: 12, color: { argb: HEADER_FILL_COLOR } }
          valueCell.font = { bold: true, size: 12, color: { argb: HEADER_FILL_COLOR } }
          row.height = 22
        }
      })

      // Only present when the report aggregated every branch — a second
      // table showing the same Uploaded/Delivered breakdown PER BRANCH.
      if (branchBreakdown.length > 0) {
        let br = totalsStartRow + totalLines.length + 2
        sheet.mergeCells(br, 1, br, columns.length)
        sheet.getCell(br, 1).value = `VOLUME BY BRANCH — BANK: ${reportMeta.bank}`
        sheet.getCell(br, 1).font = { bold: true, size: 11, color: { argb: HEADER_FILL_COLOR } }
        br++

        const breakdownHeaders = ['Branch', 'Uploaded Vol.', 'Uploaded Amount', 'Delivered Vol.', 'Delivered Amount', 'Total Amount']
        const breakdownHeaderRow = sheet.getRow(br)
        breakdownHeaders.forEach((h, i) => {
          const cell = breakdownHeaderRow.getCell(i + 1)
          cell.value = h
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_COLOR } }
          cell.alignment = { horizontal: 'center' }
          cell.border = thinBorder()
        })
        br++

        for (const b of branchBreakdown) {
          const row = sheet.getRow(br)
          const values = [b.branch, b.uploaded, b.uploadedAmount, b.released, b.releasedAmount, b.totalAmount]
          values.forEach((v, i) => {
            const cell = row.getCell(i + 1)
            cell.value = v
            if (i === 2 || i === 4 || i === 5) cell.numFmt = '#,##0.00'
            cell.alignment = { horizontal: i === 0 ? 'left' : 'right' }
            cell.border = thinBorder()
          })
          br++
        }
      }

      sheet.views = [{ state: 'frozen', ySplit: headerRowIndex }]

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
        reference_no: reportMeta.referenceNumber,
        bank: reportMeta.bank,
        branch: reportMeta.branchTag,
        period: reportMeta.periodLabel,
        uploaded_rate: reportMeta.uploadedRate,
        delivered_rate: reportMeta.deliveredRate,
      }).catch(() => {})
    } catch (err) {
      push?.({ variant: 'error', title: 'Download failed', description: friendlyError(err) })
    } finally {
      setDownloading(false)
    }
  }

  async function handleDownloadPdf() {
    if (!rows || !totals || !reportMeta) return
    setDownloadingPdf(true)
    try {
      const logo = await loadLogoAssets()
      const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
      const margin = 32
      const pageWidth = doc.internal.pageSize.getWidth()

      doc.setFont('helvetica', 'bold')
      doc.setFontSize(14)
      doc.setTextColor(20, 20, 20)
      doc.text('CREDIT SOLUTIONS & BUSINESS ALLIANCES, INC.', margin, 32)

      doc.setFontSize(13)
      doc.setTextColor(...BRAND_TEAL_RGB)
      doc.text('BILLING REPORT', margin, 50)

      if (logo?.dataUrl) {
        try {
          const { width: logoW, height: logoH } = fitToHeight(logo, 42, 100)
          doc.addImage(logo.dataUrl, 'PNG', pageWidth - margin - logoW, 14, logoW, logoH)
        } catch (err) {
          console.warn('Could not embed logo into billing PDF:', err)
        }
      }

      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10)
      doc.setTextColor(...BRAND_TEAL_RGB)
      doc.text(`Reference No: ${reportMeta.referenceNumber || '—'}`, margin, 66)

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(10)
      doc.setTextColor(60, 60, 60)
      const rangeLabel = reportMeta.checkDateFrom || reportMeta.checkDateTo
        ? ` · Check Dates: ${reportMeta.checkDateFrom || '—'} to ${reportMeta.checkDateTo || '—'}`
        : ''
      doc.text(
        `Branch: ${reportMeta.branchLabel} · Bank: ${reportMeta.bank} · Period: ${reportMeta.periodLabel}${rangeLabel}`,
        margin,
        80
      )

      // RTS column removed — see the Excel export note above.
      const head = [[
        'Productivity Date', 'Uploaded Vol.', 'Uploaded Rate', 'Subtotal Uploaded',
        'Delivered Vol.', 'Delivered Rate', 'Subtotal Delivered', 'Total Billing',
      ]]
      const body = rows.map((row) =>
        row.hasData
          ? [
              row.date.toLocaleDateString('en-US'),
              String(row.uploaded),
              row.unitCost.toLocaleString('en-US', { minimumFractionDigits: 2 }),
              row.subtotal.toLocaleString('en-US', { minimumFractionDigits: 2 }),
              String(row.released),
              row.deliveredRate.toLocaleString('en-US', { minimumFractionDigits: 2 }),
              row.deliveredSubtotal.toLocaleString('en-US', { minimumFractionDigits: 2 }),
              row.totalBilling.toLocaleString('en-US', { minimumFractionDigits: 2 }),
            ]
          : [row.date.toLocaleDateString('en-US'), '—', '—', '—', '—', '—', '—', '—']
      )

      autoTable(doc, {
        head,
        body,
        startY: 96,
        margin: { left: margin, right: margin },
        styles: { fontSize: 8, cellPadding: 4, lineColor: [209, 213, 219], lineWidth: 0.5, textColor: [55, 65, 81] },
        headStyles: { fillColor: BRAND_TEAL_RGB, textColor: 255, fontStyle: 'bold', halign: 'center' },
        columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' } },
        didParseCell: (data) => {
          const isFutureRow = rows[data.row.index] && !rows[data.row.index].hasData
          if (data.row.section === 'body' && isFutureRow) {
            data.cell.styles.fillColor = [243, 244, 246]
            data.cell.styles.textColor = [156, 163, 175]
          }
        },
      })

      let y = doc.lastAutoTable.finalY + 26
      doc.setDrawColor(...BRAND_TEAL_RGB)
      doc.setLineWidth(0.75)
      doc.line(margin, y, pageWidth - margin, y)
      y += 18

      doc.setFont('helvetica', 'bold')
      doc.setFontSize(11)
      doc.setTextColor(...BRAND_TEAL_RGB)
      doc.text('BILLING SUMMARY', margin, y)
      y += 18

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(10)
      doc.setTextColor(40, 40, 40)
      doc.text(`Total Amount Uploaded: ${totals.totalUploadedAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, margin, y)
      y += 16
      doc.text(`Total Amount Delivered: ${totals.totalDeliveredAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, margin, y)
      y += 16
      doc.text(`Total Net of VAT: ${totals.totalNetOfVat.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, margin, y)
      y += 16
      doc.text(`12% VAT: ${totals.vat.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, margin, y)
      y += 20

      doc.setFont('helvetica', 'bold')
      doc.setFontSize(13)
      doc.setTextColor(...BRAND_TEAL_RGB)
      doc.text(`Total Billing Amount: ${totals.grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, margin, y)
      y += 26

      if (branchBreakdown.length > 0) {
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(10)
        doc.setTextColor(...BRAND_TEAL_RGB)
        doc.text(`VOLUME BY BRANCH — BANK: ${reportMeta.bank}`, margin, y)
        autoTable(doc, {
          head: [['Branch', 'Uploaded Vol.', 'Uploaded Amount', 'Delivered Vol.', 'Delivered Amount', 'Total Amount']],
          body: branchBreakdown.map((b) => [
            b.branch,
            String(b.uploaded),
            b.uploadedAmount.toLocaleString('en-US', { minimumFractionDigits: 2 }),
            String(b.released),
            b.releasedAmount.toLocaleString('en-US', { minimumFractionDigits: 2 }),
            b.totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 }),
          ]),
          startY: y + 8,
          margin: { left: margin, right: margin },
          styles: { fontSize: 8, cellPadding: 4, lineColor: [209, 213, 219], lineWidth: 0.5, textColor: [55, 65, 81] },
          headStyles: { fillColor: BRAND_TEAL_RGB, textColor: 255, fontStyle: 'bold', halign: 'center' },
          columnStyles: { 2: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
        })
      }

      doc.save(`${filenameBase()}.pdf`)
      logAuditEvent('report_generated', {
        format: 'pdf',
        report_type: 'billing',
        reference_no: reportMeta.referenceNumber,
        bank: reportMeta.bank,
        branch: reportMeta.branchTag,
        period: reportMeta.periodLabel,
        uploaded_rate: reportMeta.uploadedRate,
        delivered_rate: reportMeta.deliveredRate,
      }).catch(() => {})
    } catch (err) {
      push?.({ variant: 'error', title: 'PDF download failed', description: friendlyError(err) })
    } finally {
      setDownloadingPdf(false)
    }
  }

 if (profileError) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      Could not load your profile: {profileError}
    </div>
  )
}
if (!profileLoading && !isAllBranches && !pickupBranch) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      Your account isn't assigned to a branch, so Reports can't determine which checks to show you.
      Please ask an admin to set your branch in your profile.
    </div>
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
        ) : (
          <>
           <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Period</label>
             <Select value={periodValue} onChange={(e) => setPeriodValue(e.target.value)}>
                  {periodOptions.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </Select>
                <p className="mt-1 text-xs text-gray-400">Shows the current half-month period plus the last 3 months.</p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Bank</label>
                <Select value={bank} onChange={(e) => setBank(e.target.value)} disabled={profileLoading}>
                  <option value="">Select bank…</option>
                  {bankOptions.map((b) => (<option key={b} value={b}>{b}</option>))}
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Branch</label>
                {isAllBranches ? (
                  <Select value={branch} onChange={(e) => setBranch(e.target.value)} disabled={profileLoading}>
                    <option value={ALL_BRANCHES_VALUE}>{ALL_BRANCHES_LABEL}</option>
                    {branchOptions.map((b) => (<option key={b} value={b}>{b}</option>))}
                  </Select>
                ) : (
                  <Select value={pickupBranch || ''} disabled>
                    <option value={pickupBranch || ''}>{pickupBranch || '—'}</option>
                  </Select>
                )}
           </div>
            </div>

            {selectedPeriod?.isCurrent && (
              <p className="flex items-center gap-1.5 rounded-md border border-teal-100 bg-teal-50/60 px-3 py-2 text-xs text-teal-800">
                <Info className="h-3.5 w-3.5 shrink-0" />
                This period is still in progress — the report will only include data up to today ({todayManilaDateInputValue()}). Later dates show as "—" until they happen.
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Uploaded rate (₱ per item)</label>
                <Input type="number" min="0" step="0.01" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder="e.g. 5.00" />
                <p className="mt-1 text-xs text-gray-400">Applied to the daily "Uploaded" volume.</p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Delivered rate (₱ per item)</label>
                <Input type="number" min="0" step="0.01" value={deliveredRate} onChange={(e) => setDeliveredRate(e.target.value)} placeholder="e.g. 7.00" />
                <p className="mt-1 text-xs text-gray-400">Applied to the daily "Delivered" volume — intentionally a different rate.</p>
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

      {rows && totals && reportMeta && (
          <>
            <p className="text-xs text-gray-500">
              Reference No: <span className="font-mono font-medium text-gray-700">{reportMeta.referenceNumber}</span>
            </p>
            <div className="overflow-auto rounded-lg border border-gray-200" style={{ maxHeight: 420 }}>
             <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 z-10">
                  <tr>
                    {['Date', 'Uploaded Vol.', 'Uploaded Rate', 'Subtotal Uploaded', 'Delivered Vol.', 'Delivered Rate', 'Subtotal Delivered', 'Total Billing'].map((h) => (
                      <th key={h} className="whitespace-nowrap border-b border-gray-200 bg-teal-600 px-3 py-2 text-left text-xs font-semibold text-white">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                {rows.map((row) => (
                    <tr
                      key={dateKey(row.date)}
                      className={
                        'border-b border-gray-100 last:border-0 ' +
                        (row.hasData ? 'even:bg-gray-50/50' : 'bg-gray-50/80 text-gray-300')
                      }
                    >
                      <td className="px-3 py-1.5 text-center">{row.date.toLocaleDateString('en-US')}</td>
                      <td className="px-3 py-1.5 text-center">{row.hasData ? row.uploaded : '—'}</td>
                      <td className="px-3 py-1.5 text-right">{row.hasData ? row.unitCost.toFixed(2) : '—'}</td>
                      <td className="px-3 py-1.5 text-right">{row.hasData ? row.subtotal.toFixed(2) : '—'}</td>
                      <td className="px-3 py-1.5 text-center">{row.hasData ? row.released : '—'}</td>
                      <td className="px-3 py-1.5 text-right">{row.hasData ? row.deliveredRate.toFixed(2) : '—'}</td>
                      <td className="px-3 py-1.5 text-right">{row.hasData ? row.deliveredSubtotal.toFixed(2) : '—'}</td>
                      <td className="px-3 py-1.5 text-right font-medium">
                        {row.hasData ? row.totalBilling.toFixed(2) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

       <p className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="inline-block h-3 w-3 rounded-sm border border-gray-300 bg-gray-100" />
              Rows shown as "—" are dates that haven't happened yet in an in-progress period — there's no data to show for them yet.
            </p>
            {branchBreakdown.length > 0 && (
              <div className="rounded-lg border border-teal-100 bg-teal-50/40 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-teal-800">
                  <Landmark className="h-3.5 w-3.5" />
                  Volume by branch — Bank: {reportMeta.bank}
                </div>
                <div className="overflow-auto rounded-md border border-teal-100 bg-white">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr>
                        {['Branch', 'Uploaded Vol.', 'Uploaded Amount', 'Delivered Vol.', 'Delivered Amount', 'Total Amount'].map((h) => (
                          <th key={h} className="whitespace-nowrap border-b border-teal-100 px-3 py-1.5 text-left font-semibold text-teal-700">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {branchBreakdown.map((b) => (
                        <tr key={b.branch} className="border-b border-gray-100 last:border-0">
                          <td className="px-3 py-1.5">{b.branch}</td>
                          <td className="px-3 py-1.5 text-right">{b.uploaded}</td>
                          <td className="px-3 py-1.5 text-right">{formatCurrency(b.uploadedAmount)}</td>
                          <td className="px-3 py-1.5 text-right">{b.released}</td>
                          <td className="px-3 py-1.5 text-right">{formatCurrency(b.releasedAmount)}</td>
                          <td className="px-3 py-1.5 text-right font-medium">{formatCurrency(b.totalAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-teal-100 bg-teal-50/30 p-4 text-sm">
              <div className="space-y-0.5 text-gray-700">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-teal-700">Billing Summary</div>
                <div>Total Amount Uploaded: <span className="font-semibold">{formatCurrency(totals.totalUploadedAmount)}</span></div>
                <div>Total Amount Delivered: <span className="font-semibold">{formatCurrency(totals.totalDeliveredAmount)}</span></div>
                <div>Total Net of VAT: <span className="font-semibold">{formatCurrency(totals.totalNetOfVat)}</span></div>
                <div>12% VAT: <span className="font-semibold">{formatCurrency(totals.vat)}</span></div>
                <div className="mt-1 text-base">Total Billing Amount: <span className="font-bold text-teal-700">{formatCurrency(totals.grandTotal)}</span></div>
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

// Page wrapper — the only new part. Everything above is BillingReport,
// unmodified from src/pages/admin/AdminReports.jsx.
export default function ApproverBillingReport() {
  return (
    <div className="w-full space-y-6 pb-12">
      <div className="px-1">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Billing Report</h1>
        <p className="text-sm text-gray-500">
          Generate the same half-month billing breakdown available in Admin Reports — preview it, then
          download as Excel or PDF.
        </p>
      </div>
      <BillingReport />
    </div>
  )
}