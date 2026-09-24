import type { TFunction } from 'i18next'
import type { IconName } from '../../app/ui/Icon'
import type { Category } from '../../lib/types'

export type CategoryKey = 'food' | 'transport' | 'accommodation' | 'activities' | 'shopping' | 'groceries' | 'loan' | 'other'

/** DB enum value -> line icon + translation key. Category names ARE translated. */
export const CATEGORY_META: Record<Category, { icon: IconName; key: CategoryKey }> = {
  'Food & Drink': { icon: 'food', key: 'food' },
  Transport: { icon: 'transport', key: 'transport' },
  Accommodation: { icon: 'bed', key: 'accommodation' },
  'Activities & Tickets': { icon: 'ticket', key: 'activities' },
  Shopping: { icon: 'bag', key: 'shopping' },
  Groceries: { icon: 'basket', key: 'groceries' },
  Loan: { icon: 'loan', key: 'loan' },
  Other: { icon: 'box', key: 'other' },
}

export function categoryLabel(t: TFunction, c: Category): string {
  const meta = CATEGORY_META[c]
  return meta ? t(`category.${meta.key}`) : c
}

export function categoryIcon(c: Category): IconName {
  return CATEGORY_META[c]?.icon ?? 'box'
}
