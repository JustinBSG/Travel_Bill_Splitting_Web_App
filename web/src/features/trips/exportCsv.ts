// Client-generated CSV export (brief §3.12): <trip>_expenses.csv + <trip>_summary.csv
import type { TFunction } from 'i18next'
import { csvBlob, safeFileName, toCsv, type Cell } from '../../lib/csv'
import { diffDays, pageForLocalDate, utcToLocalParts } from '../../lib/dates'
import { HKD, ZERO, minorToMajorString, toMinor, toRate } from '../../lib/money'
import { suggestAllInHkd } from '../../lib/settlement'
import { PHOTO_BUCKET, supabase } from '../../lib/supabase'
import { categoryLabel } from '../expenses/categories'
import { computeStats } from '../settlement/stats'
import type { TripData } from './TripDataContext'

const PHOTO_LINK_TTL = 7 * 24 * 3600

export async function buildTripCsvFiles(data: TripData, t: TFunction): Promise<File[]> {
  const { trip, expenses, members, memberName, nets, rateFor } = data
  const sorted = [...expenses].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))

  // Signed links for photo proof (private bucket).
  const paths = sorted.map((e) => e.photo_path).filter((p): p is string => !!p)
  const links = new Map<string, string>()
  if (paths.length) {
    const { data: signed } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(paths, PHOTO_LINK_TTL)
    for (const s of signed ?? []) if (s.path && s.signedUrl) links.set(s.path, s.signedUrl)
  }

  const pageName = (localDate: string) => {
    const p = pageForLocalDate(localDate, trip)
    if (p === 'pre') return t('pages.pre')
    if (p === 'post') return t('pages.post')
    return `${t('pages.day', { n: diffDays(trip.start_date, p) + 1 })} (${p})`
  }

  const expenseRows: Cell[][] = [
    [
      'date', 'time', 'timezone', 'page', 'title', 'category', 'amount', 'currency',
      'rate_to_hkd', 'amount_hkd', 'paid_by', 'to_members', 'share_each',
      'personal', 'multi_day_end', 'location', 'note', 'photo_link',
    ],
  ]
  for (const e of sorted) {
    const personal = e.expense_participants.length === 0
    expenseRows.push([
      e.local_date,
      utcToLocalParts(e.occurred_at, e.timezone).time,
      e.timezone,
      pageName(e.local_date),
      e.title,
      categoryLabel(t, e.category),
      minorToMajorString(toMinor(e.amount), e.currency),
      e.currency,
      e.fx_rate_to_hkd === null ? '' : toRate(e.fx_rate_to_hkd).toString(),
      e.amount_hkd === null ? '' : minorToMajorString(toMinor(e.amount_hkd), HKD),
      memberName(e.paid_by),
      e.expense_participants.map((p) => memberName(p.member_id)).join('; '),
      e.expense_participants
        .map((p) => `${memberName(p.member_id)}: ${minorToMajorString(toMinor(p.share_amount), e.currency)}`)
        .join('; '),
      personal ? 'Y' : 'N',
      e.end_date ?? '',
      e.location_text ?? '',
      e.note ?? '',
      e.photo_path ? (links.get(e.photo_path) ?? e.photo_path) : '',
    ])
  }

  const stats = computeStats(expenses, members.map((m) => m.id), trip)
  const hkd = suggestAllInHkd(nets, rateFor)
  const summaryRows: Cell[][] = [['member', 'total_paid_hkd', 'total_share_hkd', 'balance_hkd']]
  for (const m of members) {
    const s = stats.perMember.get(m.id)
    summaryRows.push([
      m.display_name + (m.removed_at ? ` (${t('members.left')})` : ''),
      minorToMajorString(s?.paidHkd ?? ZERO, HKD),
      minorToMajorString(s?.shareHkd ?? ZERO, HKD),
      minorToMajorString(hkd.balances.get(m.id) ?? ZERO, HKD),
    ])
  }
  summaryRows.push([])
  summaryRows.push(['who_pays_whom', '', '', ''])
  summaryRows.push(['from', 'to', 'amount_hkd', `rates_as_of ${data.rates.date ?? ''}`])
  for (const tr of hkd.transfers) {
    summaryRows.push([memberName(tr.from), memberName(tr.to), minorToMajorString(tr.amount, HKD), ''])
  }
  if (hkd.missingRates.length) summaryRows.push([`missing_rates: ${hkd.missingRates.join(' ')}`])

  const base = safeFileName(trip.name)
  return [
    new File([csvBlob(toCsv(expenseRows))], `${base}_expenses.csv`, { type: 'text/csv' }),
    new File([csvBlob(toCsv(summaryRows))], `${base}_summary.csv`, { type: 'text/csv' }),
  ]
}

/** Share sheet with files where supported (iOS), otherwise two downloads. */
export async function deliverFiles(files: File[]): Promise<void> {
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files })
      return
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
    }
  }
  for (const f of files) {
    const url = URL.createObjectURL(f)
    const a = document.createElement('a')
    a.href = url
    a.download = f.name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    await new Promise((r) => setTimeout(r, 400))
  }
}
