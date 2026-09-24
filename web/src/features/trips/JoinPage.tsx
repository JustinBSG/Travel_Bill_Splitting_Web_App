import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { useFmt } from '../../app/useFmt'
import { ErrorBox, PageHeader, Spinner } from '../../app/ui/common'
import { JoinCodeDialog } from './JoinCodeDialog'
import { JoinError, joinTrip, previewJoin, type JoinPreview, type JoinTarget } from './joinApi'

type State =
  | { status: 'loading' }
  | { status: 'choose'; preview: JoinPreview }
  | { status: 'joining' }
  | { status: 'error'; message: string }

/** /join/:token (invite link) or /join with a code in router state. */
export function JoinPage() {
  const { t } = useTranslation()
  const fmt = useFmt()
  const navigate = useNavigate()
  const { token } = useParams()
  const location = useLocation()
  const code = (location.state as { code?: string } | null)?.code
  const target = useMemo<JoinTarget | null>(() => (token ? { token } : code ? { code } : null), [token, code])
  const [state, setState] = useState<State>({ status: 'loading' })

  const errorText = useCallback(
    (e: unknown) => {
      if (e instanceof JoinError) {
        if (e.kind === 'invalid') return t('join.invalid')
        if (e.kind === 'disabled') return t('join.disabled')
        if (e.kind === 'locked') return t('join.locked')
        if (e.kind === 'rate_limited') return t('join.rateLimited')
      }
      return t('app.errorWith', { message: e instanceof Error ? e.message : String(e) })
    },
    [t],
  )

  const [attempt, setAttempt] = useState(0)
  const load = () => {
    setState({ status: 'loading' })
    setAttempt((a) => a + 1)
  }

  useEffect(() => {
    if (!target) return
    let alive = true
    previewJoin(target).then(
      (preview) => {
        if (!alive) return
        if (preview.alreadyMember && preview.trip) {
          navigate(`/trips/${preview.trip.id}/overview`, { replace: true })
        } else if (!preview.joiningEnabled) {
          setState({ status: 'error', message: t('join.disabled') })
        } else {
          setState({ status: 'choose', preview })
        }
      },
      (e) => alive && setState({ status: 'error', message: errorText(e) }),
    )
    return () => {
      alive = false
    }
  }, [target, attempt, navigate, t, errorText])

  async function join(claimId?: string) {
    if (!target) return
    setState({ status: 'joining' })
    try {
      const tripId = await joinTrip(target, claimId)
      navigate(`/trips/${tripId}/overview`, { replace: true })
    } catch (e) {
      setState({ status: 'error', message: errorText(e) })
    }
  }

  if (!target) {
    return <JoinCodeDialog onClose={() => navigate('/trips')} />
  }

  return (
    <div className="screen">
      <PageHeader title={t('join.title')} backTo="/trips" />
      <main className="content">
        {(state.status === 'loading' || state.status === 'joining') && <Spinner />}
        {state.status === 'error' && (
          <div className="stack">
            <ErrorBox message={state.message} onRetry={load} />
            <Link to="/trips" className="btn">
              {t('app.goHome')}
            </Link>
          </div>
        )}
        {state.status === 'choose' && (
          <div className="stack">
            {state.preview.trip && (
              <div className="card">
                <h2>{state.preview.trip.name}</h2>
                <p className="muted">{fmt.range(state.preview.trip.start_date, state.preview.trip.end_date)}</p>
              </div>
            )}
            <button type="button" className="btn btn-primary btn-block" onClick={() => void join()}>
              {t('join.asNew')}
            </button>
            {state.preview.placeholders.length > 0 && (
              <>
                <p className="muted">{t('join.orClaim')}</p>
                {state.preview.placeholders.map((p) => (
                  <button key={p.id} type="button" className="btn btn-block" onClick={() => void join(p.id)}>
                    {t('join.iAm', { name: p.display_name })}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
