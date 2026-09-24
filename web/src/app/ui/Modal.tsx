import { useEffect, useEffectEvent, useId, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from './Icon'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

/** Bottom sheet on phones, centred dialog on wider screens. */
export function Modal({ title, onClose, children, footer }: Props) {
  const { t } = useTranslation()
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  // Callers pass an inline onClose, a new function on every render. As an
  // effect event it stays current without re-running the effect below, which
  // would pull focus out of a field in the dialog on each keystroke.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  })

  // Once per open: focus moves into the dialog, and back where it was on close.
  useEffect(() => {
    document.addEventListener('keydown', onKey)
    const prev = document.activeElement as HTMLElement | null
    // A field that focused itself (autoFocus) keeps focus.
    if (!panel.current?.contains(prev)) panel.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panel}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="modal-grabber" aria-hidden />
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('app.close')}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
