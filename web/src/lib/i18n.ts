import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '../locales/en'
import zhHant from '../locales/zh-Hant'
import type { Language } from './types'

const STORAGE_KEY = 'tbs-lang'

/** zh-HK / zh-TW / zh-MO / zh-Hant* -> zh-Hant, everything else -> en. */
export function detectDeviceLanguage(langs: readonly string[] = navigator.languages ?? [navigator.language]): Language {
  for (const raw of langs) {
    const l = raw.toLowerCase()
    if (l.startsWith('zh-hant') || l === 'zh-hk' || l === 'zh-tw' || l === 'zh-mo') return 'zh-Hant'
    if (l.startsWith('zh-hk') || l.startsWith('zh-tw') || l.startsWith('zh-mo')) return 'zh-Hant'
  }
  return 'en'
}

function storedLanguage(): Language | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'en' || v === 'zh-Hant' ? v : null
  } catch {
    return null
  }
}

/** Intl locale used for dates / numbers / currency formatting. */
export function intlLocale(lang: string): string {
  return lang === 'zh-Hant' ? 'zh-HK' : 'en-HK'
}

export function setLanguage(lang: Language) {
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    /* private mode */
  }
  document.documentElement.lang = lang === 'zh-Hant' ? 'zh-Hant' : 'en'
  void i18n.changeLanguage(lang)
}

const initial = storedLanguage() ?? detectDeviceLanguage()
document.documentElement.lang = initial

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, 'zh-Hant': { translation: zhHant } },
  lng: initial,
  fallbackLng: 'en',
  supportedLngs: ['en', 'zh-Hant'],
  interpolation: { escapeValue: false }, // React escapes
  returnNull: false,
})

export default i18n
