import { describe, expect, it } from 'vitest'
import { buildRateTable, rateToHkd } from './fx'
import { Dec, sumMinor, type Decimal } from './money'
import {
  allocateHkdPayment,
  computeNets,
  greedyMatch,
  hkdNets,
  netOf,
  shareIntegrityIssues,
  suggestAllInHkd,
  suggestByCurrency,
  type NetExpense,
  type NetSettlement,
  type Nets,
} from './settlement'

const d = (v: number | string) => new Dec(v)

function exp(
  paid_by: string,
  amount: number,
  currency: string,
  shares: Array<[string, number]>,
  extra: Partial<NetExpense> = {},
): NetExpense {
  return {
    paid_by,
    amount,
    currency,
    expense_participants: shares.map(([member_id, share_amount]) => ({ member_id, share_amount })),
    ...extra,
  }
}

function settle(from: string, to: string, cur: string, amount: number | string): NetSettlement {
  return { from_member: from, to_member: to, debt_currency: cur, debt_amount: amount }
}

function netsAsObject(nets: Nets) {
  const out: Record<string, Record<string, string>> = {}
  for (const [cur, m] of nets) {
    out[cur] = {}
    for (const [id, v] of m) if (!v.isZero()) out[cur][id] = v.toString()
  }
  return out
}

describe('computeNets', () => {
  it('spec example 1: shared meal', () => {
    const nets = computeNets([exp('A', 3000, 'HKD', [['A', 1000], ['B', 1000], ['C', 1000]])], [])
    expect(netsAsObject(nets)).toEqual({ HKD: { A: '2000', B: '-1000', C: '-1000' } })
    const t = suggestByCurrency(nets)
    expect(t.map((x) => [x.from, x.to, x.amount.toString()])).toEqual([
      ['B', 'A', '1000'],
      ['C', 'A', '1000'],
    ])
  })

  it('spec example 2: loan counts in balances', () => {
    const nets = computeNets([exp('D', 1000, 'KRW', [['E', 1000]])], [])
    expect(netsAsObject(nets)).toEqual({ KRW: { D: '1000', E: '-1000' } })
  })

  it('spec example 3: personal expense has no balance effect', () => {
    const nets = computeNets([exp('A', 2000, 'JPY', [])], [])
    expect(netsAsObject(nets)).toEqual({})
  })

  it('settlements move nets in the debt currency', () => {
    const nets = computeNets([exp('D', 1000, 'KRW', [['E', 1000]])], [settle('E', 'D', 'KRW', 1000)])
    expect(netsAsObject(nets)).toEqual({ KRW: {} })
    expect(suggestByCurrency(nets)).toEqual([])
  })

  it('flags server shares that do not sum to the amount', () => {
    expect(shareIntegrityIssues([exp('A', 100, 'HKD', [['A', 33], ['B', 33]], { id: 'x' })])).toEqual(['x'])
    expect(shareIntegrityIssues([exp('A', 100, 'HKD', [['A', 34], ['B', 33], ['C', 33]])])).toEqual([])
  })
})

describe('greedyMatch', () => {
  it('uses at most members-1 payments and zeroes everyone', () => {
    const bal = new Map<string, Decimal>([
      ['a', d(500)],
      ['b', d(300)],
      ['c', d(-100)],
      ['d', d(-250)],
      ['e', d(-450)],
    ])
    const t = greedyMatch(bal, 'HKD')
    expect(t.length).toBeLessThanOrEqual(4)
    const after = new Map(bal)
    for (const x of t) {
      after.set(x.from, after.get(x.from)!.plus(x.amount))
      after.set(x.to, after.get(x.to)!.minus(x.amount))
    }
    expect([...after.values()].every((v) => v.isZero())).toBe(true)
    // largest debtor pays largest creditor first
    expect([t[0].from, t[0].to, t[0].amount.toString()]).toEqual(['e', 'a', '450'])
  })
})

describe('All in HKD', () => {
  const rates = buildRateTable([
    { rate_date: '2026-10-16', base_currency: 'KRW', quote_currency: 'HKD', rate: '0.0058' },
    { rate_date: '2026-10-16', base_currency: 'JPY', quote_currency: 'HKD', rate: '0.0526' },
    // older row must be ignored
    { rate_date: '2026-10-01', base_currency: 'KRW', quote_currency: 'HKD', rate: '0.0100' },
  ])
  const rateFor = (c: string) => rateToHkd(rates, c)

  it('converts currency nets at the latest rate, not summed amount_hkd', () => {
    // Locked amount_hkd was computed at 0.0100 (HK$ 10.00) but HKD view uses 0.0058.
    const nets = computeNets(
      [exp('D', 1000, 'KRW', [['E', 1000]], { amount_hkd: 1000 } as Partial<NetExpense>)],
      [],
    )
    const r = suggestAllInHkd(nets, rateFor)
    expect(r.transfers.map((x) => [x.from, x.to, x.amount.toString()])).toEqual([['E', 'D', '580']])
  })

  it('rounds with largest remainder so balances sum to zero', () => {
    const nets = computeNets([exp('A', 3, 'JPY', [['A', 1], ['B', 1], ['C', 1]])], [])
    const { balances } = hkdNets(nets, rateFor)
    expect(sumMinor(balances.values()).isZero()).toBe(true)
  })

  it('reports currencies without a rate instead of faking them', () => {
    const nets = computeNets([exp('A', 100, 'XYZ', [['B', 100]])], [])
    expect(hkdNets(nets, rateFor).missingRates).toEqual(['XYZ'])
  })

  it('HKD repayment of a KRW debt clears the KRW debt at payment-day rate', () => {
    const nets = computeNets([exp('D', 1000, 'KRW', [['E', 1000]])], [])
    const pieces = allocateHkdPayment(nets, 'E', 'D', d(580), rateFor)
    expect(pieces.map((p) => [p.debt_currency, p.debt_amount.toString(), p.paid_hkd.toString()])).toEqual([
      ['KRW', '1000', '580'],
    ])
    const after = computeNets(
      [exp('D', 1000, 'KRW', [['E', 1000]])],
      pieces.map((p) => settle('E', 'D', p.debt_currency, p.debt_amount.toString())),
    )
    expect(netOf(after, 'E', 'KRW').isZero()).toBe(true)
  })

  it('records the non-matching remainder in HKD and pays exactly the suggested amount', () => {
    // E owes D in KRW and also owes D in JPY; D is only owed JPY by E partially.
    const nets = computeNets(
      [exp('D', 1000, 'KRW', [['E', 1000]]), exp('F', 1000, 'JPY', [['E', 1000]])],
      [],
    )
    // Suppose the user pays D more than the direct KRW match.
    const pieces = allocateHkdPayment(nets, 'E', 'D', d(1000), rateFor)
    expect(sumMinor(pieces.map((p) => p.paid_hkd)).toString()).toBe('1000')
    expect(pieces.find((p) => p.debt_currency === 'KRW')!.debt_amount.toString()).toBe('1000')
    expect(pieces.find((p) => p.debt_currency === 'HKD')!.debt_amount.toString()).toBe('420')
  })
})

describe('acceptance scenario (4 people, KRW + HKD, 4 days)', () => {
  // A, B, C, D. Hotel multi-day 400,000 KRW paid by A for all four (counted once).
  // Loan: B lends C 50,000 KRW. Personal souvenir: D 20,000 KRW (no effect).
  // Dinner HKD 1,000.00 paid by C for all. HKD repayment: C pays A for a KRW debt.
  const expenses: NetExpense[] = [
    exp('A', 400000, 'KRW', [['A', 100000], ['B', 100000], ['C', 100000], ['D', 100000]], { id: 'hotel' }),
    exp('B', 50000, 'KRW', [['C', 50000]], { id: 'loan' }),
    exp('D', 20000, 'KRW', [], { id: 'souvenir' }),
    exp('C', 100000, 'HKD', [['A', 25000], ['B', 25000], ['C', 25000], ['D', 25000]], { id: 'dinner' }),
  ]
  const rates = buildRateTable([{ rate_date: '2026-10-16', base_currency: 'HKD', quote_currency: 'KRW', rate: '172.5' }])
  const rateFor = (c: string) => rateToHkd(rates, c)

  it('nets are exact per currency; personal excluded; loan included', () => {
    const nets = computeNets(expenses, [])
    expect(netsAsObject(nets)).toEqual({
      KRW: { A: '300000', B: '-50000', C: '-150000', D: '-100000' },
      HKD: { A: '-25000', B: '-25000', C: '75000', D: '-25000' },
    })
  })

  it('by-currency suggestions settle every currency to zero', () => {
    const nets = computeNets(expenses, [])
    const t = suggestByCurrency(nets)
    const after = computeNets(
      expenses,
      t.map((x) => settle(x.from, x.to, x.currency, x.amount.toString())),
    )
    for (const m of after.values()) for (const v of m.values()) expect(v.isZero()).toBe(true)
    expect(t.filter((x) => x.currency === 'KRW').length).toBeLessThanOrEqual(3)
  })

  it('all-in-HKD suggestions settle to (dust-free) zero after marking each paid', () => {
    const nets = computeNets(expenses, [])
    const first = suggestAllInHkd(nets, rateFor)
    expect(first.transfers.length).toBeLessThanOrEqual(3)
    const recorded: NetSettlement[] = []
    for (const t of first.transfers) {
      const current = computeNets(expenses, recorded)
      for (const p of allocateHkdPayment(current, t.from, t.to, t.amount, rateFor)) {
        recorded.push(settle(t.from, t.to, p.debt_currency, p.debt_amount.toString()))
      }
    }
    const second = suggestAllInHkd(computeNets(expenses, recorded), rateFor)
    expect(second.transfers).toEqual([])
  })

  it('an HKD repayment of a KRW debt is recorded against KRW', () => {
    const nets = computeNets(expenses, [])
    // C owes A 150,000 KRW in the by-currency view; C pays in HKD.
    const debt = d(150000)
    const pieces = allocateHkdPayment(nets, 'C', 'A', debt.div(d('172.5')).times(100).toDecimalPlaces(0), rateFor)
    expect(pieces[0].debt_currency).toBe('KRW')
  })
})
