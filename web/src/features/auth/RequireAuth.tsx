import { Navigate, Outlet, useLocation } from 'react-router'
import { FullPageSpinner } from '../../app/ui/common'
import { NotificationsProvider } from '../notifications/NotificationsProvider'
import { PushPrompt } from '../notifications/PushPrompt'
import { useAuth } from './AuthContext'
import { ProfileSetupPage } from './ProfileSetupPage'

export function RequireAuth() {
  const { loading, session, profile } = useAuth()
  const location = useLocation()

  if (loading) return <FullPageSpinner />
  if (!session) {
    const next = location.pathname + location.search
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }
  // First login: force a display name before anything else.
  if (!profile?.display_name?.trim()) return <ProfileSetupPage />

  return (
    <NotificationsProvider>
      <Outlet />
      <PushPrompt />
    </NotificationsProvider>
  )
}
