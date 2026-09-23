import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { Icon } from './Icon'

export function Spinner({ label }: { label?: string }) {
  const { t } = useTranslation()
  return (
    <div className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden />
      <span className="sr-only">{label ?? t('app.loading')}</span>
    </div>
  )
}

export function FullPageSpinner() {
  return (
    <div className="full-page-center">
      <Spinner />
    </div>
  )
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="banner banner-error" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          {t('app.retry')}
        </button>
      )}
    </div>
  )
}

export function Banner({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'lock'; children: ReactNode }) {
  return <div className={`banner banner-${tone}`}>{children}</div>
}

/** Simple page header for non-swipe screens. */
export function PageHeader({
  title,
  backTo,
  actions,
}: {
  title: string
  backTo?: string | -1
  actions?: ReactNode
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <header className="topbar">
      {backTo !== undefined ? (
        <button
          type="button"
          className="icon-btn"
          aria-label={t('app.back')}
          onClick={() => (backTo === -1 ? navigate(-1) : navigate(backTo))}
        >
          <Icon name="back" />
        </button>
      ) : (
        <span className="topbar-spacer" />
      )}
      <h1 className="topbar-title">{title}</h1>
      <div className="topbar-actions">{actions}</div>
    </header>
  )
}

export function NotFound() {
  const { t } = useTranslation()
  return (
    <div className="full-page-center stack">
      <p>{t('app.notFound')}</p>
      <Link className="btn" to="/trips">
        {t('app.goHome')}
      </Link>
    </div>
  )
}
