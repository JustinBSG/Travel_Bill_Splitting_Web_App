import { describe, expect, it } from 'vitest'
import { csvEscape, safeFileName, toCsv } from './csv'

describe('csv', () => {
  it('starts with a BOM and uses CRLF', () => {
    const out = toCsv([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(out.charCodeAt(0)).toBe(0xfeff)
    expect(out.slice(1)).toBe('a,b\r\n1,2\r\n')
  })

  it('quotes commas, quotes and newlines; keeps Chinese', () => {
    expect(csvEscape('拉麵, 晚餐')).toBe('"拉麵, 晚餐"')
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""')
    expect(csvEscape('a\nb')).toBe('"a\nb"')
    expect(csvEscape(null)).toBe('')
  })

  it('neutralises formula injection but keeps negative numbers', () => {
    expect(csvEscape('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvEscape('-12.50')).toBe('-12.50')
  })

  it('makes safe file names', () => {
    expect(safeFileName('Tokyo/Osaka 2026')).toBe('Tokyo_Osaka 2026')
    expect(safeFileName('日本之旅')).toBe('日本之旅')
  })
})
