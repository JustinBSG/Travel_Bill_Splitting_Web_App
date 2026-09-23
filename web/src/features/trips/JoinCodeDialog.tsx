import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Modal } from '../../app/ui/Modal'
import { JOIN_CODE_RE, normalizeJoinCode } from './joinApi'

export function JoinCodeDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit(e: FormEvent) {
    e.preventDefault()
    const c = normalizeJoinCode(code)
    if (!JOIN_CODE_RE.test(c)) {
      setError(t('join.codeFormat'))
      return
    }
    // Router state, not the URL: keeps the code out of history/logs.
    navigate('/join', { state: { code: c } })
  }

  return (
    <Modal title={t('trips.joinWithCode')} onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        <label className="field">
          <span>{t('join.code')}</span>
          <input
            className="code-input"
            autoFocus
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={6}
            value={code}
            onChange={(e) => {
              setCode(normalizeJoinCode(e.target.value))
              setError(null)
            }}
            aria-invalid={!!error}
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <p className="muted small">{t('join.codeHint')}</p>
        <button type="submit" className="btn btn-primary btn-block" disabled={code.length !== 6}>
          {t('join.continue')}
        </button>
      </form>
    </Modal>
  )
}
