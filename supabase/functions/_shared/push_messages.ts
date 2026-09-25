// Push text for each notification type, in the recipient's profile language.
// Payload fields come from the database notification writers (trip_name,
// actor_name, title, amount_display, member_name, placeholder_name, ...).
// The service worker (web/public/push-sw.js) expects { title, body, url }.

export interface NotificationRecord {
  id?: string
  user_id: string
  trip_id: string | null
  type: string
  payload: Record<string, unknown> | null
}

export interface PushMessage {
  title: string
  body: string
  url: string
}

type Lang = 'en' | 'zh-Hant'
type Vars = { actor: string; title: string; amount: string; member: string; placeholder: string }

const TEXT: Record<Lang, { app: string; someone: string; types: Record<string, (v: Vars) => string> }> = {
  en: {
    app: 'Travel Bill Split',
    someone: 'Someone',
    types: {
      expense_added: (v) => `${v.actor} added “${v.title}”${v.amount ? ` · ${v.amount}` : ''}`,
      expense_updated: (v) => `${v.actor} edited “${v.title}”`,
      expense_deleted: (v) => `${v.actor} deleted “${v.title}”`,
      settlement_received: (v) => `${v.actor} recorded a repayment to you${v.amount ? ` · ${v.amount}` : ''}`,
      member_joined: (v) => `${v.member} joined the trip`,
      placeholder_claimed: (v) => `${v.member} joined as “${v.placeholder}”`,
      trip_locked: (v) => `${v.actor} locked the trip. The conclusion is final.`,
    },
  },
  'zh-Hant': {
    app: '旅行分帳',
    someone: '有人',
    types: {
      expense_added: (v) => `${v.actor} 新增了「${v.title}」${v.amount ? ` · ${v.amount}` : ''}`,
      expense_updated: (v) => `${v.actor} 修改了「${v.title}」`,
      expense_deleted: (v) => `${v.actor} 刪除了「${v.title}」`,
      settlement_received: (v) => `${v.actor} 已記錄向你還款${v.amount ? ` · ${v.amount}` : ''}`,
      member_joined: (v) => `${v.member} 加入了行程`,
      placeholder_claimed: (v) => `${v.member} 以「${v.placeholder}」身分加入`,
      trip_locked: (v) => `${v.actor} 已鎖定行程，結算已定案。`,
    },
  },
}

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

export function buildPushMessage(n: NotificationRecord, language: string | null | undefined): PushMessage {
  const lang: Lang = language === 'zh-Hant' ? 'zh-Hant' : 'en'
  const t = TEXT[lang]
  const p = n.payload ?? {}
  const actor = str(p.actor_name) || t.someone
  const vars: Vars = {
    actor,
    title: str(p.title),
    amount: str(p.amount_display),
    member: str(p.member_name) || actor,
    placeholder: str(p.placeholder_name),
  }
  const body = t.types[n.type]?.(vars) ?? ''

  const trip = n.trip_id ?? str(p.trip_id)
  const localDate = str(p.local_date)
  let url = '/notifications'
  if (trip) {
    // The day's page, not the edit form; the app maps dates outside the trip to pre/post.
    if ((n.type === 'expense_added' || n.type === 'expense_updated') && /^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
      url = `/trips/${trip}/${localDate}`
    } else if (n.type === 'expense_deleted') {
      url = `/trips/${trip}/activity`
    } else {
      url = `/trips/${trip}`
    }
  }
  return { title: str(p.trip_name) || t.app, body, url }
}
