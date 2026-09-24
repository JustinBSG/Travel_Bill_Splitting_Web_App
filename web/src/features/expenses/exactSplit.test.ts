import { describe, expect, it } from 'vitest'
import { Dec } from '../../lib/money'
import { computeNets, suggestByCurrency } from '../../lib/settlement'
import { evaluateExactSplit, isExactSplitComplete } from './exactSplit'

const d = (v: number | string) => new Dec(v)

describe('AB split (exact amounts)', () => {
  it('D pays HK$120, D had 80, E had 40 -> E pays D HK$40', () => {
    const split = evaluateExactSplit(d(12000), { D: '80', E: '40' }, ['D', 'E', 'F'], 'HKD')
    expect(isExactSplitComplete(split)).toBe(true)
    expect([...split.shares].map(([id, v]) => [id, v.toString()])).toEqual([
      ['D', '8000'],
      ['E', '4000'],
    ])

    const nets = computeNets(
      [
        {
          paid_by: 'D',
          amount: 12000,
          currency: 'HKD',
          expense_participants: [...split.shares].map(([member_id, s]) => ({ member_id, share_amount: s.toString() })),
        },
      ],
      [],
    )
    const t = suggestByCurrency(nets)
    expect(t.map((x) => [x.from, x.to, x.amount.toString()])).toEqual([['E', 'D', '4000']])
  })

  it('reports what is left or over', () => {
    expect(evaluateExactSplit(d(12000), { D: '80' }, ['D', 'E'], 'HKD').remaining!.toString()).toBe('4000')
    const over = evaluateExactSplit(d(12000), { D: '80', E: '50' }, ['D', 'E'], 'HKD')
    expect(over.remaining!.toString()).toBe('-1000')
    expect(isExactSplitComplete(over)).toBe(false)
  })

  it('blank means not in the split; zero and bad decimals are invalid', () => {
    const s = evaluateExactSplit(d(3000), { A: '3000', B: '', C: '0', E: '10.5' }, ['A', 'B', 'C', 'E'], 'JPY')
    expect([...s.shares.keys()]).toEqual(['A'])
    expect(s.invalid).toEqual(['C', 'E'])
    expect(isExactSplitComplete(s)).toBe(false)
  })

  it('needs a valid total', () => {
    const s = evaluateExactSplit(null, { A: '10' }, ['A'], 'HKD')
    expect(s.remaining).toBeNull()
    expect(isExactSplitComplete(s)).toBe(false)
  })
})
