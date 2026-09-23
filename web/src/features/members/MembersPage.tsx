import { useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useFmt } from '../../app/useFmt'
import { useToast } from '../../app/ui/toast'
import { Banner, ErrorBox, PageHeader } from '../../app/ui/common'
import { Icon } from '../../app/ui/Icon'
import { Modal } from '../../app/ui/Modal'
import { HKD, ZERO } from '../../lib/money'
import { activeCurrencies, hkdNets, netOf } from '../../lib/settlement'
import type { TripMember } from '../../lib/types'
import { useTripData } from '../trips/TripDataContext'
import { addPlaceholder, promoteToAdmin, removeMember } from '../trips/tripApi'

export function MembersPage() {
  const { t } = useTranslation()
  const fmt = useFmt()
  const toast = useToast()
  const { trip, members, me, isAdmin, locked, nets, rateFor, reload } = useTripData()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<TripMember | null>(null)

  const hkd = useMemo(() => hkdNets(nets, rateFor), [nets, rateFor])
  const currencies = useMemo(() => activeCurrencies(nets), [nets])
  const hasBalance = (id: string) => currencies.some((c) => !netOf(nets, id, c).isZero())

  const sorted = [...members].sort((a, b) => Number(!!a.removed_at) - Number(!!b.removed_at))

  async function run(fn: () => Promise<void>, success?: string) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await reload(['members'])
      if (success) toast.show(success, { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    await run(() => addPlaceholder(trip.id, n), t('members.added', { name: n }))
    setName('')
  }

  return (
    <div className="screen">
      <PageHeader title={t('menu.members')} backTo={`/trips/${trip.id}/overview`} />
      <main className="content stack">
        {locked && (
          <Banner tone="lock">
            <Icon name="lock" size={16} /> {t('lock.banner')}
          </Banner>
        )}
        {error && <ErrorBox message={error} />}

        <ul className="list">
          {sorted.map((m) => {
            const bal = hkd.balances.get(m.id) ?? ZERO
            const canManage = isAdmin && !locked && !m.removed_at && m.role !== 'owner' && m.id !== me?.id
            return (
              <li key={m.id} className={`list-row member-row ${m.removed_at ? 'removed' : ''}`}>
                <div className="list-main">
                  <span>
                    <strong>{m.display_name}</strong>
                    {m.id === me?.id && ` (${t('app.you')})`}
                  </span>
                  <span className="row-gap wrap">
                    <span className="badge">{t(`members.roles.${m.role}`)}</span>
                    {!m.user_id && <span className="badge badge-muted">{t('members.placeholder')}</span>}
                    {m.removed_at && <span className="badge badge-muted">{t('members.left')}</span>}
                  </span>
                  <span className={`small ${bal.isZero() ? 'muted' : bal.isPositive() ? 'pos' : 'neg'}`}>
                    {fmt.signed(bal, HKD)}
                  </span>
                </div>
                {canManage && (
                  <div className="member-actions">
                    {m.role === 'member' && (
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={busy}
                        onClick={() => void run(() => promoteToAdmin(m.id), t('members.promoted', { name: m.display_name }))}
                      >
                        {t('members.makeAdmin')}
                      </button>
                    )}
                    <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={() => setRemoving(m)}>
                      {t('members.remove')}
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>

        {!locked && (
          <form className="card stack" onSubmit={add}>
            <h2 className="section-title">{t('members.addPlaceholder')}</h2>
            <p className="muted small">{t('members.placeholderHint')}</p>
            <div className="row-gap">
              <label className="field grow">
                <span className="sr-only">{t('profile.displayName')}</span>
                <input
                  value={name}
                  maxLength={40}
                  placeholder={t('members.placeholderName')}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
                {t('app.add')}
              </button>
            </div>
          </form>
        )}
      </main>

      {removing && (
        <Modal
          title={t('members.removeTitle', { name: removing.display_name })}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRemoving(null)}>
                {t('app.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => {
                  const m = removing
                  setRemoving(null)
                  void run(() => removeMember(m.id), t('members.removed', { name: m.display_name }))
                }}
              >
                {t('members.remove')}
              </button>
            </>
          }
        >
          <div className="stack">
            {hasBalance(removing.id) && (
              <Banner tone="warn">
                {t('members.removeBalanceWarning', {
                  amount: fmt.signed(hkd.balances.get(removing.id) ?? ZERO, HKD),
                })}
              </Banner>
            )}
            <p>{t('members.removeBody')}</p>
          </div>
        </Modal>
      )}
    </div>
  )
}
