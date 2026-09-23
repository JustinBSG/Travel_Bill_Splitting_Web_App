import { createContext, useContext } from 'react'
import type { NotificationRow } from '../../lib/types'

export interface NotificationsState {
  items: NotificationRow[]
  unread: number
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  markRead: (id: string) => Promise<void>
  markAllRead: () => Promise<void>
}

export const NotificationsContext = createContext<NotificationsState | null>(null)

export function useNotifications(): NotificationsState {
  const v = useContext(NotificationsContext)
  if (!v) throw new Error('useNotifications outside NotificationsProvider')
  return v
}
