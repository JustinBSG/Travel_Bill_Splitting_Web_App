import type { TFunction } from 'i18next'
import type { NotificationRow } from '../../lib/types'

/**
 * Notification event types (brief §3.11). The string values must match what
 * the backend writes to notifications.type / notification_settings.type.
 * GAP: confirm these names with the backend.
 */
export const NOTIFICATION_TYPES = [
  'expense_added',
  'expense_changed',
  'settlement_received',
  'member_joined',
  'trip_locked',
] as const
export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

/** Human text for a notification row; payload fields are best-effort. */
export function describeNotification(n: NotificationRow, t: TFunction): string {
  const p = n.payload ?? {}
  const vars = {
    actor: str(p.actor_name) || t('notifications.someone'),
    title: str(p.title),
    trip: str(p.trip_name),
    amount: str(p.amount_display),
  }
  switch (n.type) {
    case 'expense_added':
      return t('notifications.types.expense_added', vars)
    case 'expense_updated':
    case 'expense_changed':
      return t('notifications.types.expense_changed', vars)
    case 'expense_deleted':
      return t('notifications.types.expense_deleted', vars)
    case 'settlement_received':
      return t('notifications.types.settlement_received', vars)
    case 'member_joined':
      return t('notifications.types.member_joined', vars)
    case 'placeholder_claimed':
      return t('notifications.types.placeholder_claimed', vars)
    case 'trip_locked':
      return t('notifications.types.trip_locked', vars)
    default:
      return str(p.message) || t('notifications.generic', vars)
  }
}
