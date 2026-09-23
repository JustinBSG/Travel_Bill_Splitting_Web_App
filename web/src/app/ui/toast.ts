import { createContext, useContext } from 'react'

export interface ToastOptions {
  action?: { label: string; onClick: () => void }
  tone?: 'info' | 'error' | 'success'
  durationMs?: number
}

export interface ToastApi {
  show: (message: string, opts?: ToastOptions) => void
}

export const ToastContext = createContext<ToastApi>({ show: () => {} })

export function useToast(): ToastApi {
  return useContext(ToastContext)
}
