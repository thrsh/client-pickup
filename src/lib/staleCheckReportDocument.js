// src/lib/staleCheckReportDocument.js
//
// Single source of truth for rendering the stale/unreleased-check
// transmittal as PDF (jsPDF + autotable) or Excel (ExcelJS). Shared by
// StaleWatchPanel.jsx (renders right after generation) and
// StaleReportHistory.jsx (re-renders a past transmittal on demand), so
// a reopened transmittal is structurally identical to the original.
//
// Layout parity with buildTransmittalPdf() in AdminReports.jsx: same
// header (logo + company name + subtitle), same Details block order
// (Transmittal No -> Date Generated -> Client / Payor -> Banks
// Included -> Total Checks / Grand Total / Aging threshold), same
// "RETURN TO: <BANK>" section heading with a "Branch: X" caption, same
// table columns, same subtotal/grand total treatment, same signature
// block. Panel-specific metadata (generated-by, submission status) is
// a small gray footnote so it never competes with the shared block.
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

const BRAND_TEAL_RGB = [13, 148, 136]
const HEADER_FILL_ARGB = 'FF0D9488'
const SECTION_FILL_ARGB = 'FFF0FDFA'
const BORDER_ARGB = 'FFD1D5DB'

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

// Cached at module level so re-rendering several transmittals in one
// session never refetches the same image. A missing logo is cosmetic —
// every caller falls back to a logo-less layout rather than failing.
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

let _logoAssetPromise = null
function loadLogoAsset() {
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

function statusLabel(status) {
  return status === 'submitted' ? 'Submitted for approval' : 'Generated'
}

/**
 * The transmittal format requires each branch section to map to
 * exactly one bank. Returns a human-readable error naming the
 * offending branch and its banks, or null when the rule holds.
 */
export function findMixedBankBranch(rows) {
  const banksByBranch = new Map()
  for (const row of rows || []) {
    const branch = branchOf(row)
    if (!banksByBranch.has(branch)) banksByBranch.set(branch, new Set())
    banksByBranch.get(branch).add(bankOf(row))
  }
  for (const [branch, banks] of banksByBranch) {
    if (banks.size > 1) {
      return `"${branch}" has checks from ${banks.size} different banks (${[...banks].join(', ')}). Select checks from only one bank per branch.`
    }
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
 *   reportNumber: string,
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
  const { reportNumber, generatedAt, generatedByName, submittedAt, submittedByName, status, rows } = docArgs

  const logo = await loadLogoAsset()
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' })
  const margin = PAGE_MARGIN
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()

  const grouped = groupRowsByBranch(rows)
  const totals = computeTotals(rows)
  const bankBreakdown = summarizeByBank(rows)
  const clientLabel = summarizeClientLabel(rows)

  const distinctBanks = [...new Set(grouped.map((g) => g.bank))]
  const bankLogoByName = new Map(await Promise.all(distinctBanks.map(async (bank) => [bank, await loadBankLogoAsset(bank)])))

  const logoBox = logo ? fitToHeight(logo, 52, 130) : null
  if (logo?.dataUrl && logoBox) {
    try {
      doc.addImage(logo.dataUrl, 'PNG', margin, 28, logoBox.width, logoBox.height)
    } catch (err) {
      console.warn('Could not embed logo into stale check transmittal:', err)
    }
  }
  const textX = margin + (logoBox ? logoBox.width + 16 : 0)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.setTextColor(20, 20, 20)
  doc.text(COMPANY_NAME, textX, 46, { maxWidth: pageWidth - margin - textX })

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(90, 90, 90)
  doc.text(REPORT_SUBTITLE, textX, 62, { maxWidth: pageWidth - margin - textX })

  let y = Math.max(28 + (logoBox?.height || 0) + 16, 90)
  doc.setDrawColor(...BRAND_TEAL_RGB)
  doc.setLineWidth(1)
  doc.line(margin, y, pageWidth - margin, y)
  y += 20

  const banksLabel = bankBreakdown.map((b) => b.bank).join(', ') || 'None'
  const contentWidth = pageWidth - margin * 2

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(20, 20, 20)
  doc.text(`Transmittal No: ${reportNumber}`, margin, y)
  doc.text(`Date Generated: ${formatDateTimeSafe(generatedAt || new Date())}`, margin, y + 16)

  doc.setFont('helvetica', 'normal')
  doc.text(`Client / Payor: ${clientLabel}`, margin, y + 32, { maxWidth: contentWidth })
  doc.text(`Banks Included: ${banksLabel}`, margin, y + 48, { maxWidth: contentWidth })
  doc.text(
    `Total Checks: ${totals.count}  ·  Grand Total: PHP ${totals.amount.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}  ·  Aging threshold: ${STALE_FIXED_MONTHS}+ months from check date (fixed)`,
    margin,
    y + 64,
    { maxWidth: contentWidth },
  )

  doc.setFontSize(8)
  doc.setTextColor(130, 130, 130)
  doc.text(
    `Generated by ${generatedByName || '—'} · Status: ${statusLabel(status)}` +
      (submittedAt ? ` · Submitted ${formatDateTimeSafe(submittedAt)} by ${submittedByName || '—'}` : ''),
    margin,
    y + 80,
    { maxWidth: contentWidth },
  )

  y += 100

  let grandTotal = 0
  grouped.forEach((group) => {
    const bankLogo = bankLogoByName.get(group.bank)
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
        console.warn(`Could not embed logo for bank "${group.bank}":`, err)
      }
    }

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(...BRAND_TEAL_RGB)
    doc.text(`RETURN TO: ${group.bank.toUpperCase()}`, bankTextX, y)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(120, 120, 120)
    doc.text(`Branch: ${group.branch}`, bankTextX, y + 14)

    y += 28

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
      styles: { fontSize: 8, cellPadding: 4, textColor: [55, 65, 81], lineColor: [209, 213, 219], lineWidth: 0.5 },
      headStyles: { fillColor: BRAND_TEAL_RGB, textColor: 255, fontStyle: 'bold', halign: 'center' },
      columnStyles: { 0: { halign: 'center' }, 4: { halign: 'center' }, 5: { halign: 'center' }, 6: { halign: 'right' } },
      didParseCell: (data) => {
        if (data.row.section === 'body' && data.row.index === subtotalRowIndex) {
          data.cell.styles.fontStyle = 'bold'
        }
      },
    })
    y = doc.lastAutoTable.finalY + 24
  })

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
    y,
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
    doc.text(`Transmittal ${reportNumber} · Page ${p} of ${pageCount}`, margin, pageHeight - 20)
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
 *   reportNumber: string,
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
  const { reportNumber, generatedAt, generatedByName, submittedAt, submittedByName, status, rows } = docArgs
  const grouped = groupRowsByBranch(rows)
  const bankBreakdown = summarizeByBank(rows)
  const totals = computeTotals(rows)
  const clientLabel = summarizeClientLabel(rows)
  const logo = await loadLogoAsset()

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'CSBA Pickup System'
  workbook.created = new Date()

  const COL_COUNT = 7
  const sheet = workbook.addWorksheet('Check Transmittal', {
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1 },
    views: [{ showGridLines: false }],
  })

  sheet.columns = [{ width: 5 }, { width: 16 }, { width: 28 }, { width: 22 }, { width: 14 }, { width: 13 }, { width: 16 }]

  const logoBox = logo ? fitToHeight(logo, 44, 105) : null
  if (logo?.arrayBuffer && logoBox) {
    try {
      const imageId = workbook.addImage({ buffer: logo.arrayBuffer, extension: 'png' })
      sheet.addImage(imageId, { tl: { col: 0.1, row: 0.15 }, ext: { width: logoBox.width, height: logoBox.height } })
    } catch (err) {
      console.warn('Could not embed logo into stale check transmittal workbook:', err)
    }
  }
  const headerStartCol = logoBox ? 2 : 1

  function addHeader(rowNum, text, style = {}) {
    sheet.mergeCells(rowNum, headerStartCol, rowNum, COL_COUNT)
    const cell = sheet.getRow(rowNum).getCell(headerStartCol)
    cell.value = text
    cell.font = { bold: !!style.bold, size: style.size || 10, color: style.color ? { argb: style.color } : undefined }
    cell.alignment = { vertical: 'middle', horizontal: 'left' }
  }

  let r = 1
  addHeader(r, COMPANY_NAME, { bold: true, size: 14 }); r += 1
  addHeader(r, 'CHECK TRANSMITTAL', { bold: true, size: 13, color: HEADER_FILL_ARGB }); r += 1
  addHeader(r, REPORT_SUBTITLE, { size: 9 }); r += 1
  addHeader(r, `Transmittal No: ${reportNumber}`, { bold: true, size: 10 }); r += 1
  addHeader(r, `Date Generated: ${formatDateTimeSafe(generatedAt || new Date())}`, { size: 10 }); r += 1
  addHeader(r, `Client / Payor: ${clientLabel}`, { size: 10 }); r += 1
  addHeader(r, `Banks Included: ${bankBreakdown.map((b) => b.bank).join(', ') || 'None'}`, { size: 10 }); r += 1
  addHeader(
    r,
    `Total Checks: ${totals.count}  ·  Grand Total: ${formatCurrency(totals.amount)}  ·  Aging threshold: ${STALE_FIXED_MONTHS}+ months from check date (fixed)`,
    { size: 10 },
  ); r += 1
  addHeader(
    r,
    `Generated by ${generatedByName || '—'} · Status: ${statusLabel(status)}` +
      (submittedAt ? ` · Submitted ${formatDateTimeSafe(submittedAt)} by ${submittedByName || '—'}` : ''),
    { size: 8, color: 'FF828282' },
  ); r += 1

  const rowsUsedSoFar = r - 1
  const logoRowSpan = logoBox ? Math.ceil(logoBox.height / 15) + 1 : 0
  r += Math.max(1, logoRowSpan - rowsUsedSoFar)
  r += 1

  grouped.forEach((group) => {
    sheet.mergeCells(r, 1, r, COL_COUNT)
    const sectionCell = sheet.getCell(r, 1)
    sectionCell.value = `RETURN TO: ${group.bank}   ·   Branch: ${group.branch}   (${group.count} check${group.count === 1 ? '' : 's'} · ${formatCurrency(group.amount)})`
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

  const grandRow = sheet.getRow(r)
  sheet.mergeCells(r, 1, r, 6)
  grandRow.getCell(1).value = 'GRAND TOTAL'
  grandRow.getCell(1).font = { bold: true, size: 11 }
  grandRow.getCell(1).alignment = { horizontal: 'right' }
  grandRow.getCell(7).value = totals.amount
  grandRow.getCell(7).numFmt = '#,##0.00'
  grandRow.getCell(7).font = { bold: true, size: 11, color: { argb: HEADER_FILL_ARGB } }
  grandRow.getCell(7).alignment = { horizontal: 'right' }

  return workbook
}