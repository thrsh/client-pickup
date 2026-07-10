import React, { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Download, Link2, QrCode, Copy, Check, RotateCcw, AlertTriangle, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Button } from '../../components/ui/button'
import { useToast } from '../../components/ui/toast'
import { cn } from '../../lib/utils'

const DEFAULT_URL = window.location.origin + '/'
const REGEN_DEBOUNCE_MS = 250

function looksLikeUrl(value) {
  return /^https?:\/\/.+/i.test(value.trim())
}

export default function AdminQR() {
  const [url, setUrl] = useState(DEFAULT_URL)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState('')
  const [copied, setCopied] = useState(false)
  const canvasRef = useRef(null)
  const { push } = useToast()

  const trimmedUrl = url.trim()
  const isValidUrl = looksLikeUrl(trimmedUrl)
  const isDefault = trimmedUrl === DEFAULT_URL

  useEffect(() => {
    if (!trimmedUrl) {
      setGenError('Enter a URL to generate a code.')
      return
    }

    setGenerating(true)
    setGenError('')

    const handle = setTimeout(() => {
      QRCode.toCanvas(canvasRef.current, trimmedUrl, {
        width: 320,
        margin: 2,
        // Kept near-black for scan reliability — teal/orange at low contrast can
        // cause phone cameras to misread the code. Do not switch this to the
        // brand palette.
        color: { dark: '#171717', light: '#ffffff' },
      })
        .then(() => setGenerating(false))
        .catch((err) => {
          setGenerating(false)
          setGenError(err?.message || 'Could not generate a QR code for this text.')
        })
    }, REGEN_DEBOUNCE_MS)

    return () => clearTimeout(handle)
  }, [trimmedUrl])

  function download() {
    const canvas = canvasRef.current
    if (!canvas || genError) return
    const link = document.createElement('a')
    link.download = 'check-pickup-qr.png'
    link.href = canvas.toDataURL('image/png')
    link.click()
    push({ variant: 'success', title: 'Downloaded', description: 'check-pickup-qr.png saved.' })
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(trimmedUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      push({ variant: 'error', title: 'Could not copy', description: 'Copy the URL manually instead.' })
    }
  }

  function resetToDefault() {
    setUrl(DEFAULT_URL)
  }

  return (
    <div>
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
            <div className="perforated relative rounded-md border-2 border-dashed border-ink-200 p-3">
              <canvas
                ref={canvasRef}
                className={cn('rounded-sm transition-opacity', (generating || genError) && 'opacity-20')}
              />
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

            <Button onClick={download} disabled={generating || !!genError} className="w-full">
              <Download className="h-3.5 w-3.5" /> Download PNG
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Destination link</CardTitle>
            <CardDescription>
              Defaults to this site's home page. Change it if you deploy under a custom domain.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
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

            {!isValidUrl && trimmedUrl && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-ledger-amber">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                This doesn't look like a full URL (starting with http:// or https://) — phones may not
                offer to open it as a link.
              </p>
            )}

            <ul className="mt-4 list-inside list-disc space-y-1.5 text-xs text-ink-400">
              <li>Print at a minimum of 3 × 3 cm so phone cameras can focus on it.</li>
              <li>Test the scan yourself with a phone before posting it publicly.</li>
              <li>The QR code never expires — it always points to the live search page.</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
