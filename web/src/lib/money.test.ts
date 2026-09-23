import { afterEach, describe, expect, it } from 'vitest'
import { registerCurrencies } from './currencies'
import {
  Dec,
  allocateProportional,
  compareIds,
  formatMoney,
  formatSigned,
  fromHkdCents,
  minorToMajorString,
  parseMajorInput,
  splitEqualPreview,
  sumMinor,
  toHkdCents,
  toMinor,
} from './money'

const L = 'en-HK'
const d = (v: number | string) => new Dec(v)

afterEach(() => registerCurrencies([]))

describe('parseMajorInput', () => {
  it('converts to integer minor units by currency decimals', () => {
    expect(parseMajorInput('157.80', 'HKD')).toEqual({ ok: true, minor: d(15780) })
    expect(parseMajorInput('10', 'HKD')).toEqual({ ok: true, minor: d(1000) })
    expect(parseMajorInput('10.', 'HKD')).toEqual({ ok: true, minor: d(1000) })
    expect(parseMajorInput('.5', 'HKD')).toEqual({ ok: true, minor: d(50) })
    expect(parseMajorInput('3000', 'JPY')).toEqual({ ok: true, minor: d(3000) })
    expect(parseMajorInput('1,000', 'KRW')).toEqual({ ok: true, minor: d(1000) })
    expect(parseMajorInput('1,234.5', 'HKD')).toEqual({ ok: true, minor: d(123450) })
  })

  it('rejects extra decimals instead of rounding', () => {
    expect(parseMajorInput('3000.5', 'JPY')).toEqual({ ok: false, error: 'decimals' })
    expect(parseMajorInput('1.234', 'HKD')).toEqual({ ok: false, error: 'decimals' })
    // trailing zeros are fine
    expect(parseMajorInput('3000.00', 'JPY')).toEqual({ ok: true, minor: d(3000) })
  })

  it('rejects empty, junk and zero', () => {
    expect(parseMajorInput('', 'HKD')).toEqual({ ok: false, error: 'empty' })
    expect(parseMajorInput('abc', 'HKD')).toEqual({ ok: false, error: 'invalid' })
    expect(parseMajorInput('-5', 'HKD')).toEqual({ ok: false, error: 'invalid' })
    expect(parseMajorInput('1e3', 'HKD')).toEqual({ ok: false, error: 'invalid' })
    expect(parseMajorInput('0.00', 'HKD')).toEqual({ ok: false, error: 'zero' })
  })

  it('never loses precision on large values', () => {
    expect(parseMajorInput('90071992547409.93', 'HKD')).toEqual({ ok: true, minor: d('9007199254740993') })
  })

  it('uses server currency decimals when registered', () => {
    registerCurrencies([{ code: 'TWD', decimals: 0, symbol: 'NT$' }])
    expect(parseMajorInput('100.5', 'TWD')).toEqual({ ok: false, error: 'decimals' })
  })
})

describe('formatting', () => {
  it('formats like the spec examples', () => {
    expect(formatMoney(3000, 'JPY', L)).toBe('3,000 JPY')
    expect(formatMoney(15780, 'HKD', L)).toBe('HK$ 157.80')
    expect(formatMoney(-500, 'HKD', L)).toBe('-HK$ 5.00')
    expect(formatMoney(1000, 'KRW', L)).toBe('1,000 KRW')
    expect(formatMoney(1234, 'KWD', L)).toBe('1.234 KWD')
    expect(formatSigned(d(1000), 'HKD', L)).toBe('+HK$ 10.00')
    expect(formatSigned(d(-1000), 'HKD', L)).toBe('-HK$ 10.00')
    expect(formatSigned(d(0), 'HKD', L)).toBe('HK$ 0.00')
  })

  it('round-trips input strings', () => {
    expect(minorToMajorString(d(15780), 'HKD')).toBe('157.80')
    expect(minorToMajorString(d(3000), 'JPY')).toBe('3000')
  })

  it('rejects non-integer minor values', () => {
    expect(() => toMinor('1.5')).toThrow()
    expect(toMinor(null).isZero()).toBe(true)
  })
})

describe('FX conversion', () => {
  it('converts minor units to HKD cents with half-up rounding', () => {
    expect(toHkdCents(d(3000), 'JPY', d('0.0526')).toString()).toBe('15780')
    expect(toHkdCents(d(1000), 'KRW', d('0.0058')).toString()).toBe('580')
    expect(toHkdCents(d(1), 'JPY', d('0.0525')).toString()).toBe('5') // 5.25 -> 5
    expect(toHkdCents(d(1), 'JPY', d('0.0555')).toString()).toBe('6') // 5.55 -> 6
    expect(toHkdCents(d(1234), 'HKD', d(1)).toString()).toBe('1234')
  })

  it('converts HKD cents back to the currency', () => {
    expect(fromHkdCents(d(580), 'KRW', d('0.0058')).toString()).toBe('1000')
    expect(fromHkdCents(d(15780), 'JPY', d('0.0526')).toString()).toBe('3000')
  })

  it('never uses float math (0.1 + 0.2 case)', () => {
    expect(toHkdCents(d(10), 'USD', d('7.8')).plus(toHkdCents(d(20), 'USD', d('7.8'))).toString()).toBe('234')
  })
})

describe('splitEqualPreview (remainder rule)', () => {
  it('gives the remainder to the first members by id ascending, not list order', () => {
    const s = splitEqualPreview(d(10000), ['c', 'a', 'b'])
    expect(s.get('a')!.toString()).toBe('3334')
    expect(s.get('b')!.toString()).toBe('3333')
    expect(s.get('c')!.toString()).toBe('3333')
    expect(sumMinor(s.values()).toString()).toBe('10000')
  })

  it('handles r > 1 and zero-decimal currencies', () => {
    const s = splitEqualPreview(d(1001), ['d', 'b', 'a', 'c'])
    expect([...['a', 'b', 'c', 'd']].map((k) => s.get(k)!.toString())).toEqual(['251', '250', '250', '250'])
    const t = splitEqualPreview(d(1002), ['d', 'b', 'a', 'c'])
    expect([...['a', 'b', 'c', 'd']].map((k) => t.get(k)!.toString())).toEqual(['251', '251', '250', '250'])
  })

  it('returns empty for personal', () => {
    expect(splitEqualPreview(d(100), []).size).toBe(0)
  })

  it('orders numeric ids numerically', () => {
    expect(compareIds('9', '10')).toBeLessThan(0)
    expect(compareIds('b', 'a')).toBeGreaterThan(0)
  })
})

describe('allocateProportional', () => {
  it('sums exactly to the total', () => {
    const w = new Map([
      ['a', d(1)],
      ['b', d(1)],
      ['c', d(1)],
    ])
    const out = allocateProportional(d(100), w)
    expect(['a', 'b', 'c'].map((k) => out.get(k)!.toString())).toEqual(['34', '33', '33'])
  })

  it('follows share weights', () => {
    const w = new Map([
      ['a', d(3334)],
      ['b', d(3333)],
      ['c', d(3333)],
    ])
    const out = allocateProportional(d(15780), w)
    expect(sumMinor(out.values()).toString()).toBe('15780')
  })
})
