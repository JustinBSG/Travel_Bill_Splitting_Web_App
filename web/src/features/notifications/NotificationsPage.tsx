import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useFmt } from '../../app/useFmt'
import { ErrorBox, PageHeader, Spinner } from '../../app/ui/common'
import { useNotifications } from './NotificationsContext'
import { describeNotification } from './notificationTypes'

/** Expense notices open the expense's day with its row flashed; the rest open the trip. */
function notificationPath(tripId: string, n: { type: string; payload: Record<string, unknown> | null }): string {
  const expenseId = n.payload?.expense_id
  if ((n.type === 'expense_added' || n.type === 'expense_updated') && typeof expenseId === 'string') {
    return `/trips/${tripId}/overview?expense=${encodeURIComponent(expenseId)}`
  }
  return `/trips/${tripId}/overview`
}

export function NotificationsPage() {
  const { t } = useTranslation()
  const fmt = useFmt()
  const navigate = useNavigate()
  const { items, unread, loading, error, reload, markRead, markAllRead } = useNotifications()

  return (
    <div className="screen">
      <PageHeader
        title={t('notifications.title')}
        backTo="/trips"
        actions={
          unread > 0 ? (
            <button type="button" className="btn btn-small" onClick={() => void markAllRead()}>
              {t('notifications.markAll')}
            </button>
          ) : null
        }
      />
      <main className="content">
        {error && <ErrorBox message={error} onRetry={reload} />}
        {loading ? (
          <Spinner />
        ) : items.length === 0 ? (
          <p className="empty">{t('notifications.empty')}</p>
        ) : (
          <ul className="list">
            {items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className={`list-row list-button ${n.read_at ? '' : 'unread'}`}
                  onClick={() => {
                    void markRead(n.id)
                    if (n.trip_id) navigate(notificationPath(n.trip_id, n))
                  }}
                >
                  <span className="list-main">
                    <span>{describeNotification(n, t)}</span>
                    <span className="muted small">{fmt.timestamp(n.created_at)}</span>
                  </span>
                  {!n.read_at && <span className="dot" aria-label={t('notifications.unread')} />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
