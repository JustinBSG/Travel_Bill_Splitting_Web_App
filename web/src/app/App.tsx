import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ActivityPage } from '../features/activity/ActivityPage'
import { AuthProvider } from '../features/auth/AuthProvider'
import { LoginPage } from '../features/auth/LoginPage'
import { RequireAuth } from '../features/auth/RequireAuth'
import { ExpenseFormPage } from '../features/expenses/ExpenseFormPage'
import { MembersPage } from '../features/members/MembersPage'
import { NotificationsPage } from '../features/notifications/NotificationsPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { CreateTripPage } from '../features/trips/CreateTripPage'
import { JoinPage } from '../features/trips/JoinPage'
import { MyTripsPage } from '../features/trips/MyTripsPage'
import { TripDataProvider } from '../features/trips/TripDataProvider'
import { TripSettingsPage } from '../features/trips/TripSettingsPage'
import { supabaseConfigured } from '../lib/supabase'
import { TripShell } from './TripShell'
import { NotFound } from './ui/common'
import { ToastProvider } from './ui/ToastProvider'

/** Remount all trip state when switching trips. */
function TripRoute() {
  const { tripId } = useParams()
  return <TripDataProvider key={tripId} />
}

function SetupNeeded() {
  const { t } = useTranslation()
  return (
    <div className="full-page-center stack">
      <h1>{t('config.title')}</h1>
      <p>{t('config.body')}</p>
    </div>
  )
}

export function App() {
  if (!supabaseConfigured) return <SetupNeeded />
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<RequireAuth />}>
              <Route index element={<Navigate to="/trips" replace />} />
              <Route path="/trips" element={<MyTripsPage />} />
              <Route path="/trips/new" element={<CreateTripPage />} />
              <Route path="/join" element={<JoinPage />} />
              <Route path="/join/:token" element={<JoinPage />} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/trips/:tripId" element={<TripRoute />}>
                <Route index element={<Navigate to="overview" replace />} />
                <Route path="members" element={<MembersPage />} />
                <Route path="activity" element={<ActivityPage />} />
                <Route path="settings" element={<TripSettingsPage />} />
                <Route path="expense/new" element={<ExpenseFormPage />} />
                <Route path="expense/:expenseId" element={<ExpenseFormPage />} />
                <Route path=":pageKey" element={<TripShell />} />
              </Route>
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  )
}
