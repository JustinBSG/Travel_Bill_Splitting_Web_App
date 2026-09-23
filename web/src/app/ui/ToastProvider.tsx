import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { ToastContext, type ToastOptions } from './toast'

interface ToastItem extends ToastOptions {
  id: number
  message: string
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), [])

  const show = useCallback(
    (message: string, opts: ToastOptions = {}) => {
      const id = nextId.current++
      setItems((xs) => [...xs.slice(-2), { id, message, ...opts }])
      window.setTimeout(() => dismiss(id), opts.durationMs ?? (opts.action ? 6000 : 4000))
    },
    [dismiss],
  )

  const api = useMemo(() => ({ show }), [show])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone ?? 'info'}`}>
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="btn-link"
                onClick={() => {
                  t.action!.onClick()
                  dismiss(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
