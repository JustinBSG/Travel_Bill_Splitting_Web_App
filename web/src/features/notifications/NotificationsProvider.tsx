import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { supabase } from '../../lib/supabase'
import type { NotificationRow } from '../../lib/types'
import { useUser } from '../auth/AuthContext'
import { NotificationsContext, type NotificationsState } from './NotificationsContext'

const PAGE = 50

async function fetchNotifications(userId: string): Promise<{ rows: NotificationRow[] } | { error: string }> {
  const { data, error } = await supabase
    .from('notifications')
    .select('id, user_id, trip_id, type, payload, read_at, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(PAGE)
  return error ? { error: error.message } : { rows: (data ?? []) as NotificationRow[] }
}

/** In-app bell: always on. Realtime keeps the unread count live. */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const user = useUser()
  const [items, setItems] = useState<NotificationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const apply = useCallback((res: Awaited<ReturnType<typeof fetchNotifications>>) => {
    setLoading(false)
    if ('error' in res) {
      setError(res.error)
      return
    }
    setError(null)
    setItems(res.rows)
  }, [])

  const reload = useCallback(async () => apply(await fetchNotifications(user.id)), [user.id, apply])

  useEffect(() => {
    let alive = true
    fetchNotifications(user.id).then((res) => alive && apply(res))
    const channel = supabase
      .channel(`notifications-${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` },
        () => void reload(),
      )
      .subscribe()
    const onVisible = () => document.visibilityState === 'visible' && void reload()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisible)
      void supabase.removeChannel(channel)
    }
  }, [user.id, reload, apply])

  const markRead = useCallback(async (id: string) => {
    const now = new Date().toISOString()
    setItems((xs) => xs.map((n) => (n.id === id && !n.read_at ? { ...n, read_at: now } : n)))
    await supabase.from('notifications').update({ read_at: now }).eq('id', id).is('read_at', null)
  }, [])

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString()
    setItems((xs) => xs.map((n) => (n.read_at ? n : { ...n, read_at: now })))
    await supabase.from('notifications').update({ read_at: now }).eq('user_id', user.id).is('read_at', null)
  }, [user.id])

  const value = useMemo<NotificationsState>(
    () => ({
      items,
      unread: items.filter((n) => !n.read_at).length,
      loading,
      error,
      reload,
      markRead,
      markAllRead,
    }),
    [items, loading, error, reload, markRead, markAllRead],
  )

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
}
