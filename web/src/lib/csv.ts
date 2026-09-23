// CSV generation. UTF-8 with BOM so Excel shows Chinese text correctly.

export type Cell = string | null | undefined

const BOM = '﻿'

export function csvEscape(v: Cell): string {
  const s = v ?? ''
  // Neutralise spreadsheet formula injection from user-typed titles/notes.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv(rows: Cell[][]): string {
  return BOM + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n'
}

/** File-name-safe version of a trip name (keeps CJK characters). */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\p{Cc}+/gu, '_').trim()
  return cleaned.slice(0, 60) || 'trip'
}

export function csvBlob(content: string): Blob {
  return new Blob([content], { type: 'text/csv;charset=utf-8' })
}
