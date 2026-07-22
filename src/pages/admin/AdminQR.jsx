import React, { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import {
  Download,
  Link2,
  QrCode,
  Copy,
  Check,
  RotateCcw,
  AlertTriangle,
  Loader2,
  Printer,
  Code,
  Image as ImageIcon,
  Smartphone,
  Ruler,
  ShieldCheck,
  Infinity as InfinityIcon,
  Home,
  Users,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Button } from '../../components/ui/button'
import { useToast } from '../../components/ui/toast'
import { cn } from '../../lib/utils'

const DEFAULT_URL = window.location.origin + '/'
// Second quick-select destination — the collector-facing search page.
const COLLECTOR_URL = window.location.origin + '/collector'
const REGEN_DEBOUNCE_MS = 250
// Rendered well above the on-screen display size so downloads and prints
// stay crisp — 1000px is comfortably sharp up to a large-format sign.
const PRINT_PX = 1000

function looksLikeUrl(value) {
  return /^https?:\/\/.+/i.test(value.trim())
}

const clipboardImageSupported =
  typeof navigator !== 'undefined' && !!navigator.clipboard && typeof window.ClipboardItem === 'function'

export default function AdminQR() {
  const [url, setUrl] = useState(DEFAULT_URL)
  const [generating, setGenerating] = useState(true)
  const [genError, setGenError] = useState('')
  const [pngDataUrl, setPngDataUrl] = useState('')
  const [svgMarkup, setSvgMarkup] = useState('')
  const [copied, setCopied] = useState(false)
  const requestIdRef = useRef(0)
  const { push } = useToast()

  const trimmedUrl = url.trim()
  const isValidUrl = looksLikeUrl(trimmedUrl)
  const isDefault = trimmedUrl === DEFAULT_URL
  const isCollector = trimmedUrl === COLLECTOR_URL
  const ready = !generating && !genError && !!pngDataUrl

  useEffect(() => {
    if (!trimmedUrl) {
      setGenError('Enter a URL to generate a code.')
      setGenerating(false)
      return
    }

    setGenerating(true)
    setGenError('')
    const requestId = ++requestIdRef.current

    const handle = setTimeout(() => {
      const options = {
        margin: 2,
        // High error-correction so a printed, publicly-posted code still
        // scans if it gets scuffed, dirty, or partly torn.
        errorCorrectionLevel: 'H',
        // Kept near-black for scan reliability — teal/orange at low contrast can
        // cause phone cameras to misread the code. Do not switch this to the
        // brand palette.
        color: { dark: '#171717', light: '#ffffff' },
      }

      Promise.all([
        QRCode.toDataURL(trimmedUrl, { ...options, width: PRINT_PX }),
        QRCode.toString(trimmedUrl, { ...options, type: 'svg' }),
      ])
        .then(([dataUrl, svg]) => {
          if (requestId !== requestIdRef.current) return
          setPngDataUrl(dataUrl)
          setSvgMarkup(svg)
          setGenerating(false)
        })
        .catch((err) => {
          if (requestId !== requestIdRef.current) return
          setGenerating(false)
          setGenError(err?.message || 'Could not generate a QR code for this text.')
        })
    }, REGEN_DEBOUNCE_MS)

    return () => clearTimeout(handle)
  }, [trimmedUrl])

  function downloadPng() {
    if (!ready) return
    const link = document.createElement('a')
    link.download = 'check-pickup-qr.png'
    link.href = pngDataUrl
    link.click()
    push({ variant: 'success', title: 'Downloaded', description: 'check-pickup-qr.png saved.' })
  }

  function downloadSvg() {
    if (!ready) return
    const blob = new Blob([svgMarkup], { type: 'image/svg+xml' })
    const blobUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.download = 'check-pickup-qr.svg'
    link.href = blobUrl
    link.click()
    URL.revokeObjectURL(blobUrl)
    push({ variant: 'success', title: 'Downloaded', description: 'check-pickup-qr.svg saved (vector, scales to any size).' })
  }

  async function copyImage() {
    if (!ready) return
    try {
      const res = await fetch(pngDataUrl)
      const blob = await res.blob()
      await navigator.clipboard.write([new window.ClipboardItem({ [blob.type]: blob })])
      push({ variant: 'success', title: 'Copied', description: 'QR image copied to clipboard.' })
    } catch {
      push({ variant: 'error', title: 'Could not copy image', description: 'Try downloading it instead.' })
    }
  }

  function printSign() {
    if (!ready) return
    window.print()
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(trimmedUrl)
      setCopied(true)
      push({ variant: 'success', title: 'Copied', description: 'Link copied to clipboard.' })
      setTimeout(() => setCopied(false), 1800)
    } catch {
      push({ variant: 'error', title: 'Could not copy', description: 'Copy the URL manually instead.' })
    }
  }

  function resetToDefault() {
    setUrl(DEFAULT_URL)
  }

  return (
    <>
      <div className="print:hidden">
        <div className="mb-6 flex items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-ledger-stamp/40 bg-ledger-stamp/10 text-ledger-stampDark">
            <QrCode className="h-4.5 w-4.5" />
          </span>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ledger-stampDark/80">
              Pickup counter signage
            </p>
            <h1 className="font-display text-2xl font-semibold text-ink-900">QR code</h1>
            <p className="mt-1 text-sm text-ink-400">
              Print this code and post it at the pickup counter. Collectors scan it to open the
              public lookup page — no app or login required.
            </p>
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-[280px_1fr]">
          <Card>
            <CardContent className="flex flex-col items-center gap-4 p-6">
              <div className="perforated relative flex h-64 w-64 items-center justify-center rounded-md border-2 border-dashed border-ink-200 p-3">
                {pngDataUrl && (
                  <img
                    src={pngDataUrl}
                    alt="QR code linking to the check pickup search page"
                    className={cn('h-full w-full rounded-sm transition-opacity', (generating || genError) && 'opacity-20')}
                  />
                )}
                {generating && !genError && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-ledger-stampDark" />
                  </div>
                )}
                {genError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-4 text-center">
                    <AlertTriangle className="h-5 w-5 text-red-500" />
                    <p className="text-xs font-medium text-red-600">{genError}</p>
                  </div>
                )}
              </div>

              <span className="rounded-full border border-dashed border-ledger-stamp/40 bg-ledger-stamp/5 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-ledger-stampDark">
                Scan to find your check
              </span>

              <div className="flex w-full flex-col gap-2">
                <Button onClick={printSign} disabled={!ready} className="w-full">
                  <Printer className="h-3.5 w-3.5" /> Print sign
                </Button>

                <div className="flex gap-2">
                  <Button variant="outline" onClick={downloadPng} disabled={!ready} className="flex-1">
                    <Download className="h-3.5 w-3.5" /> PNG
                  </Button>
                  <Button variant="outline" onClick={downloadSvg} disabled={!ready} className="flex-1">
                    <Code className="h-3.5 w-3.5" /> SVG
                  </Button>
                </div>

                {clipboardImageSupported && (
                  <Button variant="ghost" onClick={copyImage} disabled={!ready} className="w-full">
                    <ImageIcon className="h-3.5 w-3.5" /> Copy image
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Destination link</CardTitle>
              <CardDescription>
                Pick a page to point the code at, or paste a custom URL — for example if you deploy
                under a different domain.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              {/* Quick-select presets. Home is the general public search page;
                  Collector is the /collector page used at the pickup counter.
                  Picking either just fills the URL field below — it's still a
                  free-text input underneath, so a custom URL can be pasted in
                  too. */}
              <div className="mb-3 flex gap-2">
                <Button
                  variant={isDefault ? 'default' : 'outline'}
                  onClick={() => setUrl(DEFAULT_URL)}
                  className="flex-1"
                >
                  <Home className="h-3.5 w-3.5" /> Home
                </Button>
                <Button
                  variant={isCollector ? 'default' : 'outline'}
                  onClick={() => setUrl(COLLECTOR_URL)}
                  className="flex-1"
                >
                  <Users className="h-3.5 w-3.5" /> Collector
                </Button>
              </div>

              <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-500">
                <Link2 className="h-3.5 w-3.5" /> URL encoded in the QR code
              </label>
              <div className="flex gap-2">
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className={cn(!isValidUrl && trimmedUrl && 'ring-1 ring-ledger-amber/50')}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={!isValidUrl && !!trimmedUrl}
                />
                <Button
                  variant="outline"
                  onClick={copyLink}
                  disabled={!trimmedUrl}
                  className="shrink-0 px-3"
                  aria-label="Copy link"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-ledger-stampDark" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
                {!isDefault && (
                  <Button
                    variant="ghost"
                    onClick={resetToDefault}
                    className="shrink-0 px-3"
                    aria-label="Reset to default URL"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>

              <div aria-live="polite">
                {!isValidUrl && trimmedUrl && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-ledger-amber">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    This doesn't look like a full URL (starting with http:// or https://) — phones may
                    not offer to open it as a link.
                  </p>
                )}
                {isValidUrl && !isDefault && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-ledger-stampDark">
                    <Check className="h-3.5 w-3.5 shrink-0" />
                    This link will open when the code is scanned.
                  </p>
                )}
              </div>

              <ul className="mt-4 space-y-2 text-xs text-ink-400">
                <li className="flex items-start gap-2">
                  <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-300" />
                  Test the scan yourself with a phone before posting it publicly.
                </li>
                <li className="flex items-start gap-2">
                  <Ruler className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-300" />
                  Print at a minimum of 3 × 3 cm so phone cameras can focus on it.
                </li>
                <li className="flex items-start gap-2">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-300" />
                  Generated with high error-correction, so it still scans if scuffed, dirty, or
                  slightly torn.
                </li>
                <li className="flex items-start gap-2">
                  <InfinityIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-300" />
                  Never expires — always points to the live search page.
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Print-only layout: a clean, centered sign with nothing else from the
          admin UI. Shown only when the person hits "Print sign" (or Cmd/Ctrl+P). */}
      <div className="hidden print:flex print:min-h-screen print:flex-col print:items-center print:justify-center print:gap-4">
        {pngDataUrl && <img src={pngDataUrl} alt="QR code" className="h-[70mm] w-[70mm]" />}
        <p className="font-mono text-sm uppercase tracking-wider text-ink-900">Scan to find your check</p>
        <p className="font-mono text-[10px] text-ink-400">{trimmedUrl}</p>
      </div>
    </>
  )
}