// Light / dark mode. The preference is per device (localStorage); 'system'
// follows the phone setting live. index.html applies it before first paint.
import { useSyncExternalStore } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'tbs-theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'
/** Matches the top bar (--surface) so the browser/status bar blends in. */
const THEME_COLOR = { light: '#ffffff', dark: '#111827' }

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

function systemIsDark(): boolean {
  return window.matchMedia?.(DARK_QUERY).matches ?? false
}

function apply(p: ThemePref) {
  const theme = p === 'system' ? (systemIsDark() ? 'dark' : 'light') : p
  document.documentElement.setAttribute('data-theme', theme)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme])
}

let pref: ThemePref = readPref()
const listeners = new Set<() => void>()

if (typeof window !== 'undefined') {
  apply(pref)
  window.matchMedia?.(DARK_QUERY).addEventListener('change', () => {
    if (pref === 'system') apply('system')
  })
}

export function setThemePref(p: ThemePref) {
  pref = p
  try {
    if (p === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, p)
  } catch {
    /* private mode: still applies for this session */
  }
  apply(p)
  listeners.forEach((l) => l())
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, () => pref)
}
