import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import { ExpensePage } from '../features/expenses/ExpensePage'
import { BellButton } from '../features/notifications/BellButton'
import { LanguageSwitch } from '../features/settings/LanguageSwitch'
import { PaletteSwitch } from '../features/settings/PaletteSwitch'
import { ThemeSwitch } from '../features/settings/ThemeSwitch'
import { ConclusionPage } from '../features/settlement/ConclusionPage'
import { OverviewPage } from '../features/trips/OverviewPage'
import { useTripData } from '../features/trips/TripDataContext'
import { buildTripCsvFiles, deliverFiles } from '../features/trips/exportCsv'
import { usePageLabels } from '../features/trips/usePageLabels'
import { useTripWeather } from '../features/trips/useTripWeather'
import { isISODate, pageForLocalDate, todayIn, type PageKey } from '../lib/dates'
import { useFmt } from './useFmt'
import { useReducedMotion } from './useReducedMotion'
import { useToast } from './ui/toast'
import { Banner } from './ui/common'
import { Icon } from './ui/Icon'
import { Modal } from './ui/Modal'

function isExpensePage(k: PageKey) {
  return k !== 'overview' && k !== 'conclusion'
}

function isDayPage(k: PageKey) {
  return isExpensePage(k) && k !== 'pre' && k !== 'post'
}

/** 0 = Sunday ... 6 = Saturday, for an ISO date. */
function weekdayIndex(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

/**
 * Trip pages in a horizontal scroll-snap strip (native swipe on iOS/Android)
 * plus a chip strip to jump. URL is the source of truth: /trips/:id/:pageKey
 */
export function TripShell() {
  const { t } = useTranslation()
  const fmt = useFmt()
  const { pageKey = 'overview' } = useParams()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const data = useTripData()
  const { trip, pages, locked, me, isAdmin, days, tzForDate } = data
  const labels = usePageLabels()
  const weather = useTripWeather(days)
  const reduced = useReducedMotion()

  const index = pages.indexOf(pageKey)
  const swiper = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLElement>(null)
  const chips = useRef<(HTMLButtonElement | null)[]>([])
  /** Page index a programmatic scroll is heading to; null while the user drives. */
  const target = useRef<number | null>(null)
  const firstAlign = useRef(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  // ?expense=<id> (notification links): show that expense's day and flash its row.
  const flashId = params.get('expense')
  const flashExpense = flashId ? data.expenses.find((e) => e.id === flashId) : undefined
  const flashPage = flashExpense ? pageForLocalDate(flashExpense.local_date, trip) : null
  // Drop the param once the row has flashed, so back/refresh doesn't replay it.
  useEffect(() => {
    if (!flashId) return
    const id = window.setTimeout(() => {
      setParams(
        (p) => {
          p.delete('expense')
          return p
        },
        { replace: true },
      )
    }, 3000)
    return () => window.clearTimeout(id)
  }, [flashId, setParams])

  const go = useCallback(
    (key: PageKey) => navigate(`/trips/${trip.id}/${key}`, { replace: true }),
    [navigate, trip.id],
  )

  // Align the strip with the URL (chip tap, auto-move after save, resize).
  const align = useCallback(
    (smooth: boolean) => {
      const el = swiper.current
      if (!el || index < 0) return
      const left = index * el.clientWidth
      if (Math.abs(el.scrollLeft - left) < 2) return
      target.current = index
      const animate = smooth && !reduced
      el.scrollTo({ left, behavior: animate ? 'smooth' : 'instant' })
      // A smooth scroll can be cancelled (re-snap while pages swap in) or throttled
      // without emitting scroll events; make sure we still arrive.
      if (animate) {
        window.setTimeout(() => {
          if (target.current === index && Math.abs(el.scrollLeft - left) > 2) el.scrollTo({ left, behavior: 'instant' })
        }, 700)
      }
    },
    [index, reduced],
  )

  useLayoutEffect(() => {
    align(!firstAlign.current)
    firstAlign.current = false
    // Instant on purpose: a second concurrent smooth scroll can cancel the swiper's.
    const chip = chips.current[index]
    const bar = strip.current
    if (chip && bar) bar.scrollTo({ left: chip.offsetLeft - (bar.clientWidth - chip.clientWidth) / 2, behavior: 'instant' })
  }, [align, index])

  useEffect(() => {
    const onResize = () => align(false)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [align])

  // A real touch/wheel means the user is swiping: stop steering.
  const onUserInput = () => {
    target.current = null
  }

  // When scrolling settles: finish an interrupted programmatic scroll, or sync the URL to the user's swipe.
  const scrollTimer = useRef<number | undefined>(undefined)
  const onScroll = () => {
    window.clearTimeout(scrollTimer.current)
    scrollTimer.current = window.setTimeout(() => {
      const el = swiper.current
      if (!el) return
      const w = el.clientWidth
      if (target.current !== null) {
        const want = target.current * w
        if (Math.abs(el.scrollLeft - want) > 2) el.scrollTo({ left: want, behavior: 'instant' })
        else target.current = null
        return
      }
      const key = pages[Math.round(el.scrollLeft / w)]
      if (key && key !== pageKey) go(key)
    }, 120)
  }

  async function exportCsv() {
    setExporting(true)
    try {
      await deliverFiles(await buildTripCsvFiles(data, t))
      setMenuOpen(false)
    } catch (e) {
      toast.show(t('app.errorWith', { message: e instanceof Error ? e.message : String(e) }), { tone: 'error' })
    } finally {
      setExporting(false)
    }
  }

  if (flashId && flashPage && flashPage !== pageKey && pages.includes(flashPage)) {
    return <Navigate to={`/trips/${trip.id}/${flashPage}?expense=${encodeURIComponent(flashId)}`} replace />
  }
  if (index < 0) {
    // A date outside the trip (e.g. from a push link) lands on its pre/post page.
    const dated = isISODate(pageKey) ? pageForLocalDate(pageKey, trip) : null
    const to = dated && pages.includes(dated) ? dated : 'overview'
    return <Navigate to={`/trips/${trip.id}/${to}`} replace />
  }

  /** Text tab, or a tear-off-calendar tab (weekday over the date) for trip days. */
  const tab = (k: PageKey, active: boolean) => {
    if (!isDayPage(k)) return <span className="tab-text">{labels.short(k)}</span>
    const wd = weekdayIndex(k)
    return (
      <>
        <span className={`tab-wd${wd === 6 ? ' wd-sat' : wd === 0 ? ' wd-sun' : ''}`}>
          {fmt.weekday(k)}
          {todayIn(tzForDate(k)) === k && <span className="tab-today" aria-hidden />}
        </span>
        <span className={`tab-date${active ? ' active' : ''}`}>{Number(k.slice(8))}</span>
      </>
    )
  }
  const tabLabel = (k: PageKey) =>
    isDayPage(k) ? `${t('pages.day', { n: labels.dayNumber(k) })}, ${fmt.weekday(k)} ${fmt.dayMonth(k)}` : undefined

  return (
    <div className="trip-shell">
      <header className="topbar">
        <Link to="/trips" className="icon-btn" aria-label={t('trips.title')}>
          <Icon name="back" />
        </Link>
        <h1 className="topbar-title">
          {trip.name}
          {locked && (
            <span className="lock-inline" aria-label={t('lock.locked')}>
              {' '}
              <Icon name="lock" size={16} />
            </span>
          )}
        </h1>
        <div className="topbar-actions">
          <BellButton />
          <button type="button" className="icon-btn" aria-label={t('menu.title')} onClick={() => setMenuOpen(true)}>
            <Icon name="more" stroke={2.8} />
          </button>
        </div>
      </header>

      <nav className="tab-strip" aria-label={t('menu.pages')} ref={strip}>
        {pages.map((k, i) => (
          <button
            key={k}
            ref={(el) => {
              chips.current[i] = el
            }}
            type="button"
            className={`tab${isDayPage(k) ? ' tab-day' : ''}${i === index ? ' tab-active' : ''}`}
            aria-current={i === index ? 'page' : undefined}
            aria-label={tabLabel(k)}
            onClick={() => go(k)}
          >
            {tab(k, i === index)}
          </button>
        ))}
      </nav>

      {!me && (
        <Banner tone="warn">{t('trip.notMember')}</Banner>
      )}

      <div
        className="swiper"
        ref={swiper}
        onScroll={onScroll}
        onTouchStart={onUserInput}
        onWheel={onUserInput}
        onPointerDown={onUserInput}
      >
        {pages.map((k, i) => (
          <section key={k} className="swipe-page" aria-label={labels.short(k)}>
            {Math.abs(i - index) <= 1 &&
              (k === 'overview' ? (
                <OverviewPage />
              ) : k === 'conclusion' ? (
                <ConclusionPage />
              ) : (
                <ExpensePage page={k} weather={weather?.get(k)} highlight={i === index ? flashExpense?.id : undefined} />
              ))}
          </section>
        ))}
      </div>

      {isExpensePage(pageKey) && !locked && me && (
        <Link
          to={`/trips/${trip.id}/expense/new?page=${encodeURIComponent(pageKey)}`}
          className="fab"
        >
          <Icon name="plus" size={22} stroke={2.2} />
          <span>{t('expense.add')}</span>
        </Link>
      )}

      {menuOpen && (
        <Modal title={t('menu.title')} onClose={() => setMenuOpen(false)}>
          <ul className="menu-list">
            <li>
              <Link to={`/trips/${trip.id}/members`} className="menu-item">
                <Icon name="users" />
                <span className="grow">{t('menu.members')}</span>
                <Icon name="chevronRight" size={18} />
              </Link>
            </li>
            <li>
              <Link to={`/trips/${trip.id}/activity`} className="menu-item">
                <Icon name="history" />
                <span className="grow">{t('menu.activity')}</span>
                <Icon name="chevronRight" size={18} />
              </Link>
            </li>
            {isAdmin && (
              <li>
                <Link to={`/trips/${trip.id}/settings`} className="menu-item">
                  <Icon name="settings" />
                  <span className="grow">{t('menu.tripSettings')}</span>
                  <Icon name="chevronRight" size={18} />
                </Link>
              </li>
            )}
            <li>
              <button type="button" className="menu-item" disabled={exporting} onClick={() => void exportCsv()}>
                <Icon name="download" />
                <span className="grow">{exporting ? t('app.loading') : t('menu.exportCsv')}</span>
              </button>
            </li>
          </ul>
          <div className="menu-language">
            <span className="field-label">{t('settings.language')}</span>
            <LanguageSwitch />
            <span className="field-label">{t('settings.theme')}</span>
            <ThemeSwitch />
            <span className="field-label">{t('settings.palette')}</span>
            <PaletteSwitch />
          </div>
        </Modal>
      )}
    </div>
  )
}
