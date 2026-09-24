# Travel Bill Split — web (PWA)

Production frontend for the Travel Bill Split app. React + Vite + TypeScript,
installable PWA (vite-plugin-pwa), Supabase backend, EN + 繁體中文.
Source of truth: `docs/travel-bill-split-app-spec.txt` and `docs/frontend-agent-brief.txt`.

## Run locally

```bash
cd web
cp .env.example .env.local   # fill in VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Type-check (`tsc -b`) + production build to `dist/` (with service worker) |
| `npm test` | Unit tests (Vitest): money, settlement, dates, csv, stats, AB split |
| `npm run lint` | ESLint (incl. React Compiler hook rules) |
| `node scripts/generate-icons.mjs` | Regenerate the PWA PNG icons in `public/` |

Env vars (all public, shipped to the browser — never put the service_role key here):

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — required
- `VITE_VAPID_PUBLIC_KEY` — optional; Web Push subscribe is hidden when empty

## Deploy (Cloudflare Pages)

- Root directory: `web` · Build command: `npm run build` · Output: `dist` · Deploy command: empty
- SPA fallback for `/join/:token` works because there is **no** top-level `404.html`
  (Pages then serves `index.html` for unknown paths). Don't add one.

## Layout

```
src/
  app/            routes (App.tsx), trip shell (swipe + chip strip), install prompt, shared UI
  features/
    auth/         email OTP (code typed in-app, never magic links), Google, Apple, first-login profile
    trips/        My Trips, create trip + per-date locations, join, overview, weather, trip settings, CSV export
    expenses/     expense pages, rows ("what it means for me"), form (AA / AB split), photos (EXIF stripped via canvas)
    settlement/   conclusion stats, balances, who-pays-whom, mark as paid
    settings/     profile, notification toggles, push, shared LanguageSwitch (also used in the trip menu)
    members/  activity/  notifications/
  lib/
    money.ts      integer minor units via decimal.js — no float math on money
    settlement.ts nets per currency, greedy matching, All-in-HKD, HKD payment allocation (pure, tested)
    dates.ts      timezones + page assignment from stored local_date (pure, tested)
    fx.ts  csv.ts  currencies.ts  i18n.ts  supabase.ts  types.ts
  locales/        en.ts, zh-Hant.ts (same keys, enforced by TypeScript; t() keys are type-checked)
```

## Rules implemented (and choices where the brief left one open)

- **Page assignment** uses stored `local_date` (`< start` → Pre-trip, in range → that day, `> end` → Post-trip).
  Multi-day expenses are pinned on every covered date with "Multi-day 12–15 Oct (Day 2 of 4)".
- **Page total** = spending whose `local_date` is on that page (so a multi-day expense counts once, on its
  first day). Loans and personal expenses are excluded; the page shows a note saying so.
- **Trip spending / category / day / currency stats** exclude loans and personal expenses and use each
  expense's locked `amount_hkd`. **Per-person paid/share** include loans (they explain the balance).
  **Personal spending** = your shares of group spending + your personal expenses.
- **Two split methods** (`expenses.split_method`):
  - **AA — split equally** (`equal`, default): the server splits the amount between the To members.
    The form shows a preview (remainder to lowest `trip_members.id` first) that is discarded after save.
  - **AB — exact amounts** (`exact`): each person's share is what they actually had, payer included.
    E.g. D pays HK$ 120, D had 80, E had 40 → E owes D HK$ 40. The form only saves when the amounts add
    up exactly to the total ("+ Rest" gives the unassigned amount to one person).
  - Either way, **shares on screen** always come from `expense_participants.share_amount`.
- **All in HKD**: each member's per-currency net is converted at the latest rate, rounded with the
  largest-remainder method (so rounding never creates money), then greedy-matched. It never sums `amount_hkd`.
  Transfers under HK$ 0.10 caused only by FX rounding are hidden, with a visible note.
- **By currency**: greedy-matched per currency on exact integer nets.
- **Mark as paid** writes `settlements` rows with an `idempotency_key` generated when the dialog opens
  (double taps and retries reuse it; a unique-violation reply is treated as "already recorded").
  - By-currency line paid in HKD: `debt_currency` = original, `paid_currency` = HKD at today's rate → clears the debt.
  - All-in-HKD line: first clears matching currency debts between the two people (e.g. a KRW debt paid in HKD),
    the remainder is recorded as an HKD debt. All rows go in one insert.
- **Suggestions are never stored**; they are recomputed from nets after every change (realtime).
- **Language** (English / 繁體中文): detected from the device, switchable on the login page, at first
  login, in Settings and in the trip menu (⋯). It switches immediately and is saved to `profiles.language`.
  Titles/notes stay as typed; category names are translated.
- **Appearance** (System / Light / Dark) in Settings and the trip menu. System follows the phone live.
  Saved per device (`localStorage` key `tbs-theme`, not the profile). An inline script in `index.html`
  sets `<html data-theme>` before first paint; `src/app/theme.ts` keeps it in sync. Dark colours are the
  `:root[data-theme='dark']` tokens in `src/index.css`.
- Soft delete only (`deleted_at`), with Undo toast and Restore from the Activity log.
- Locked trip: all write controls hidden/disabled; admins can still unlock in Trip settings.

## Backend contract assumptions / gaps (please confirm)

The backend isn't in this repo yet, so the frontend codes against the brief and makes these
assumptions. Each one is isolated in a single file so it's easy to adjust.

1. **`join_trip` preview** (`features/trips/joinApi.ts`): to offer "Join as new member" vs "I am &lt;placeholder&gt;"
   *before* joining, the UI calls `join_trip({ token | code, preview: true })` and expects
   `{ trip: {id,name,start_date,end_date}, placeholders: [{id, display_name}], already_member, joining_enabled }`
   **without joining**. The real join is `join_trip({ token | code, claim_placeholder_id? })` → `{ trip_id }`.
   HTTP 404 = invalid code, 403 = joining disabled, 429 = rate limited.
2. **Saving an expense isn't atomic** (`features/expenses/expenseApi.ts`): the UI inserts/updates `expenses`,
   then writes `expense_participants`. A `save_expense` RPC would make this one transaction.
   - AA (`split_method = 'equal'`): rows are inserted as `expense_id, member_id` (no `share_amount`);
     a trigger computes shares, and must recompute when the amount or split method changes.
   - AB (`split_method = 'exact'`): rows are upserted with `share_amount` (`on_conflict = expense_id,member_id`).
     The backend must keep these values (not re-split) and should check they add up to `amount`.
     The Conclusion page also flags any expense whose shares don't add up.
   - AB is part of spec v1.1 (§5.8): the backend needs the `split_method` column (text, default `'equal'`).
3. `created_by` columns are not sent; expected `DEFAULT auth.uid()`.
4. **Trip creation** (`features/trips/tripApi.ts`): the client generates the trip id, inserts `trips` without
   RETURNING, then inserts the creator's `owner` membership only if a trigger hasn't already created it.
   RLS must allow that (or a trigger must do it).
5. **Invite secrets**: admins read `trips.invite_token, invite_code`; if they move to a separate table,
   change `fetchInvite`. Tokens are never logged.
6. **FX semantics**: an `fx_rates` row means `1 base = rate quote`; any base works (rates are chained
   through the table, e.g. base USD). `expenses.fx_rate_to_hkd` = HKD per 1 major unit.
   `settlements.fx_rate` = paid_currency per 1 major unit of debt_currency (1 when the same).
7. Money is sent as integer strings (e.g. `"15780"`), never floats. `local_date` is sent too (the trigger may overwrite it).
8. Unique constraints the UI relies on: `trip_days (trip_id, date)`, `expense_participants (expense_id, member_id)`,
   `notification_settings (user_id, type)`,
   `settlements.idempotency_key`, `push_subscriptions.endpoint` (duplicates are ignored).
9. **Notifications**: type strings `expense_added`, `expense_changed` (+ `expense_updated`/`expense_deleted`
   accepted), `settlement_received`, `member_joined`, `placeholder_claimed`, `trip_locked`; payload fields
   `actor_name`, `title`, `trip_name`, `amount_display` (all optional). See `features/notifications/notificationTypes.ts`.
10. **Activity log**: `entity_type` in `expense|settlement|trip_member|trip|trip_day` (plural accepted),
    `action` `create|update|delete|…`, `before`/`after` are row snapshots. Soft delete = update with `deleted_at` set.
11. **Auth**: the Supabase email OTP template must contain `{{ .Token }}` (6-digit code) — not a magic link.
    Add the site URL (with `/**`) to Auth redirect URLs for Google/Apple.
12. **Storage**: private bucket `expense-photos`, object path `<trip_id>/<uuid>.jpg`; policies by trip membership on
    the first path segment. The UI only uses signed URLs.
13. **Web Push**: needs `VITE_VAPID_PUBLIC_KEY` (brief §1). `send_push` should send JSON
    `{ title, body, url }`; `public/push-sw.js` shows it and opens `url` when tapped.
14. **Realtime**: the publication should include `expenses, expense_participants, settlements, trip_members,
    trips, trip_days, notifications`. `expense_participants` has no `trip_id`, so it is subscribed unfiltered
    (RLS-limited) and matched against loaded expense ids.
