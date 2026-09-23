import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Icon } from '../../app/ui/Icon'
import { useNotifications } from './NotificationsContext'

export function BellButton() {
  const { t } = useTranslation()
  const { unread } = useNotifications()
  return (
    <Link
      to="/notifications"
      className="icon-btn bell"
      aria-label={unread ? t('notifications.bellUnread', { count: unread }) : t('notifications.title')}
    >
      <Icon name="bell" />
      {unread > 0 && <span className="badge-count">{unread > 99 ? '99+' : unread}</span>}
    </Link>
  )
}
