import React, { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapPin, Navigation2, Copy, Check } from 'lucide-react'

const PICKUP = {
  lat: 14.5279,
  lng: 120.9885,
  label: 'Manila Office',
  address:
    '4th Floor, Unit 407-408, Kawayan Building 1, PARQAL, Aseana City, D. Macapagal Ave., Brgy. Tambo, Parañaque City 1701, Philippines',
}

function buildPinIcon() {
  return L.divIcon({
    className: 'csba-pin-wrapper',
    html:
      '<div class="csba-pin-drop">' +
      '<div class="csba-pin-pulse"></div>' +
      '<svg width="40" height="52" viewBox="0 0 40 52" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M20 0C9 0 0 9 0 20c0 14 20 32 20 32s20-18 20-32C40 9 31 0 20 0z" fill="#0d9488"/>' +
      '<circle cx="20" cy="20" r="8" fill="white"/>' +
      '</svg>' +
      '</div>',
    iconSize: [40, 52],
    iconAnchor: [20, 52],
    popupAnchor: [0, -48],
  })
}

function FlyInOnMount({ target, zoom }) {
  const map = useMap()
  const hasFlown = useRef(false)

  useEffect(() => {
    if (hasFlown.current) return
    hasFlown.current = true
    map.setView(target, zoom - 4, { animate: false })
    const timer = setTimeout(() => {
      map.flyTo(target, zoom, { duration: 1.4, easeLinearity: 0.25 })
    }, 250)
    return () => clearTimeout(timer)
  }, [map, target, zoom])

  return null
}

export default function PickupLocationMap({ className = '' }) {
  const [copied, setCopied] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const icon = useRef(buildPinIcon())
  const target = [PICKUP.lat, PICKUP.lng]

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(PICKUP.address)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API can fail without HTTPS/permissions — non-fatal.
    }
  }

  const directionsUrl =
    'https://www.google.com/maps/dir/?api=1&destination=' + PICKUP.lat + ',' + PICKUP.lng

  return (
    <div className={'csba-map-card relative overflow-hidden rounded-xl border border-[var(--brand-light)] bg-white shadow-sm ' + className}>
      <style>{`
        .csba-pin-wrapper { background: transparent; border: none; }
        .csba-pin-drop { position: relative; width: 40px; height: 52px; filter: drop-shadow(0 6px 8px rgba(15, 23, 42, 0.35)); }
        @media (prefers-reduced-motion: no-preference) {
          .csba-pin-drop { animation: csbaPinFall 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) 1.1s both; }
          .csba-pin-pulse { position: absolute; left: 50%; top: 20px; width: 14px; height: 14px; margin-left: -7px; margin-top: -7px; border-radius: 999px; background: rgba(13, 148, 136, 0.45); animation: csbaPinPulse 1.8s ease-out 1.9s infinite; }
          @keyframes csbaPinFall {
            0% { transform: translateY(-140px) scale(0.6); opacity: 0; }
            70% { transform: translateY(6px) scale(1.05); opacity: 1; }
            85% { transform: translateY(-4px) scale(0.98); }
            100% { transform: translateY(0) scale(1); }
          }
          @keyframes csbaPinPulse {
            0% { transform: scale(1); opacity: 0.6; }
            100% { transform: scale(4.5); opacity: 0; }
          }
        }
        .csba-map-card .leaflet-container { background: #eef2f7; font-family: inherit; }
        .csba-map-card .leaflet-popup-content-wrapper { border-radius: 10px; }
        .csba-map-card .leaflet-control-attribution { font-size: 9px; }
      `}</style>

      <div className="relative h-64 w-full sm:h-80">
        <MapContainer
          center={target}
          zoom={17}
          scrollWheelZoom={false}
          zoomControl={true}
          attributionControl={true}
          style={{ height: '100%', width: '100%' }}
          whenReady={() => setMapReady(true)}
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          />
          <FlyInOnMount target={target} zoom={17} />
          <Marker position={target} icon={icon.current}>
            <Popup>
              <div className="text-sm">
                <p className="font-semibold text-slate-800">{PICKUP.label}</p>
                <p className="mt-1 text-slate-600">{PICKUP.address}</p>
              </div>
            </Popup>
          </Marker>
        </MapContainer>

        {!mapReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-100">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-[var(--brand-light)] border-t-[var(--brand)]" />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-slate-100 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[var(--brand)]" />
          <p className="text-sm leading-snug text-slate-600">{PICKUP.address}</p>
        </div>

        <div className="flex shrink-0 gap-2">
          <button
            onClick={handleCopy}
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-[var(--brand)]" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy address'}
          </button>

          
            <a href={directionsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand)] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[var(--brand-dark)]"
          >
            <Navigation2 className="h-3.5 w-3.5" />
            Directions
          </a>
        </div>
      </div>
    </div>
  )
}