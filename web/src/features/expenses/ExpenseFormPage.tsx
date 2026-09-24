import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useFmt } from '../../app/useFmt'
import { useToast } from '../../app/ui/toast'
import { Avatar, Banner, ErrorBox, PageHeader } from '../../app/ui/common'
import { Icon } from '../../app/ui/Icon'
import { Modal } from '../../app/ui/Modal'
import { currencyDecimals, knownCurrencies } from '../../lib/currencies'
import {
  defaultDateForPage,
  isISODate,
  pageForLocalDate,
  timeNowIn,
  utcToLocalParts,
  zonedToUtcIso,
  type ExpensePageKey,
} from '../../lib/dates'
import {
  HKD,
  Dec,
  minorToMajorString,
  parseMajorInput,
  splitEqualPreview,
  toHkdCents,
  toMinor,
  toRate,
} from '../../lib/money'
import { CATEGORIES, type Category, type Expense, type SplitMethod } from '../../lib/types'
import { useTripData } from '../trips/TripDataContext'
import { usePageLabels } from '../trips/usePageLabels'
import { CATEGORY_META, categoryLabel } from './categories'
import {
  createExpense,
  restoreExpense,
  signedPhotoUrl,
  softDeleteExpense,
  updateExpense,
  uploadPhoto,
  type ExpenseInput,
  type ParticipantInput,
} from './expenseApi'
import { evaluateExactSplit, isExactSplitComplete } from './exactSplit'
import { preparePhoto } from './photo'

function isPageKey(s: string | null): s is ExpensePageKey {
  return s === 'pre' || s === 'post' || isISODate(s)
}

/** Route: /trips/:tripId/expense/new?page=… and /trips/:tripId/expense/:expenseId?page=… */
export function ExpenseFormPage() {
  const { t } = useTranslation()
  const { expenseId } = useParams()
  const [params] = useSearchParams()
  const { trip, expenses } = useTripData()
  const [version, setVersion] = useState(0)

  const existing = expenseId ? (expenses.find((e) => e.id === expenseId) ?? null) : null
  const rawPage = params.get('page')
  const originPage: ExpensePageKey = isPageKey(rawPage)
    ? rawPage
    : existing
      ? pageForLocalDate(existing.local_date, trip)
      : 'pre'

  if (expenseId && !existing) {
    return (
      <div className="screen">
        <PageHeader title={t('form.editTitle')} backTo={`/trips/${trip.id}/${originPage}`} />
        <main className="content stack">
          <p>{t('form.notFound')}</p>
          <Link className="btn" to={`/trips/${trip.id}/${originPage}`}>
            {t('app.back')}
          </Link>
        </main>
      </div>
    )
  }

  return (
    <ExpenseForm
      key={`${existing?.id ?? 'new'}:${version}`}
      existing={existing}
      originPage={originPage}
      onReloadLatest={() => setVersion((v) => v + 1)}
    />
  )
}

interface FormProps {
  existing: Expense | null
  originPage: ExpensePageKey
  onReloadLatest: () => void
}

function ExpenseForm({ existing, originPage, onReloadLatest }: FormProps) {
  const { t } = useTranslation()
  const fmt = useFmt()
  const toast = useToast()
  const navigate = useNavigate()
  const labels = usePageLabels()
  const data = useTripData()
  const { trip, me, members, activeMembers, memberById, locked, tzForDate, currencyForDate, rateFor, reload } = data

  // ---- initial state (read once at mount) ----
  const [init] = useState(() => {
    if (existing) {
      const local = utcToLocalParts(existing.occurred_at, existing.timezone)
      return {
        title: existing.title,
        amountText: minorToMajorString(toMinor(existing.amount), existing.currency),
        currency: existing.currency,
        currencyManual: existing.currency_manually_set,
        paidBy: existing.paid_by,
        participants: existing.expense_participants.map((p) => p.member_id),
        splitMethod: (existing.split_method === 'exact' ? 'exact' : 'equal') as SplitMethod,
        exactTexts:
          existing.split_method === 'exact'
            ? Object.fromEntries(
                existing.expense_participants.map((p) => [
                  p.member_id,
                  minorToMajorString(toMinor(p.share_amount), existing.currency),
                ]),
              )
            : ({} as Record<string, string>),
        date: existing.local_date,
        time: local.time,
        category: existing.category,
        multiDay: !!existing.end_date,
        endDate: existing.end_date ?? existing.local_date,
        locationText: existing.location_text ?? '',
        lat: existing.latitude,
        lng: existing.longitude,
        note: existing.note ?? '',
      }
    }
    const date = defaultDateForPage(originPage, trip)
    return {
      title: '',
      amountText: '',
      currency: currencyForDate(date),
      currencyManual: false,
      paidBy: me?.id ?? activeMembers[0]?.id ?? '',
      participants: activeMembers.map((m) => m.id),
      splitMethod: 'equal' as SplitMethod,
      exactTexts: {} as Record<string, string>,
      date,
      time: timeNowIn(tzForDate(date)),
      category: 'Food & Drink' as Category,
      multiDay: false,
      endDate: date,
      locationText: '',
      lat: null as number | null,
      lng: null as number | null,
      note: '',
    }
  })

  const [title, setTitle] = useState(init.title)
  const [amountText, setAmountText] = useState(init.amountText)
  const [currency, setCurrency] = useState(init.currency)
  const [currencyManual, setCurrencyManual] = useState(init.currencyManual)
  const [paidBy, setPaidBy] = useState(init.paidBy)
  const [participants, setParticipants] = useState<string[]>(init.participants)
  const [splitMethod, setSplitMethod] = useState<SplitMethod>(init.splitMethod)
  const [exactTexts, setExactTexts] = useState<Record<string, string>>(init.exactTexts)
  const [date, setDate] = useState(init.date)
  const [time, setTime] = useState(init.time)
  const [category, setCategory] = useState<Category>(init.category)
  const [multiDay, setMultiDay] = useState(init.multiDay)
  const [endDate, setEndDate] = useState(init.endDate)
  const [locationText, setLocationText] = useState(init.locationText)
  const [coords, setCoords] = useState<{ lat: number | null; lng: number | null }>({ lat: init.lat, lng: init.lng })
  const [note, setNote] = useState(init.note)
  const [photoPath, setPhotoPath] = useState<string | null>(existing?.photo_path ?? null)
  const [newPhoto, setNewPhoto] = useState<{ blob: Blob; url: string; stripped: boolean } | null>(null)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)

  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [geoBusy, setGeoBusy] = useState(false)
  const cameraInput = useRef<HTMLInputElement>(null)
  const galleryInput = useRef<HTMLInputElement>(null)

  // Existing photo: private bucket -> short-lived signed URL.
  useEffect(() => {
    if (!photoPath) return
    let alive = true
    signedPhotoUrl(photoPath).then((u) => alive && setPhotoUrl(u))
    return () => {
      alive = false
    }
  }, [photoPath])

  useEffect(() => {
    if (!newPhoto) return
    return () => URL.revokeObjectURL(newPhoto.url)
  }, [newPhoto])

  // Keep the saved timezone when the date is unchanged (location edits only
  // affect new expenses); otherwise use the new date's location timezone.
  const tz = existing && date === existing.local_date ? existing.timezone : tzForDate(date)
  const decimals = currencyDecimals(currency)
  const parsed = parseMajorInput(amountText, currency)
  // Live "≈ HK$" hint only; the server locks the real rate on save.
  const hintRate = parsed.ok && currency !== HKD ? rateFor(currency) : null
  const hkdHint = hintRate && parsed.ok ? toHkdCents(parsed.minor, currency, hintRate) : null
  const avatarIndex = (id: string) => Math.max(0, members.findIndex((m) => m.id === id))

  const payerOptions = useMemo(() => {
    const list = activeMembers.slice()
    const current = memberById.get(paidBy)
    if (current && current.removed_at) list.push(current)
    return list
  }, [activeMembers, memberById, paidBy])

  const toOptions = useMemo(() => {
    const list = activeMembers.slice()
    const ids = new Set([...participants, ...Object.keys(exactTexts).filter((k) => exactTexts[k].trim())])
    for (const id of ids) {
      const m = memberById.get(id)
      if (m && m.removed_at && !list.includes(m)) list.push(m)
    }
    return list
  }, [activeMembers, memberById, participants, exactTexts])

  // Preview only (discarded after save); server rows are the truth.
  const preview = parsed.ok && participants.length > 0 ? splitEqualPreview(parsed.minor, participants) : null
  const previewValues = preview ? [...preview.values()] : []
  const previewMin = previewValues.length ? Dec.min(...previewValues) : null
  const previewMax = previewValues.length ? Dec.max(...previewValues) : null

  // AB: each person's typed amount; must add up to the total.
  const exact = evaluateExactSplit(
    parsed.ok ? parsed.minor : null,
    exactTexts,
    toOptions.map((m) => m.id),
    currency,
  )

  function changeSplitMethod(next: SplitMethod) {
    if (next === splitMethod) return
    if (next === 'exact') {
      // Start from the equal split of the current To list so the user only adjusts.
      const hasTexts = Object.values(exactTexts).some((v) => v.trim())
      if (!hasTexts && preview) {
        setExactTexts(Object.fromEntries([...preview].map(([id, v]) => [id, minorToMajorString(v, currency)])))
      }
    } else if (exact.shares.size) {
      setParticipants([...exact.shares.keys()])
    }
    setSplitMethod(next)
  }

  function setExactText(id: string, text: string) {
    setExactTexts((xs) => ({ ...xs, [id]: text }))
  }

  /** "+ Rest": give whatever is still unassigned to this person. */
  function addRemainingTo(id: string) {
    if (!exact.remaining || !exact.remaining.isPositive() || exact.remaining.isZero()) return
    const current = exact.shares.get(id) ?? new Dec(0)
    setExactText(id, minorToMajorString(current.plus(exact.remaining), currency))
  }

  const allCurrencies = useMemo(() => [...new Set([currency, ...knownCurrencies()])], [currency])

  function changeDate(d: string) {
    setDate(d)
    if (!currencyManual && isISODate(d)) setCurrency(currencyForDate(d))
    if (multiDay && d > endDate) setEndDate(d)
  }

  function toggleParticipant(id: string) {
    setParticipants((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]))
  }

  async function pickPhoto(file: File | undefined) {
    if (!file) return
    const prepared = await preparePhoto(file)
    setNewPhoto({ blob: prepared.blob, url: URL.createObjectURL(prepared.blob), stripped: prepared.stripped })
  }

  function fillMyLocation() {
    if (!navigator.geolocation) return
    setGeoBusy(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoBusy(false)
        const lat = Number(pos.coords.latitude.toFixed(5))
        const lng = Number(pos.coords.longitude.toFixed(5))
        setCoords({ lat, lng })
        if (!locationText.trim()) setLocationText(`${lat}, ${lng}`)
      },
      () => {
        setGeoBusy(false)
        toast.show(t('form.geoFailed'), { tone: 'error' })
      },
      { enableHighAccuracy: true, timeout: 10000 },
    )
  }

  const errors = {
    title: !title.trim(),
    amount: !parsed.ok,
    date: !isISODate(date),
    time: !/^\d{2}:\d{2}$/.test(time),
    paidBy: !paidBy,
    endDate: multiDay && (!isISODate(endDate) || endDate <= date),
    split: splitMethod === 'exact' && !isExactSplitComplete(exact),
  }
  const hasErrors = Object.values(errors).some(Boolean)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSubmitted(true)
    if (hasErrors || !parsed.ok || saving || locked) return
    setSaving(true)
    setError(null)
    try {
      let finalPhoto = photoPath
      if (newPhoto) finalPhoto = await uploadPhoto(trip.id, newPhoto.blob)
      const input: ExpenseInput = {
        title: title.trim(),
        category,
        amount: parsed.minor,
        currency,
        paid_by: paidBy,
        occurred_at: zonedToUtcIso(date, time, tz),
        timezone: tz,
        local_date: date,
        end_date: multiDay ? endDate : null,
        location_text: locationText.trim() || null,
        latitude: coords.lat,
        longitude: coords.lng,
        photo_path: finalPhoto,
        note: note.trim() || null,
        currency_manually_set: currencyManual,
        split_method: splitMethod,
      }
      const people: ParticipantInput[] =
        splitMethod === 'exact'
          ? [...exact.shares].map(([member_id, share_amount]) => ({ member_id, share_amount }))
          : participants.map((member_id) => ({ member_id }))
      let saved: Expense
      if (existing) {
        const res = await updateExpense(existing, input, people)
        if (!res.ok) {
          setConflict(true)
          setSaving(false)
          return
        }
        saved = res.expense
      } else {
        saved = await createExpense(trip.id, input, people)
      }
      await reload(['expenses'])
      // Auto-move: the saved local_date decides the page.
      const target = pageForLocalDate(saved.local_date, trip)
      if (target !== originPage) toast.show(t('form.moved', { page: labels.withPlace(target) }))
      else toast.show(existing ? t('form.updated') : t('form.added'), { tone: 'success' })
      navigate(`/trips/${trip.id}/${target}`, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  async function doDelete() {
    if (!existing) return
    setSaving(true)
    try {
      const res = await softDeleteExpense(existing)
      if (res === 'conflict') {
        setConfirmDelete(false)
        setConflict(true)
        setSaving(false)
        return
      }
      await reload(['expenses'])
      toast.show(t('form.deleted'), {
        action: {
          label: t('form.undo'),
          onClick: () => void restoreExpense(existing.id).then(() => reload(['expenses'])),
        },
      })
      navigate(`/trips/${trip.id}/${originPage}`, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  const back = `/trips/${trip.id}/${originPage}`
  const readOnly = locked

  return (
    <div className="screen">
      <PageHeader title={existing ? t('form.editTitle') : t('form.addTitle')} backTo={back} />
      <main className="content">
        {locked && (
          <Banner tone="lock">
            <Icon name="lock" size={16} /> {t('lock.formReadOnly')}
          </Banner>
        )}
        {conflict && (
          <Banner tone="warn">
            <span>{t('form.conflict')}</span>{' '}
            <button
              type="button"
              className="btn btn-small"
              onClick={async () => {
                await reload(['expenses'])
                onReloadLatest()
              }}
            >
              {t('form.loadLatest')}
            </button>
          </Banner>
        )}
        {error && <ErrorBox message={error} />}

        <form className="stack" onSubmit={submit} noValidate>
          <fieldset disabled={readOnly || saving} className="stack plain-fieldset">
            <label className="field">
              <span>{t('form.title')}</span>
              <input
                value={title}
                maxLength={120}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('form.titlePlaceholder')}
                aria-invalid={submitted && errors.title}
              />
              {submitted && errors.title && <span className="error-text">{t('form.required')}</span>}
            </label>

            <div className="field">
              <label htmlFor="amount-input" className="field-label">
                {t('form.amount')}
              </label>
              <div className="amount-row">
                <label className="currency-field">
                  <span className="sr-only">{t('form.currency')}</span>
                  <select
                    value={currency}
                    onChange={(e) => {
                      setCurrency(e.target.value)
                      setCurrencyManual(true)
                    }}
                  >
                    {allCurrencies.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevronDown" size={18} />
                </label>
                <input
                  id="amount-input"
                  className="amount-input"
                  inputMode={decimals > 0 ? 'decimal' : 'numeric'}
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  placeholder={decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0'}
                  aria-invalid={submitted && errors.amount}
                />
              </div>
              {(submitted || (amountText && !parsed.ok)) && !parsed.ok ? (
                <span className="error-text">
                  {parsed.error === 'decimals'
                    ? decimals === 0
                      ? t('form.amountNoDecimals', { currency })
                      : t('form.amountDecimals', { count: decimals, currency })
                    : parsed.error === 'empty'
                      ? t('form.required')
                      : t('form.amountInvalid')}
                </span>
              ) : (
                hkdHint && <span className="muted small align-end">≈ {fmt.money(hkdHint, HKD)}</span>
              )}
            </div>

            {existing && existing.fx_rate_to_hkd !== null && existing.currency !== HKD && (
              <p className="muted small">
                {t('form.lockedRate', {
                  rate: toRate(existing.fx_rate_to_hkd).toSignificantDigits(6).toString(),
                  currency: existing.currency,
                  date: existing.fx_rate_date ? fmt.dayMonth(existing.fx_rate_date) : '—',
                })}
                {existing.amount_hkd !== null && ` · ${fmt.money(existing.amount_hkd, HKD)}`}
              </p>
            )}

            <div className="row-gap">
              <label className="field grow">
                <span>{t('form.date')}</span>
                <input type="date" value={date} onChange={(e) => changeDate(e.target.value)} aria-invalid={submitted && errors.date} />
              </label>
              <label className="field grow">
                <span>
                  {t('form.time')} <span className="muted small">({t('expense.localTime', { city: labels.tzLabel(tz, date) })})</span>
                </span>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-invalid={submitted && errors.time} />
              </label>
            </div>
            {isISODate(date) && pageForLocalDate(date, trip) !== originPage && (
              <p className="muted small">{t('form.willMove', { page: labels.withPlace(pageForLocalDate(date, trip)) })}</p>
            )}

            <fieldset className="field">
              <legend>{t('form.paidBy')}</legend>
              <div className="chip-row">
                {payerOptions.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`person-chip${paidBy === m.id ? ' active' : ''}${m.user_id ? '' : ' placeholder'}`}
                    aria-pressed={paidBy === m.id}
                    onClick={() => setPaidBy(m.id)}
                  >
                    <Avatar name={m.display_name} index={avatarIndex(m.id)} placeholder={!m.user_id} />
                    <span>
                      {m.display_name}
                      {m.id === me?.id ? ` (${t('app.you')})` : ''}
                      {m.removed_at ? ` · ${t('members.left')}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="field">
              <legend>{t('form.splitMethod')}</legend>
              <div className="segmented" role="group" aria-label={t('form.splitMethod')}>
                <button
                  type="button"
                  className={splitMethod === 'equal' ? 'active' : ''}
                  aria-pressed={splitMethod === 'equal'}
                  onClick={() => changeSplitMethod('equal')}
                >
                  {t('form.splitEqual')}
                </button>
                <button
                  type="button"
                  className={splitMethod === 'exact' ? 'active' : ''}
                  aria-pressed={splitMethod === 'exact'}
                  onClick={() => changeSplitMethod('exact')}
                >
                  {t('form.splitExact')}
                </button>
              </div>
            </fieldset>

            {splitMethod === 'exact' ? (
              <fieldset className="field">
                <legend>{t('form.exactTitle')}</legend>
                <p className="muted small">{t('form.exactHint')}</p>
                <ul className="exact-list sheet-list">
                  {toOptions.map((m) => {
                    const bad = exact.invalid.includes(m.id)
                    const canAddRest = !!exact.remaining && exact.remaining.isPositive() && !exact.remaining.isZero()
                    return (
                      <li key={m.id} className="exact-row">
                        <label htmlFor={`exact-${m.id}`} className="exact-name">
                          {m.display_name}
                          {m.id === me?.id ? ` (${t('app.you')})` : ''}
                          {m.id === paidBy && <span className="badge">{t('form.payer')}</span>}
                          {!m.user_id && <span className="badge badge-muted">{t('members.placeholder')}</span>}
                          {m.removed_at && <span className="badge badge-muted">{t('members.left')}</span>}
                        </label>
                        <input
                          id={`exact-${m.id}`}
                          className="exact-input"
                          inputMode={decimals > 0 ? 'decimal' : 'numeric'}
                          placeholder="—"
                          value={exactTexts[m.id] ?? ''}
                          onChange={(e) => setExactText(m.id, e.target.value)}
                          aria-invalid={bad}
                        />
                        <button
                          type="button"
                          className="btn btn-small exact-rest"
                          disabled={!canAddRest}
                          onClick={() => addRemainingTo(m.id)}
                          aria-label={t('form.addRestFor', { name: m.display_name })}
                        >
                          {t('form.addRest')}
                        </button>
                        {bad && <span className="error-text small exact-error">{t('form.exactInvalid')}</span>}
                      </li>
                    )
                  })}
                </ul>
                {exact.remaining === null ? (
                  <p className="muted small">{t('form.exactNeedTotal')}</p>
                ) : exact.remaining.isZero() && exact.shares.size > 0 ? (
                  <p className="pos small">✓ {t('form.exactOk', { amount: fmt.money(exact.assigned, currency) })}</p>
                ) : exact.remaining.isPositive() ? (
                  <p className="banner banner-warn small">
                    {t('form.exactLeft', { amount: fmt.money(exact.remaining, currency) })}
                  </p>
                ) : (
                  <p className="banner banner-error small">
                    {t('form.exactOver', { amount: fmt.money(exact.remaining.abs(), currency) })}
                  </p>
                )}
              </fieldset>
            ) : (
            <fieldset className="field">
              <legend className="legend-row">
                <span>{t('form.to')}</span>
                <span className="row-gap">
                  <button type="button" className="btn-link" onClick={() => setParticipants(activeMembers.map((m) => m.id))}>
                    {t('form.everyone')}
                  </button>
                  <button type="button" className="btn-link" onClick={() => setParticipants([])}>
                    {t('form.clear')}
                  </button>
                </span>
              </legend>
              <ul className="check-list sheet-list">
                {toOptions.map((m) => (
                  <li key={m.id}>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={participants.includes(m.id)}
                        onChange={() => toggleParticipant(m.id)}
                      />
                      <Avatar name={m.display_name} index={avatarIndex(m.id)} placeholder={!m.user_id} size={30} />
                      <span>
                        {m.display_name}
                        {m.id === me?.id ? ` (${t('app.you')})` : ''}
                        {!m.user_id && <span className="badge badge-muted">{t('members.placeholder')}</span>}
                        {m.removed_at && <span className="badge badge-muted">{t('members.left')}</span>}
                      </span>
                      {preview?.get(m.id) && <span className="muted small">{fmt.money(preview.get(m.id)!, currency)}</span>}
                    </label>
                  </li>
                ))}
              </ul>
              {participants.length === 0 ? (
                <p className="banner banner-info small">{t('form.personalNote')}</p>
              ) : (
                previewMin &&
                previewMax && (
                  <p className="muted small">
                    {previewMin.eq(previewMax)
                      ? t('form.eachPreview', { amount: fmt.money(previewMin, currency) })
                      : t('form.eachPreviewRange', {
                          min: fmt.money(previewMin, currency),
                          max: fmt.money(previewMax, currency),
                        })}
                  </p>
                )
              )}
            </fieldset>
            )}

            <fieldset className="field">
              <legend>{t('form.category')}</legend>
              <div className="category-grid">
                {CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`category-btn ${category === c ? 'active' : ''}`}
                    aria-pressed={category === c}
                    onClick={() => setCategory(c)}
                  >
                    <Icon name={CATEGORY_META[c].icon} size={20} />
                    <span>{categoryLabel(t, c)}</span>
                  </button>
                ))}
              </div>
              {category === 'Loan' && <p className="muted small">{t('form.loanNote')}</p>}
            </fieldset>

            <label className="check-row">
              <input type="checkbox" checked={multiDay} onChange={(e) => setMultiDay(e.target.checked)} />
              <span>{t('form.multiDay')}</span>
            </label>
            {multiDay && (
              <label className="field">
                <span>{t('form.endDate')}</span>
                <input
                  type="date"
                  min={date}
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  aria-invalid={submitted && errors.endDate}
                />
                {submitted && errors.endDate && <span className="error-text">{t('form.endDateAfter')}</span>}
              </label>
            )}

            <details className="more-fields" open={!!(existing?.location_text || existing?.note || existing?.photo_path)}>
              <summary>{t('form.optional')}</summary>
              <div className="stack">
                <label className="field">
                  <span>{t('form.location')}</span>
                  <div className="row-gap">
                    <input className="grow" value={locationText} maxLength={200} onChange={(e) => setLocationText(e.target.value)} />
                    <button type="button" className="btn btn-icon" onClick={fillMyLocation} disabled={geoBusy} aria-label={t('form.useLocation')}>
                      <Icon name="pin" size={18} />
                    </button>
                  </div>
                </label>

                <div className="field">
                  <span>{t('form.photo')}</span>
                  <div className="row-gap">
                    <button type="button" className="btn grow" onClick={() => cameraInput.current?.click()}>
                      <Icon name="camera" size={18} /> {t('form.takePhoto')}
                    </button>
                    <button type="button" className="btn grow" onClick={() => galleryInput.current?.click()}>
                      <Icon name="image" size={18} /> {t('form.choosePhoto')}
                    </button>
                  </div>
                  <input
                    ref={cameraInput}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    hidden
                    onChange={(e) => void pickPhoto(e.target.files?.[0])}
                  />
                  <input
                    ref={galleryInput}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => void pickPhoto(e.target.files?.[0])}
                  />
                  {(newPhoto || (photoPath && photoUrl)) && (
                    <div className="photo-preview">
                      <a href={newPhoto?.url ?? photoUrl ?? '#'} target="_blank" rel="noreferrer">
                        <img src={newPhoto?.url ?? photoUrl ?? ''} alt={t('form.photo')} />
                      </a>
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => {
                          setNewPhoto(null)
                          setPhotoPath(null)
                          setPhotoUrl(null)
                        }}
                      >
                        {t('form.removePhoto')}
                      </button>
                    </div>
                  )}
                  {newPhoto && !newPhoto.stripped && <p className="banner banner-warn small">{t('form.photoLocationWarning')}</p>}
                  {newPhoto?.stripped && <p className="muted small">{t('form.photoStripped')}</p>}
                </div>

                <label className="field">
                  <span>{t('form.note')}</span>
                  <textarea rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
                </label>
              </div>
            </details>
          </fieldset>

          {!readOnly && (
            <div className="form-actions">
              {submitted && hasErrors && <p className="error-text">{t('form.fixErrors')}</p>}
              <button type="submit" className="btn btn-primary btn-block btn-large" disabled={saving}>
                {saving ? t('app.saving') : t('app.save')}
              </button>
              {existing && (
                <button type="button" className="btn btn-danger btn-block" disabled={saving} onClick={() => setConfirmDelete(true)}>
                  <Icon name="trash" size={18} /> {t('app.delete')}
                </button>
              )}
            </div>
          )}
        </form>
      </main>

      {confirmDelete && existing && (
        <Modal
          title={t('form.deleteTitle')}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                {t('app.cancel')}
              </button>
              <button type="button" className="btn btn-danger" disabled={saving} onClick={() => void doDelete()}>
                {t('app.delete')}
              </button>
            </>
          }
        >
          <p>{t('form.deleteBody', { title: existing.title })}</p>
        </Modal>
      )}
    </div>
  )
}
