import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFmt } from '../../app/useFmt'
import { useToast } from '../../app/ui/toast'
import { ErrorBox, PageHeader, Spinner } from '../../app/ui/common'
import { supabase, unwrap } from '../../lib/supabase'
import type { ActivityLogRow } from '../../lib/types'
import { restoreExpense } from '../expenses/expenseApi'
import { useTripData } from '../trips/TripDataContext'
import { describeActivity } from './describeActivity'

const PAGE = 50

async function fetchActivity(tripId: string, before?: string): Promise<ActivityLogRow[]> {
  let q = supabase
    .from('activity_log')
    .select('id, trip_id, actor_member, action, entity_type, entity_id, before, after, created_at')
    .eq('trip_id', tripId)
    .order('created_at', { ascending: false })
    .limit(PAGE)
  if (before) q = q.lt('created_at', before)
  return unwrap(await q) as ActivityLogRow[]
}

/** Append-only log. Nobody can edit/delete it; deleted expenses restore from here. */
export function ActivityPage() {
  const { t } = useTranslation()
  const fmt = useFmt()
  const toast = useToast()
  const { trip, expenses, memberName, locked, reload } = useTripData()
  const [rows, setRows] = useState<ActivityLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const apply = (data: ActivityLogRow[], append: boolean) => {
    setRows((xs) => (append ? [...xs, ...data] : data))
    setMore(data.length === PAGE)
    setError(null)
    setLoading(false)
  }
  const fail = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e))
    setLoading(false)
  }

  // First page (and after a restore / retry).
  useEffect(() => {
    let alive = true
    fetchActivity(trip.id).then(
      (data) => {
        if (!alive) return
        setRows(data)
        setMore(data.length === PAGE)
        setError(null)
        setLoading(false)
      },
      (e) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      },
    )
    return () => {
      alive = false
    }
  }, [trip.id, attempt])

  function refresh() {
    setLoading(true)
    setAttempt((a) => a + 1)
  }

  function loadMore() {
    setLoading(true)
    fetchActivity(trip.id, rows[rows.length - 1]?.created_at).then((d) => apply(d, true), fail)
  }

  const activeIds = new Set(expenses.map((e) => e.id))

  async function restore(id: string) {
    setRestoring(id)
    try {
      await restoreExpense(id)
      await reload(['expenses'])
      refresh()
      toast.show(t('activity.restored'), { tone: 'success' })
    } catch (e) {
      toast.show(t('app.errorWith', { message: e instanceof Error ? e.message : String(e) }), { tone: 'error' })
    } finally {
      setRestoring(null)
    }
  }

  return (
    <div className="screen">
      <PageHeader title={t('menu.activity')} backTo={`/trips/${trip.id}/overview`} />
      <main className="content">
        {error && <ErrorBox message={error} onRetry={refresh} />}
        {rows.length === 0 && !loading && !error && <p className="empty">{t('activity.empty')}</p>}
        <ul className="list">
          {rows.map((row) => {
            const line = describeActivity(row, { t, locale: fmt.locale, memberName })
            const canRestore = !!line.restorableExpenseId && !activeIds.has(line.restorableExpenseId) && !locked
            return (
              <li key={row.id} className="list-row">
                <div className="list-main">
                  <span>{line.text}</span>
                  <span className="muted small">{fmt.timestamp(row.created_at)}</span>
                </div>
                {canRestore && (
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={restoring !== null}
                    onClick={() => void restore(line.restorableExpenseId!)}
                  >
                    {t('activity.restore')}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
        {loading && <Spinner />}
        {more && !loading && (
          <button type="button" className="btn btn-block" onClick={loadMore}>
            {t('activity.loadMore')}
          </button>
        )}
      </main>
    </div>
  )
}
