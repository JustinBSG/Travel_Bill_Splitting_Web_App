import type { TFunction } from 'i18next'
import type { Category } from '../../lib/types'

export type CategoryKey = 'food' | 'transport' | 'accommodation' | 'activities' | 'shopping' | 'groceries' | 'loan' | 'other'

/** DB enum value -> icon + translation key. Category names ARE translated. */
export const CATEGORY_META: Record<Category, { icon: string; key: CategoryKey }> = {
  'Food & Drink': { icon: '🍜', key: 'food' },
  Transport: { icon: '🚆', key: 'transport' },
  Accommodation: { icon: '🏨', key: 'accommodation' },
  'Activities & Tickets': { icon: '🎟️', key: 'activities' },
  Shopping: { icon: '🛍️', key: 'shopping' },
  Groceries: { icon: '🛒', key: 'groceries' },
  Loan: { icon: '🤝', key: 'loan' },
  Other: { icon: '📦', key: 'other' },
}

export function categoryLabel(t: TFunction, c: Category): string {
  const meta = CATEGORY_META[c]
  return meta ? t(`category.${meta.key}`) : c
}

export function categoryIcon(c: Category): string {
  return CATEGORY_META[c]?.icon ?? '📦'
}
