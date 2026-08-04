// src/lib/staleCheckReportDocument.js
//
// Single source of truth for rendering the stale/unreleased-check
// transmittal as PDF (jsPDF + autotable) or Excel (ExcelJS). Shared by
// StaleWatchPanel.jsx (renders right after generation), StaleReportHistory.jsx
// (re-renders a past transmittal on demand), AND AdminReports.jsx's "Generate
// Transmittal" action on the Unreleased Reports tab — all three call
// buildStaleCheckReportPdf / buildStaleCheckReportWorkbook directly rather
// than maintaining their own copies, so a transmittal looks identical no
// matter which screen produced it.
//
// reportNumber (passed in via docArgs) should always come from
// generateReportReferenceNumber() in ./reportReference.js — that's the
// single place the CSBAPQL/CSBABGC-SCR-<bank>-<date>-<random> format is
// defined, so every transmittal, wherever it's generated, carries the same
// reference-number shape.
//
// Required packages: npm install exceljs jspdf jspdf-autotable

import ExcelJS from 'exceljs'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { formatCurrency, formatDate } from './utils'

const UNSPECIFIED_BRANCH = 'No branch on file'
const UNSPECIFIED_BANK = 'Unspecified bank'
const PAGE_MARGIN = 40
const STALE_FIXED_MONTHS = 6

const COMPANY_NAME = 'CREDIT SOLUTIONS & BUSINESS ALLIANCES, INC.'
const REPORT_SUBTITLE = 'Check Transmittal — Stale / Unreleased Checks Return to Bank'
const LOGO_URL = '/logo.png'
const GENERATED_BY_ROLE = 'Verifier'
const BRAND_TEAL_RGB = [13, 148, 136]
const HEADER_FILL_ARGB = 'FF0D9488'
const SECTION_FILL_ARGB = 'FFF0FDFA'
const BORDER_ARGB = 'FFD1D5DB'

// Per-copy accent so "CSBA's Copy" and "Bank's Copy" are distinguishable
// at a glance — by color, not just by tiny text — in both the PDF badge
// and Excel header/watermark. Teal matches the existing brand color;
// amber is a deliberately different hue (not just a shade of teal) so
// the two stay distinct even for color-blind readers relying on
// lightness contrast, and both remain in fully legible.
const CSBA_COPY_ACCENT = { rgb: BRAND_TEAL_RGB, solidArgb: HEADER_FILL_ARGB, tintArgb: 'FFE3F3F1' }
const BANK_COPY_ACCENT = { rgb: [180, 95, 6], solidArgb: 'FFB45F06', tintArgb: 'FFFBEEDC' }

function getCopyAccent(copyLabel) {
  return /CSBA/i.test(copyLabel || '') ? CSBA_COPY_ACCENT : BANK_COPY_ACCENT
}
// Cached at module level so re-rendering several transmittals in one
// session never refetches the same image. A missing logo is cosmetic —
// every caller falls back to a logo-less layout rather than failing.
// NOTE: intentionally logo-only — no per-bank logo is loaded or drawn
// anywhere in this module, on either the PDF or the Excel output.
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
      canvas.getContext('2d').drawImage(img, 0, 0, width, height)
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

// Shrinks a bold font just enough for `text` to fit on a SINGLE line
// within maxWidth. Used for the header company name, which previously
// wrapped to a second line whenever `text` didn't fit — and that second
// line landed on top of the subtitle below it. Auto-shrinking keeps the
// full name on one line and readable, rather than letting it wrap or
// get clipped.
function fitSingleLineFontSize(doc, text, maxWidth, startSize, minSize) {
  let size = startSize
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(size)
  while (size > minSize && doc.getTextWidth(text) > maxWidth) {
    size -= 0.5
    doc.setFontSize(size)
  }
  return size
}

let _logoAssetPromise = null
function loadLogoAsset() {
  if (!_logoAssetPromise) _logoAssetPromise = loadImageAsset(LOGO_URL)
  return _logoAssetPromise
}

function branchOf(row) {
  return row?.pickup_branch || UNSPECIFIED_BRANCH
}

function bankOf(row) {
  return row?.bank || UNSPECIFIED_BANK
}

function getClientName(row) {
  return row?.payor || ''
}

function summarizeClientLabel(rows) {
  const distinct = [...new Set((rows || []).map(getClientName).filter(Boolean))]
  return distinct.length === 1 ? distinct[0] : 'Multiple / All Clients'
}

function sortableKey(key) {
  return key.startsWith(UNSPECIFIED_BRANCH) || key.startsWith(UNSPECIFIED_BANK) ? `\uffff${key}` : key
}

function formatDateTimeSafe(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

function daysBetween(checkDate) {
  if (!checkDate) return null
  const start = new Date(checkDate)
  const end = new Date()
  start.setHours(0, 0, 0, 0)
  end.setHours(0, 0, 0, 0)
  return Math.max(0, Math.round((end - start) / 86400000))
}

export function findInvalidBankOrLocationMix(rows) {
  const banks = new Set((rows || []).map(bankOf))
  const locations = new Set((rows || []).map(branchOf))
  if (banks.size > 1) {
    return `Selected checks span ${banks.size} different banks (${[...banks].join(', ')}). A transmittal report must be for a single bank only.`
  }
  if (locations.size > 1) {
    return `Selected checks span ${locations.size} different CSBA locations (${[...locations].join(', ')}). A transmittal report must be for a single location only.`
  }
  return null
}

function groupRowsByBranch(rows) {
  const byBranch = new Map()
  for (const row of rows || []) {
    const branch = branchOf(row)
    if (!byBranch.has(branch)) byBranch.set(branch, [])
    byBranch.get(branch).push(row)
  }

  return [...byBranch.keys()]
    .sort((a, b) => sortableKey(a).localeCompare(sortableKey(b)))
    .map((branch) => {
      const branchRows = byBranch.get(branch).slice().sort((a, b) => new Date(a.check_date) - new Date(b.check_date))
      return {
        branch,
        bank: bankOf(branchRows[0]),
        rows: branchRows,
        count: branchRows.length,
        amount: branchRows.reduce((sum, r) => sum + Number(r.amount || 0), 0),
      }
    })
}

function summarizeByBank(rows) {
  const map = new Map()
  for (const row of rows || []) {
    const bank = bankOf(row)
    if (!map.has(bank)) map.set(bank, { bank, count: 0, amount: 0 })
    const entry = map.get(bank)
    entry.count += 1
    entry.amount += Number(row.amount || 0)
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount)
}

function computeTotals(rows) {
  return {
    count: (rows || []).length,
    amount: (rows || []).reduce((sum, r) => sum + Number(r.amount || 0), 0),
  }
}

/**
 * @param {{
 *   reportNumber: string,   // from generateReportReferenceNumber() in ./reportReference.js
 *   generatedAt: string|Date|null,
 *   generatedByName: string|null,
 *   submittedAt: string|Date|null,
 *   submittedByName: string|null,
 *   status: 'generated'|'submitted',
 *   rows: Array<object>,
 * }} docArgs
 * @returns {Promise<import('jspdf').jsPDF>}
 */
// Renders one full copy of the transmittal onto whatever page of `doc`
// is currently active — header with logo, a detail card, the check
// table, an aging/grand-total bar, and a wet-ink signature block with
// blank date fields. Called twice by buildStaleCheckReportPdf: once
// labeled BANK'S COPY, once labeled COMPANY COPY, so both stay
// pixel-identical apart from the corner badge. The page footer
// (generated-by + transmittal number + page count) is added once,
// after both copies exist, by buildStaleCheckReportPdf itself.
async function renderCopy(doc, docArgs, copyLabel) {
  const { reportNumber, generatedAt, generatedByName, rows } = docArgs

  const margin = PAGE_MARGIN
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()

  const grouped = groupRowsByBranch(rows)
  const totals = computeTotals(rows)
  const bankBreakdown = summarizeByBank(rows)
  const clientLabel = summarizeClientLabel(rows)
  const pickupLocation = rows?.[0] ? branchOf(rows[0]) : '—'

  // ---- Header: logo + full company name + subtitle -------------------
  const logo = await loadLogoAsset()
  const logoBox = logo ? fitToHeight(logo, 46, 120) : null
  if (logo?.dataUrl && logoBox) {
    try {
      doc.addImage(logo.dataUrl, 'PNG', margin, 24, logoBox.width, logoBox.height)
    } catch (err) {
      console.warn('Could not embed logo into stale check transmittal:', err)
    }
  }
  const textX = margin + (logoBox ? logoBox.width + 14 : 0)

  // Copy accent (teal = CSBA's Copy, amber = Bank's Copy) — used only
  // to tint the watermark now, since that's the sole way the two
  // copies are told apart.
  const accent = getCopyAccent(copyLabel)

  // Title: sized as large as possible while still fitting on ONE line.
  // A wrapped second line would land on the subtitle's fixed y position
  // below it and silently blot out "...Unreleased Checks...", so rather
  // than a fixed size, the font is auto-shrunk down from a large
  // starting point until "CREDIT SOLUTIONS & BUSINESS ALLIANCES, INC."
  // fits the page width in full, on one line.
  const titleMaxWidth = pageWidth - margin - textX - 16
  const titleSize = fitSingleLineFontSize(doc, COMPANY_NAME, titleMaxWidth, 20, 12)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(titleSize)
  doc.setTextColor(17, 24, 22)
  doc.text(COMPANY_NAME, textX, 38)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9.5)
  doc.setTextColor(100, 105, 103)
  doc.text(REPORT_SUBTITLE, textX, 53, { maxWidth: pageWidth - margin - textX - 16 })

  // ---- Copy-distinction watermark: repeated diagonal stamps down the
  // page (top / middle / bottom) rather than a single center stamp, so
  // the copy is unmistakable no matter which part of the page someone
  // is looking at, and colored per copy (teal = CSBA's Copy, amber =
  // Bank's Copy) so the two are distinguishable even under grayscale
  // printing/scanning. -----------------------------------------------
  const watermarkLabel = copyLabel.toUpperCase()
  const watermarkYPositions = [pageHeight * 0.2, pageHeight * 0.5, pageHeight * 0.82]
  doc.saveGraphicsState()
  doc.setGState(new doc.GState({ opacity: 0.12 }))
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(58)
  doc.setTextColor(...accent.rgb)
  watermarkYPositions.forEach((wy) => {
    doc.text(watermarkLabel, pageWidth / 2, wy, { align: 'center', angle: 35 })
  })
  doc.restoreGraphicsState()

  let y = Math.max(24 + (logoBox?.height || 0) + 16, 72)
  doc.setDrawColor(...BRAND_TEAL_RGB)
  doc.setLineWidth(1.2)
  doc.line(margin, y, pageWidth - margin, y)
  y += 22

  // ---- Detail card: label-over-value grid, two columns ----------------
  const contentWidth = pageWidth - margin * 2
  const cardTop = y
  const cardPadding = 12
  const colGap = 18
  const colWidth = (contentWidth - colGap) / 2
  const rowHeight = 30

  const details = [
    ['TRANSMITTAL NO.', reportNumber],
    ['DATE GENERATED', formatDateTimeSafe(generatedAt || new Date())],
    ['CLIENT / PAYOR', clientLabel],
    ['BANK', bankBreakdown.map((b) => b.bank).join(', ') || 'None'],
    ['PICKUP LOCATION', pickupLocation],
    ['TOTAL CHECKS', String(totals.count)],
  ]
  const cardHeight = cardPadding * 2 + rowHeight * Math.ceil(details.length / 2)

  doc.setFillColor(...(SECTION_FILL_ARGB ? [240, 253, 250] : [246, 246, 246]))
  doc.roundedRect(margin, cardTop, contentWidth, cardHeight, 5, 5, 'F')

  details.forEach(([label, value], idx) => {
    const col = idx % 2
    const row = Math.floor(idx / 2)
    const cellX = margin + cardPadding + col * (colWidth + colGap)
    const cellY = cardTop + cardPadding + row * rowHeight

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7.5)
    doc.setTextColor(120, 128, 125)
    doc.text(label, cellX, cellY + 9)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10.5)
    doc.setTextColor(24, 30, 28)
    doc.text(String(value), cellX, cellY + 22, { maxWidth: colWidth - 4 })
  })

  y = cardTop + cardHeight + 26

  // ---- Per-bank table (report is single-bank, but the shared grouping
  // helper still keys by branch, which is now guaranteed to resolve to
  // exactly one bank/location per the report-generation rule) ----------
  let grandTotal = 0
  grouped.forEach((group) => {
    if (y > pageHeight - 170) {
      doc.addPage()
      y = 40
    }

    doc.setFillColor(...BRAND_TEAL_RGB)
    doc.rect(margin, y - 12, 3, 26, 'F')

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11.5)
    doc.setTextColor(...BRAND_TEAL_RGB)
    doc.text(`RETURN TO: ${group.bank.toUpperCase()}`, margin + 10, y)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(120, 120, 120)
    doc.text(`Branch: ${group.branch}`, margin + 10, y + 13)

    y += 26

    const head = [['No', 'Check No.', 'Payee', 'Client Name', 'Check Date', 'Aging (Days)', 'Amount']]
    let sectionTotal = 0
    const body = group.rows.map((row, idx) => {
      sectionTotal += Number(row.amount || 0)
      return [
        String(idx + 1),
        row.check_no || '—',
        row.payee || '—',
        getClientName(row) || '—',
        row.check_date ? formatDate(row.check_date) : '—',
        String(daysBetween(row.check_date) ?? '—'),
        Number(row.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      ]
    })
    body.push(['', '', '', '', '', 'Subtotal', sectionTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })])
    grandTotal += sectionTotal
    const subtotalRowIndex = body.length - 1

    autoTable(doc, {
      head,
      body,
      startY: y,
      margin: { left: margin, right: margin },
      styles: { fontSize: 8, cellPadding: 4.5, textColor: [55, 65, 81], lineColor: [222, 226, 224], lineWidth: 0.5 },
      headStyles: { fillColor: BRAND_TEAL_RGB, textColor: 255, fontStyle: 'bold', halign: 'center', fontSize: 8 },
      alternateRowStyles: { fillColor: [250, 251, 250] },
      columnStyles: { 0: { halign: 'center' }, 4: { halign: 'center' }, 5: { halign: 'center' }, 6: { halign: 'right' } },
      didParseCell: (data) => {
        if (data.row.section === 'body' && data.row.index === subtotalRowIndex) {
          data.cell.styles.fontStyle = 'bold'
          data.cell.styles.fillColor = [240, 253, 250]
        }
      },
    })
    y = doc.lastAutoTable.finalY + 24
  })

  // ---- Totals bar: aging threshold on the left, grand total on the
  // right, same line, visually anchored with a filled bar ---------------
  if (y > pageHeight - 160) {
    doc.addPage()
    y = 60
  }

  const barHeight = 30
  doc.setFillColor(240, 253, 250)
  doc.rect(margin, y, contentWidth, barHeight, 'F')
  doc.setDrawColor(...BRAND_TEAL_RGB)
  doc.setLineWidth(0.75)
  doc.line(margin, y, pageWidth - margin, y)
  doc.line(margin, y + barHeight, pageWidth - margin, y + barHeight)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.setTextColor(90, 96, 94)
  doc.text(`Aging threshold: ${STALE_FIXED_MONTHS}+ months from check date (fixed)`, margin + 10, y + barHeight / 2 + 3)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(17, 24, 22)
  doc.text(
    `GRAND TOTAL: PHP ${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    pageWidth - margin - 10,
    y + barHeight / 2 + 4,
    { align: 'right' },
  )

  y += barHeight + 44

  // ---- Signature block: wet-ink note, two signature lines, blank date
  // line under each ------------------------------------------------------
  if (y > pageHeight - 110) {
    doc.addPage()
    y = 60
  }

  doc.setFont('helvetica', 'italic')
  doc.setFontSize(7.5)
  doc.setTextColor(140, 140, 140)
  doc.text('Original wet-ink signatures required — not valid with a reproduced or digital signature.', margin, y)
  y += 22

  const sigY = y
  doc.setDrawColor(90, 90, 90)
  doc.setLineWidth(0.75)
  doc.line(margin, sigY, margin + 200, sigY)
  doc.line(pageWidth - margin - 200, sigY, pageWidth - margin, sigY)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(60, 60, 60)
  doc.text('Prepared by / Signature over printed name', margin, sigY + 13)
  doc.text('Received by (Bank Representative)', pageWidth - margin - 200, sigY + 13)

  const dateLineY = sigY + 38
  doc.line(margin, dateLineY, margin + 130, dateLineY)
  doc.line(pageWidth - margin - 130, dateLineY, pageWidth - margin, dateLineY)
  doc.setFontSize(8)
  doc.setTextColor(120, 120, 120)
  doc.text('Date', margin, dateLineY + 12)
  doc.text('Date', pageWidth - margin - 130, dateLineY + 12)
}

/**
 * @param {{
 *   reportNumber: string,   // from generateReportReferenceNumber() in ./reportReference.js
 *   generatedAt: string|Date|null,
 *   generatedByName: string|null,
 *   submittedAt: string|Date|null,
 *   submittedByName: string|null,
 *   status: 'generated'|'submitted',
 *   rows: Array<object>,
 * }} docArgs
 * @returns {Promise<import('jspdf').jsPDF>}
 */
export async function buildStaleCheckReportPdf(docArgs) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' })

await renderCopy(doc, docArgs, "CSBA'S COPY")
  doc.addPage()
  await renderCopy(doc, docArgs, "BANK'S COPY")
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const pageCount = doc.internal.getNumberOfPages()
  const { reportNumber, generatedByName, submittedAt, submittedByName } = docArgs

  const footerLine =
    `Generated by ${generatedByName || '—'} (${GENERATED_BY_ROLE})  ·  Transmittal ${reportNumber}` +
    (submittedAt ? `  ·  Submitted ${formatDateTimeSafe(submittedAt)} by ${submittedByName || '—'}` : '')

  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p)
    doc.setDrawColor(225, 228, 226)
    doc.setLineWidth(0.5)
    doc.line(PAGE_MARGIN, pageHeight - 34, pageWidth - PAGE_MARGIN, pageHeight - 34)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(140, 140, 140)
    doc.text(footerLine, PAGE_MARGIN, pageHeight - 20, { maxWidth: pageWidth - PAGE_MARGIN * 2 - 60 })

    doc.text(`Page ${p} of ${pageCount}`, pageWidth - PAGE_MARGIN, pageHeight - 20, { align: 'right' })
  }

  return doc
}

function thinBorder() {
  return {
    top: { style: 'thin', color: { argb: BORDER_ARGB } },
    left: { style: 'thin', color: { argb: BORDER_ARGB } },
    bottom: { style: 'thin', color: { argb: BORDER_ARGB } },
    right: { style: 'thin', color: { argb: BORDER_ARGB } },
  }
}

/**
 * @param {{
 *   reportNumber: string,   // from generateReportReferenceNumber() in ./reportReference.js
 *   generatedAt: string|Date|null,
 *   generatedByName: string|null,
 *   submittedAt: string|Date|null,
 *   submittedByName: string|null,
 *   status: 'generated'|'submitted',
 *   rows: Array<object>,
 * }} docArgs
 * @returns {Promise<ExcelJS.Workbook>}
 */
// Renders one full copy onto a given worksheet — mirrors renderCopy's
// PDF layout: full company name + logo, a detail grid, per-bank table,
// an aging/grand-total row, and a wet-ink signature block with blank
// date rows. Called twice so "Bank's Copy" and "Company Copy" are
// identical sheets under different tab names.
function renderWorkbookCopy(sheet, docArgs, copyLabel, logoAsset) {
  const { reportNumber, generatedAt, generatedByName, submittedAt, submittedByName, rows } = docArgs
  const grouped = groupRowsByBranch(rows)
  const bankBreakdown = summarizeByBank(rows)
  const totals = computeTotals(rows)
  const clientLabel = summarizeClientLabel(rows)
  const pickupLocation = rows?.[0] ? branchOf(rows[0]) : '—'

  const COL_COUNT = 7
  sheet.columns = [{ width: 5 }, { width: 16 }, { width: 28 }, { width: 22 }, { width: 14 }, { width: 13 }, { width: 16 }]

  const logoBox = logoAsset ? fitToHeight(logoAsset, 40, 100) : null
  const headerStartCol = logoBox ? 2 : 1
  if (logoAsset?.arrayBuffer && logoBox) {
    try {
      const imageId = sheet.workbook.addImage({ buffer: logoAsset.arrayBuffer, extension: 'png' })
      sheet.addImage(imageId, { tl: { col: 0.1, row: 0.15 }, ext: { width: logoBox.width, height: logoBox.height } })
    } catch (err) {
      console.warn('Could not embed logo into stale check transmittal workbook:', err)
    }
  }

  function addHeader(rowNum, text, style = {}) {
    sheet.mergeCells(rowNum, headerStartCol, rowNum, COL_COUNT)
    const cell = sheet.getRow(rowNum).getCell(headerStartCol)
    cell.value = text
    cell.font = { bold: !!style.bold, italic: !!style.italic, size: style.size || 10, color: style.color ? { argb: style.color } : undefined }
    cell.alignment = { vertical: 'middle', horizontal: 'left' }
  }

  // Same accent used by the PDF badge (teal = CSBA's Copy, amber =
  // Bank's Copy) so both formats distinguish copies the same way.
  const accent = getCopyAccent(copyLabel)

  let r = 1
  addHeader(r, COMPANY_NAME, { bold: true, size: 14 }); r += 1
  addHeader(r, `CHECK TRANSMITTAL — ${copyLabel}`, { bold: true, size: 12.5, color: accent.solidArgb }); r += 1
  addHeader(r, REPORT_SUBTITLE, { size: 9, color: 'FF64716E' }); r += 1
  r += 1
// Excel equivalent of the PDF's diagonal watermark: a rotated label in
  // a merged strip, tinted to match this copy's accent color. ExcelJS
  // can't render true page-background watermarks, so this is the
  // closest visual analogue.
  sheet.mergeCells(r, 1, r + 3, COL_COUNT)
  const watermarkCell = sheet.getCell(r, 1)
  watermarkCell.value = copyLabel.toUpperCase()
  watermarkCell.font = { bold: true, size: 36, color: { argb: accent.tintArgb } }
  watermarkCell.alignment = { vertical: 'middle', horizontal: 'center', textRotation: 35 }
  r += 4
  const rowsUsedSoFar = r - 1
  const logoRowSpan = logoBox ? Math.ceil(logoBox.height / 15) + 1 : 0
  r += Math.max(0, logoRowSpan - rowsUsedSoFar)

  // Detail grid — two label/value pairs per row
  const details = [
    ['TRANSMITTAL NO.', reportNumber],
    ['DATE GENERATED', formatDateTimeSafe(generatedAt || new Date())],
    ['CLIENT / PAYOR', clientLabel],
    ['BANK', bankBreakdown.map((b) => b.bank).join(', ') || 'None'],
    ['PICKUP LOCATION', pickupLocation],
    ['TOTAL CHECKS', String(totals.count)],
  ]
  for (let i = 0; i < details.length; i += 2) {
    const labelRow = sheet.getRow(r)
    const valueRow = sheet.getRow(r + 1)
    const pairs = [details[i], details[i + 1]].filter(Boolean)
    pairs.forEach(([label, value], idx) => {
      const startCol = idx === 0 ? 1 : 4
      labelRow.getCell(startCol).value = label
      labelRow.getCell(startCol).font = { bold: true, size: 7.5, color: { argb: 'FF788079' } }
      valueRow.getCell(startCol).value = value
      valueRow.getCell(startCol).font = { bold: true, size: 10.5, color: { argb: 'FF181E1C' } }
    })
    r += 3
  }
  r += 1

  grouped.forEach((group) => {
    sheet.mergeCells(r, 1, r, COL_COUNT)
    const sectionCell = sheet.getCell(r, 1)
    sectionCell.value = `RETURN TO: ${group.bank.toUpperCase()}   ·   Branch: ${group.branch}   (${group.count} check${group.count === 1 ? '' : 's'} · ${formatCurrency(group.amount)})`
    sectionCell.font = { bold: true, size: 11, color: { argb: HEADER_FILL_ARGB } }
    sectionCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SECTION_FILL_ARGB } }
    sectionCell.alignment = { vertical: 'middle' }
    r += 1

    const headerRow = sheet.getRow(r)
    ;['#', 'Check No.', 'Payee', 'Client Name', 'Check Date', 'Aging (Days)', 'Amount'].forEach((h, i) => {
      const cell = headerRow.getCell(i + 1)
      cell.value = h
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_ARGB } }
      cell.alignment = { vertical: 'middle', horizontal: i === 0 || i === 4 || i === 5 ? 'center' : i === 6 ? 'right' : 'left' }
      cell.border = thinBorder()
    })
    headerRow.height = 20
    r += 1

    group.rows.forEach((row, idx) => {
      const dataRow = sheet.getRow(r)
      const cells = [
        { value: idx + 1, align: 'center' },
        { value: row.check_no || '—', align: 'center' },
        { value: row.payee || '—' },
        { value: getClientName(row) || '—' },
        { value: row.check_date ? new Date(row.check_date) : null, numFmt: 'mm/dd/yyyy', align: 'center' },
        { value: daysBetween(row.check_date) ?? '', align: 'center' },
        { value: Number(row.amount || 0), numFmt: '#,##0.00', align: 'right' },
      ]
      cells.forEach((c, i) => {
        const cell = dataRow.getCell(i + 1)
        cell.value = c.value
        if (c.numFmt) cell.numFmt = c.numFmt
        cell.alignment = { vertical: 'middle', horizontal: c.align || 'left' }
        cell.border = thinBorder()
      })
      r += 1
    })

    const subtotalRow = sheet.getRow(r)
    for (let c = 1; c <= COL_COUNT; c++) subtotalRow.getCell(c).border = thinBorder()
    sheet.mergeCells(r, 1, r, 6)
    subtotalRow.getCell(1).value = 'Subtotal'
    subtotalRow.getCell(1).font = { bold: true }
    subtotalRow.getCell(1).alignment = { horizontal: 'right' }
    subtotalRow.getCell(7).value = group.amount
    subtotalRow.getCell(7).numFmt = '#,##0.00'
    subtotalRow.getCell(7).font = { bold: true }
    subtotalRow.getCell(7).alignment = { horizontal: 'right' }
    r += 2
  })

  // Aging threshold (left) + grand total (right), same row
  const totalsRow = sheet.getRow(r)
  totalsRow.getCell(1).value = `Aging threshold: ${STALE_FIXED_MONTHS}+ months from check date (fixed)`
  totalsRow.getCell(1).font = { size: 8.5, color: { argb: 'FF5A605E' } }
  sheet.mergeCells(r, 1, r, 4)

  sheet.mergeCells(r, 5, r, 6)
  totalsRow.getCell(5).value = 'GRAND TOTAL'
  totalsRow.getCell(5).font = { bold: true, size: 11 }
  totalsRow.getCell(5).alignment = { horizontal: 'right' }
  totalsRow.getCell(7).value = totals.amount
  totalsRow.getCell(7).numFmt = '#,##0.00'
  totalsRow.getCell(7).font = { bold: true, size: 11, color: { argb: HEADER_FILL_ARGB } }
  totalsRow.getCell(7).alignment = { horizontal: 'right' }
  r += 3

  // Wet-ink note
  sheet.mergeCells(r, 1, r, COL_COUNT)
  sheet.getCell(r, 1).value = 'Original wet-ink signatures required — not valid with a reproduced or digital signature.'
  sheet.getCell(r, 1).font = { italic: true, size: 7.5, color: { argb: 'FF8C8C8C' } }
  r += 2

  // Signature lines
  sheet.getCell(r, 1).value = '_________________________________'
  sheet.getCell(r, 5).value = '_________________________________'
  r += 1
  sheet.getCell(r, 1).value = 'Prepared by / Signature over printed name'
  sheet.getCell(r, 1).font = { size: 9, color: { argb: 'FF3C3C3C' } }
  sheet.getCell(r, 5).value = 'Received by (Bank Representative)'
  sheet.getCell(r, 5).font = { size: 9, color: { argb: 'FF3C3C3C' } }
  r += 2

  // Date lines
  sheet.getCell(r, 1).value = '_________________'
  sheet.getCell(r, 5).value = '_________________'
  r += 1
  sheet.getCell(r, 1).value = 'Date'
  sheet.getCell(r, 1).font = { size: 8, color: { argb: 'FF828282' } }
  sheet.getCell(r, 5).value = 'Date'
  sheet.getCell(r, 5).font = { size: 8, color: { argb: 'FF828282' } }
  r += 2

  // Second watermark strip near the bottom of the sheet — same
  // treatment as the header one, so the copy is unmistakable whether
  // someone scrolls to the top or the bottom of a long report.
  sheet.mergeCells(r, 1, r + 3, COL_COUNT)
  const bottomWatermarkCell = sheet.getCell(r, 1)
  bottomWatermarkCell.value = copyLabel.toUpperCase()
  bottomWatermarkCell.font = { bold: true, size: 36, color: { argb: accent.tintArgb } }
  bottomWatermarkCell.alignment = { vertical: 'middle', horizontal: 'center', textRotation: 35 }
  r += 5

  // Footer: generated by (with role) inline with transmittal number
  sheet.mergeCells(r, 1, r, COL_COUNT)
  const footerCell = sheet.getCell(r, 1)
  footerCell.value =
    `Generated by ${generatedByName || '—'} (${GENERATED_BY_ROLE})  ·  Transmittal ${reportNumber}` +
    (submittedAt ? `  ·  Submitted ${formatDateTimeSafe(submittedAt)} by ${submittedByName || '—'}` : '')
  footerCell.font = { size: 7.5, color: { argb: 'FF8C8C8C' } }
}

/**
 * @param {{
 *   reportNumber: string,   // from generateReportReferenceNumber() in ./reportReference.js
 *   generatedAt: string|Date|null,
 *   generatedByName: string|null,
 *   submittedAt: string|Date|null,
 *   submittedByName: string|null,
 *   status: 'generated'|'submitted',
 *   rows: Array<object>,
 * }} docArgs
 * @returns {Promise<ExcelJS.Workbook>}
 */
export async function buildStaleCheckReportWorkbook(docArgs) {
  const logo = await loadLogoAsset()

  const workbook = new ExcelJS.Workbook()
  workbook.creator = COMPANY_NAME
  workbook.created = new Date()
const csbaSheet = workbook.addWorksheet("CSBA's Copy", {
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1 },
    views: [{ showGridLines: false }],
  })
  renderWorkbookCopy(csbaSheet, docArgs, "CSBA'S COPY", logo)

  const bankSheet = workbook.addWorksheet("Bank's Copy", {
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1 },
    views: [{ showGridLines: false }],
  })
  renderWorkbookCopy(bankSheet, docArgs, "BANK'S COPY", logo)

  return workbook
}
