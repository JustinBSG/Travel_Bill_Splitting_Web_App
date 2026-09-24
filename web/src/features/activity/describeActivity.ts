// Human-readable activity log lines from before/after JSON snapshots.
// Example: "Alex edited 'Dinner': 800 → 900 JPY"
import type { TFunction } from 'i18next'
import { formatDateRange, formatDayMonth } from '../../lib/dates'
import { formatMoney } from '../../lib/money'
import type { ActivityLogRow } from '../../lib/types'

type Snap = Record<string, unknown>

export interface ActivityLine {
  text: string
  /** Expense id that can be restored from this row (soft-deleted). */
  restorableExpenseId: string | null
}

interface Ctx {
  t: TFunction
  locale: string
  memberName: (id: string | null | undefined) => string
}

const s = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))

function money(v: unknown, currency: unknown, locale: string): string {
  try {
    return formatMoney(v as string | number, s(currency) || 'HKD', locale)
  } catch {
    return `${s(v)} ${s(currency)}`
  }
}

function changed(before: Snap, after: Snap, key: string) {
  return JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)
}

function expenseLine(row: ActivityLogRow, ctx: Ctx, actor: string): ActivityLine {
  const { t, locale } = ctx
  const b = row.before ?? {}
  const a = row.after ?? {}
  const title = s(a.title) || s(b.title)
  const action = row.action.toLowerCase()
  const deletedNow = (action === 'update' && !b.deleted_at && !!a.deleted_at) || action === 'delete' || action === 'soft_delete'
  if (action === 'create' || action === 'insert') {
    return { text: t('activity.expenseAdded', { actor, title, amount: money(a.amount, a.currency, locale) }), restorableExpenseId: null }
  }
  if (deletedNow) {
    return { text: t('activity.expenseDeleted', { actor, title }), restorableExpenseId: row.entity_id }
  }
  if ((action === 'update' || action === 'restore') && b.deleted_at && !a.deleted_at) {
    return { text: t('activity.expenseRestored', { actor, title }), restorableExpenseId: null }
  }
  const parts: string[] = []
  if (changed(b, a, 'amount') || changed(b, a, 'currency')) {
    parts.push(
      s(b.currency) === s(a.currency)
        ? `${money(b.amount, b.currency, locale).replace(` ${s(a.currency)}`, '')} → ${money(a.amount, a.currency, locale)}`
        : `${money(b.amount, b.currency, locale)} → ${money(a.amount, a.currency, locale)}`,
    )
  }
  if (changed(b, a, 'title')) parts.push(`'${s(b.title)}' → '${s(a.title)}'`)
  if (changed(b, a, 'local_date') && s(b.local_date) && s(a.local_date)) {
    parts.push(`${formatDayMonth(s(b.local_date), locale)} → ${formatDayMonth(s(a.local_date), locale)}`)
  }
  if (changed(b, a, 'paid_by')) {
    parts.push(t('activity.paidByChange', { from: ctx.memberName(s(b.paid_by)), to: ctx.memberName(s(a.paid_by)) }))
  }
  if (changed(b, a, 'category')) parts.push(`${s(b.category)} → ${s(a.category)}`)
  if (changed(b, a, 'end_date')) parts.push(t('activity.multiDayChanged'))
  if (changed(b, a, 'split_method')) {
    parts.push(a.split_method === 'exact' ? t('activity.splitToExact') : t('activity.splitToEqual'))
  }
  return {
    text: parts.length
      ? t('activity.expenseEdited', { actor, title, changes: parts.join(', ') })
      : t('activity.expenseEditedDetails', { actor, title }),
    restorableExpenseId: null,
  }
}

export function describeActivity(row: ActivityLogRow, ctx: Ctx): ActivityLine {
  const { t, locale } = ctx
  const actor = row.actor_member ? ctx.memberName(row.actor_member) : t('activity.system')
  const b = row.before ?? {}
  const a = row.after ?? {}
  const action = row.action.toLowerCase()
  const plain = (text: string): ActivityLine => ({ text, restorableExpenseId: null })

  switch (row.entity_type) {
    case 'expense':
    case 'expenses':
      return expenseLine(row, ctx, actor)

    case 'settlement':
    case 'settlements':
      return plain(
        t('activity.repayment', {
          actor,
          from: ctx.memberName(s(a.from_member ?? b.from_member)),
          to: ctx.memberName(s(a.to_member ?? b.to_member)),
          amount: money(a.debt_amount ?? b.debt_amount, a.debt_currency ?? b.debt_currency, locale),
        }) +
          (s(a.paid_currency) && s(a.paid_currency) !== s(a.debt_currency)
            ? ` (${t('conclusion.paidAs', { amount: money(a.paid_amount, a.paid_currency, locale) })})`
            : ''),
      )

    case 'member':
    case 'trip_member':
    case 'trip_members': {
      const who = s(a.display_name) || s(b.display_name)
      if (action === 'create' || action === 'insert') {
        return plain(a.user_id ? t('activity.memberJoined', { name: who }) : t('activity.placeholderAdded', { actor, name: who }))
      }
      if (action === 'claim' || (!b.user_id && a.user_id)) return plain(t('activity.placeholderClaimed', { name: who }))
      if (!b.removed_at && a.removed_at) return plain(t('activity.memberRemoved', { actor, name: who }))
      if (changed(b, a, 'role')) return plain(t('activity.roleChanged', { actor, name: who, role: t(`members.roles.${s(a.role) || 'member'}` as 'members.roles.member') }))
      return plain(t('activity.memberUpdated', { actor, name: who }))
    }

    case 'trip':
    case 'trips': {
      if (changed(b, a, 'is_locked')) return plain(a.is_locked ? t('activity.locked', { actor }) : t('activity.unlocked', { actor }))
      if (changed(b, a, 'start_date') || changed(b, a, 'end_date')) {
        return plain(
          t('activity.datesChanged', {
            actor,
            from: s(b.start_date) ? formatDateRange(s(b.start_date), s(b.end_date), locale) : '?',
            to: formatDateRange(s(a.start_date), s(a.end_date), locale),
          }),
        )
      }
      if (changed(b, a, 'name')) return plain(t('activity.renamed', { actor, from: s(b.name), to: s(a.name) }))
      if (changed(b, a, 'joining_enabled')) {
        return plain(a.joining_enabled ? t('activity.joiningOn', { actor }) : t('activity.joiningOff', { actor }))
      }
      if (changed(b, a, 'invite_code') || changed(b, a, 'invite_token') || action === 'regenerate_invite') {
        return plain(t('activity.inviteRegenerated', { actor }))
      }
      if (action === 'create' || action === 'insert') return plain(t('activity.tripCreated', { actor }))
      return plain(t('activity.tripUpdated', { actor }))
    }

    case 'trip_day':
    case 'trip_days':
      return plain(t('activity.locationsChanged', { actor, date: s(a.date || b.date) }))

    default:
      return plain(t('activity.generic', { actor, action: row.action, entity: row.entity_type }))
  }
}
