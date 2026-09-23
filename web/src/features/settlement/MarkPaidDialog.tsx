import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFmt } from '../../app/useFmt'
import { useToast } from '../../app/ui/toast'
import { ErrorBox } from '../../app/ui/common'
import { Modal } from '../../app/ui/Modal'
import { Dec, HKD, toHkdCents } from '../../lib/money'
import { allocateHkdPayment, type SettlementPiece, type Transfer } from '../../lib/settlement'
import { useTripData } from '../trips/TripDataContext'
import { recordSettlements, type SettlementInput } from './settlementApi'

interface Props {
  transfer: Transfer
  view: 'hkd' | 'currency'
  onClose: () => void
}

type Snapshot =
  | { view: 'hkd'; pieces: SettlementPiece[]; keys: string[] }
  | { view: 'currency'; key: string }

/**
 * "Mark as paid". Everything is snapshotted when the dialog opens (pieces,
 * rate, idempotency keys) so realtime updates or a second tap can't change
 * or duplicate what gets written.
 */
export function MarkPaidDialog({ transfer, view, onClose }: Props) {
  const { t } = useTranslation()
  const fmt = useFmt()
  const toast = useToast()
  const { trip, nets, rateFor, memberName, reload } = useTripData()
  const [snapshot] = useState<Snapshot>(() => {
    if (view === 'hkd') {
      const pieces = allocateHkdPayment(nets, transfer.from, transfer.to, transfer.amount, rateFor)
      return { view, pieces, keys: pieces.map(() => crypto.randomUUID()) }
    }
    return { view, key: crypto.randomUUID() }
  })
  const [rate] = useState(() => (transfer.currency === HKD ? new Dec(1) : rateFor(transfer.currency)))
  const [payIn, setPayIn] = useState<'original' | 'hkd'>('original')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hkdEquivalent = rate ? toHkdCents(transfer.amount, transfer.currency, rate) : null
  const from = memberName(transfer.from)
  const to = memberName(transfer.to)

  function rows(): SettlementInput[] {
    if (snapshot.view === 'hkd') {
      return snapshot.pieces.map((p, i) => ({
        from_member: transfer.from,
        to_member: transfer.to,
        debt_currency: p.debt_currency,
        debt_amount: p.debt_amount,
        paid_currency: HKD,
        paid_amount: p.paid_hkd,
        fx_rate: p.fx_rate,
        idempotency_key: snapshot.keys[i],
      }))
    }
    const inHkd = payIn === 'hkd' && transfer.currency !== HKD
    return [
      {
        from_member: transfer.from,
        to_member: transfer.to,
        debt_currency: transfer.currency,
        debt_amount: transfer.amount,
        paid_currency: inHkd ? HKD : transfer.currency,
        paid_amount: inHkd ? hkdEquivalent! : transfer.amount,
        fx_rate: inHkd ? rate! : new Dec(1),
        idempotency_key: snapshot.key,
      },
    ]
  }

  async function confirm() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await recordSettlements(trip.id, rows())
      await reload(['settlements'])
      toast.show(res === 'duplicate' ? t('markPaid.alreadyRecorded') : t('markPaid.recorded'), { tone: 'success' })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('markPaid.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('app.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || (snapshot.view === 'hkd' && snapshot.pieces.length === 0)}
            onClick={() => void confirm()}
          >
            {busy ? t('app.saving') : t('markPaid.confirm')}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="transfer-line">
          {t('conclusion.pays', { from, to })} <strong>{fmt.money(transfer.amount, transfer.currency)}</strong>
        </p>

        {snapshot.view === 'hkd' ? (
          <>
            <p className="muted small">{t('markPaid.hkdExplain')}</p>
            <ul className="list compact">
              {snapshot.pieces.map((p, i) => (
                <li key={i} className="list-row">
                  <span>{t('markPaid.clears', { amount: fmt.money(p.debt_amount, p.debt_currency) })}</span>
                  <span className="muted small">
                    {p.debt_currency !== HKD && fmt.money(p.paid_hkd, HKD)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : transfer.currency === HKD ? null : (
          <fieldset className="field">
            <legend>{t('markPaid.paidIn')}</legend>
            <label className="check-row">
              <input type="radio" name="payin" checked={payIn === 'original'} onChange={() => setPayIn('original')} />
              <span>{t('markPaid.inOriginal', { amount: fmt.money(transfer.amount, transfer.currency) })}</span>
            </label>
            <label className="check-row">
              <input
                type="radio"
                name="payin"
                disabled={!rate}
                checked={payIn === 'hkd'}
                onChange={() => setPayIn('hkd')}
              />
              <span>
                {hkdEquivalent
                  ? t('markPaid.inHkd', { amount: fmt.money(hkdEquivalent, HKD) })
                  : t('markPaid.noRate', { currency: transfer.currency })}
              </span>
            </label>
            {payIn === 'hkd' && rate && (
              <p className="muted small">
                {t('markPaid.rateNote', { currency: transfer.currency, rate: rate.toSignificantDigits(6).toString() })}
              </p>
            )}
          </fieldset>
        )}
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  )
}
