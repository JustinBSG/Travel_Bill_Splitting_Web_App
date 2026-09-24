import type { TFunction } from 'i18next'
import type { NotificationRow } from '../../lib/types'

/**
 * Settings rows = the spec §5.18 events. Each row switches one or more backend
 * notification types (notifications.type / notification_settings.type).
 */
export const NOTIFICATION_GROUPS = {
  expense_added: ['expense_added'],
  expense_changed: ['expense_updated', 'expense_deleted'],
  settlement_received: ['settlement_received'],
  member_joined: ['member_joined', 'placeholder_claimed'],
  trip_locked: ['trip_locked'],
} as const satisfies Record<string, readonly string[]>
export type NotificationGroup = keyof typeof NOTIFICATION_GROUPS
export const NOTIFICATION_TYPES = Object.keys(NOTIFICATION_GROUPS) as NotificationGroup[]

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
