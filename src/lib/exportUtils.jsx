// src/lib/exportUtils.jsx
//
// Shared CSV / Excel / PDF export helpers + the "Export" dropdown button.
// Originally lived inside AdminAuditTrail.jsx; extracted here so any page
// (AdminUsers, AdminAuditTrail, future pages) gets identical export
// behavior instead of copy-pasted logic that can drift out of sync.
import React, { useEffect, useRef, useState } from 'react'
import { Download, ChevronDown, FileSpreadsheet, FileText } from 'lucide-react'
import { Button } from '../components/ui/button'
import ExcelJS from 'exceljs'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

// Guards CSV exports against formula injection: a cell that opens with
// = + - @ can execute as a formula when the file is opened in Excel/Sheets.
function escapeCsvValue(value) {
  let str = String(value ?? '')
  if (/^[=+\-@]/.test(str)) str = `'${str}`
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

export function downloadCsv(header, rows, filename) {
  const lines = [header.map(escapeCsvValue).join(',')]
  rows.forEach((row) => lines.push(row.map(escapeCsvValue).join(',')))
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/** Builds and downloads an .xlsx workbook from a header row + array-of-arrays body. */
export async function downloadXlsx(header, rows, sheetTitle, filename) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'CSBA Admin'
  workbook.created = new Date()
  const sheet = workbook.addWorksheet(sheetTitle.slice(0, 31), {
    views: [{ showGridLines: false }],
  })

  sheet.columns = header.map((h) => ({ header: h, width: Math.max(14, h.length + 4) }))

  const headerRow = sheet.getRow(1)
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D9488' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })
  headerRow.height = 22

  rows.forEach((row) => sheet.addRow(row))
  sheet.views = [{ state: 'frozen', ySplit: 1 }]

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Builds and downloads a landscape PDF table from the same header + rows shape as downloadXlsx. */
export function downloadPdf(header, rows, title, filename) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
  const margin = 32

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.setTextColor(20, 20, 20)
  doc.text(title, margin, 40)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(120, 120, 120)
  doc.text(`Generated ${new Date().toLocaleString()}`, margin, 56)

  autoTable(doc, {
    head: [header],
    body: rows,
    startY: 70,
    margin: { left: margin, right: margin },
    styles: { fontSize: 7.5, cellPadding: 4, lineColor: [209, 213, 219], lineWidth: 0.5, textColor: [55, 65, 81] },
    headStyles: { fillColor: [13, 148, 136], textColor: 255, fontStyle: 'bold', halign: 'center' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    didDrawPage: (data) => {
      const pageCount = doc.internal.getNumberOfPages()
      doc.setFontSize(8)
      doc.setTextColor(150, 150, 150)
      doc.text(`Page ${data.pageNumber} of ${pageCount}`, margin, doc.internal.pageSize.getHeight() - 14)
    },
  })

  doc.save(filename)
}

/** Dropdown "Export" button offering CSV / Excel / PDF. */
export function ExportMenu({ disabled, onExportCsv, onExportXlsx, onExportPdf }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div ref={ref} className="relative">
      <Button onClick={() => setOpen((v) => !v)} disabled={disabled}>
        <Download className="mr-1.5 h-4 w-4" />
        Export
        <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-md border border-gray-200 bg-white py-1 shadow-lg">
          <button
            type="button"
            onClick={() => { onExportCsv(); setOpen(false) }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            <Download className="h-3.5 w-3.5" /> CSV
          </button>
          <button
            type="button"
            onClick={() => { onExportXlsx(); setOpen(false) }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" /> Excel
          </button>
          <button
            type="button"
            onClick={() => { onExportPdf(); setOpen(false) }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            <FileText className="h-3.5 w-3.5" /> PDF
          </button>
        </div>
      )}
    </div>
  )
}