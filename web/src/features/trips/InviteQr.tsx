import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { encode } from 'uqr'

const SHOW_KEY = 'tbs-invite-qr'

function readShow(): boolean {
  try {
    return localStorage.getItem(SHOW_KEY) === '1'
  } catch {
    return false
  }
}

/** QR of the invite link, behind an on/off switch remembered on this device (off by default). */
export function InviteQr({ url }: { url: string }) {
  const { t } = useTranslation()
  const [show, setShow] = useState(readShow)

  function toggle(on: boolean) {
    setShow(on)
    try {
      localStorage.setItem(SHOW_KEY, on ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      <label className="switch-row invite-qr-toggle">
        <span>{t('overview.showQr')}</span>
        <input type="checkbox" role="switch" className="switch" checked={show} onChange={(e) => toggle(e.target.checked)} />
      </label>
      {show && <QrCode text={url} label={t('overview.qrLabel')} />}
      {show && <p className="muted small invite-qr-hint">{t('overview.qrHint')}</p>}
    </>
  )
}

function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 0 })
    let d = ''
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`
      }),
    )
    return { size: qr.size, path: d }
  }, [text])

  return (
    <div className="invite-qr">
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
        <path d={path} />
      </svg>
    </div>
  )
}
