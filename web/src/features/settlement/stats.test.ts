import { describe, expect, it } from 'vitest'
import type { Expense } from '../../lib/types'
import { computeStats, pageTotalHkd } from './stats'

const trip = { start_date: '2026-10-12', end_date: '2026-10-15' }

function e(p: Partial<Expense> & Pick<Expense, 'id' | 'paid_by' | 'amount' | 'currency' | 'amount_hkd'>): Expense {
  return {
    trip_id: 't',
    title: p.id,
    category: 'Food & Drink',
    occurred_at: '2026-10-12T03:00:00Z',
    timezone: 'Asia/Seoul',
    local_date: '2026-10-12',
    end_date: null,
    location_text: null,
    latitude: null,
    longitude: null,
    photo_path: null,
    note: null,
    fx_rate_to_hkd: null,
    fx_rate_date: null,
    currency_manually_set: false,
    created_by: null,
    created_at: '',
    updated_at: '',
    deleted_at: null,
    expense_participants: [],
    ...p,
  }
}

const shares = (...s: Array<[string, number]>) => s.map(([member_id, share_amount]) => ({ member_id, share_amount }))

describe('computeStats', () => {
  const hotel = e({
    id: 'hotel',
    paid_by: 'A',
    amount: 400000,
    currency: 'KRW',
    amount_hkd: 232000,
    category: 'Accommodation',
    end_date: '2026-10-15',
    expense_participants: shares(['A', 100000], ['B', 100000], ['C', 100000], ['D', 100000]),
  })
  const loan = e({
    id: 'loan',
    paid_by: 'B',
    amount: 50000,
    currency: 'KRW',
    amount_hkd: 29000,
    category: 'Loan',
    local_date: '2026-10-13',
    expense_participants: shares(['C', 50000]),
  })
  const souvenir = e({ id: 'souvenir', paid_by: 'D', amount: 20000, currency: 'KRW', amount_hkd: 11600, category: 'Shopping' })

  const s = computeStats([hotel, loan, souvenir], ['A', 'B', 'C', 'D'], trip)

  it('counts multi-day once and excludes loans and personal from trip total', () => {
    expect(s.totalSpendingHkd.toString()).toBe('232000')
    expect(s.byPage.get('2026-10-12')!.toString()).toBe('232000')
    expect(s.byPage.get('2026-10-13')).toBeUndefined()
    expect(s.byCategory.get('Loan')).toBeUndefined()
  })

  it('keeps loans in paid/share, personal only in personal spending', () => {
    expect(s.perMember.get('B')!.paidHkd.toString()).toBe('29000')
    expect(s.perMember.get('C')!.shareHkd.toString()).toBe('87000') // 58000 hotel + 29000 loan
    expect(s.perMember.get('C')!.spendingShareHkd.toString()).toBe('58000')
    expect(s.perMember.get('D')!.personalSpendingHkd.toString()).toBe('69600') // 58000 + 11600
    expect(s.perMember.get('D')!.paidHkd.toString()).toBe('0')
  })

  it('page totals follow the same rule', () => {
    expect(pageTotalHkd([hotel, loan, souvenir]).total.toString()).toBe('232000')
  })
})
