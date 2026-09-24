// Appearance (light / dark) and colour theme (palette), both saved per device
// (localStorage, not the profile). 'system' follows the phone setting live.
// index.html applies both before first paint; keep the two in sync.
import { useSyncExternalStore } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
export type Palette = 'washi' | 'classic'

const KEY = 'tbs-theme'
const PALETTE_KEY = 'tbs-palette'
const DARK_QUERY = '(prefers-color-scheme: dark)'
/** Matches the top bar background so the browser/status bar blends in. */
const THEME_COLOR: Record<Palette, { light: string; dark: string }> = {
  washi: { light: '#f3eee3', dark: '#1b1916' },
  classic: { light: '#ffffff', dark: '#111827' },
}
/** Browser-tab icon per colour theme. The installed home-screen icon is fixed (manifest). */
const FAVICON: Record<Palette, string> = { washi: '/favicon.svg', classic: '/favicon-classic.svg' }

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

function readPalette(): Palette {
  try {
    return localStorage.getItem(PALETTE_KEY) === 'classic' ? 'classic' : 'washi'
  } catch {
    return 'washi'
  }
}

function systemIsDark(): boolean {
  return window.matchMedia?.(DARK_QUERY).matches ?? false
}

function apply() {
  const theme = pref === 'system' ? (systemIsDark() ? 'dark' : 'light') : pref
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.setAttribute('data-palette', palette)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[palette][theme])
  document.querySelector('link[rel="icon"]')?.setAttribute('href', FAVICON[palette])
}

let pref: ThemePref = readPref()
let palette: Palette = readPalette()
const listeners = new Set<() => void>()

if (typeof window !== 'undefined') {
  apply()
  window.matchMedia?.(DARK_QUERY).addEventListener('change', () => {
    if (pref === 'system') apply()
  })
}

function save(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* private mode: still applies for this session */
  }
}

export function setThemePref(p: ThemePref) {
  pref = p
  save(KEY, p === 'system' ? null : p)
  apply()
  listeners.forEach((l) => l())
}

export function setPalette(p: Palette) {
  palette = p
  save(PALETTE_KEY, p === 'washi' ? null : p)
  apply()
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

export function usePalette(): Palette {
  return useSyncExternalStore(subscribe, () => palette)
}
