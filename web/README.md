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

## Deploy (Cloudflare Workers)

Full instructions: **[DEPLOY.md](DEPLOY.md)**. That covers Worker setup from GitHub, build
variables, auto-deploy on push to `main`, releases and rollback.

- Root directory: `web` · Build command: `npm run build:cloudflare` · Deploy command: `npx wrangler deploy`
- `wrangler.jsonc` serves `./dist` with SPA fallback, so `/join/:token` and `/trips/...` load `index.html`
- `build:cloudflare` uses `PROD_VITE_*` on `main` and `STAGING_VITE_*` on other branches
- Pushes to `main` deploy production automatically; other branches get preview URLs (staging backend)

## Layout

```
src/
  app/            routes (App.tsx), trip shell (swipe + calendar tab strip), theme, install prompt, shared UI
  features/
    auth/         email OTP (code typed in-app, never magic links), Google, first-login profile
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
- **Colour theme** (Washi / Classic) next to Appearance, in Settings and the trip menu. Washi is the
  default "Washi & Sumi" design (paper grain, ink buttons, vermilion accent, Shippori Mincho + Zen Kaku
  Gothic New, Noto Serif/Sans TC for 繁體中文, loaded from Google Fonts and cached by the service worker).
  Classic is the original teal look with system fonts. Saved per device (`localStorage` key `tbs-palette`)
  and set as `<html data-palette>` by the same inline script. Each theme × appearance is one token block
  in `src/index.css`; components never use raw colours. Design reference: `docs/design/washi-sumi/`.
- **Settle up** (the Conclusion page) lists who pays whom first (your own payment highlighted), then
  balances, then stats.
- Soft delete only (`deleted_at`), with Undo toast and Restore from the Activity log.
- Locked trip: all write controls hidden/disabled; admins can still unlock in Trip settings.

## Backend contract

The backend lives in [`../supabase`](../supabase/README.md) (Supabase: migrations, RLS, RPCs, Edge Functions).
All calls are isolated in the `*Api.ts` files:

- **Trips** (`features/trips/tripApi.ts`): `rpc/create_trip` (trip + days + owner + invite in one transaction),
  `rpc/update_trip`, `rpc/lock_trip` / `unlock_trip`, `rpc/delete_trip` (owner, unlocked), and
  `rpc/get_trip_invite` for admins (invite secrets are not on `trips`). `joining_enabled` is a plain PATCH.
- **Members**: placeholders are a plain insert; `rpc/set_member_role` and `rpc/remove_member` for admins.
- **Join** (`features/trips/joinApi.ts`): Edge Function `join_trip` with `preview: true` (trip + open placeholders,
  joins nothing), then `{ token | code, claim_placeholder_id? }`. Errors: `{ error: { code, message } }`.
- **Expenses** (`features/expenses/expenseApi.ts`): `rpc/save_expense` writes the expense and its participants in
  one transaction. The server derives `local_date` (an `all_day` expense is stored at the start of that day), locks FX, computes `amount_hkd`, splits AA shares and checks AB
  sums. `expected_updated_at` is the `updated_at` string exactly as received (optimistic lock → `conflict_updated_at`).
  Soft delete / restore: `rpc/soft_delete_expense`, `rpc/restore_expense`.
- **Settlements**: plain insert with `idempotency_key` (a replay is a 409 `23505`, shown as "already recorded").
- **Money** is sent as integer strings in minor units (e.g. `"15780"`), never floats.
- **Errors**: backend codes (`trip_locked`, `forbidden`, `share_sum_mismatch`, …) are shown in the user's
  language via `apiErrors.*` (`lib/supabase.ts`); `validation_error` keeps the server's message.
- **Notifications**: types `expense_added`, `expense_updated`, `expense_deleted`, `settlement_received`,
  `member_joined`, `placeholder_claimed`, `trip_locked`. Settings shows the spec's five events; one switch can
  cover two types (see `features/notifications/notificationTypes.ts`). Push payload is `{ title, body, url }`.
- **Activity log**: `entity_type` `trip | trip_day | trip_member | trip_invite | expense | settlement`; actions include
  `create | update | delete | restore | join | claim | remove | leave | role_change | lock | unlock | invite_regen`.
- **Storage**: private bucket `trip-photos`, path `{trip_id}/{expense_id}/{uuid}.jpg` (`{trip_id}/{uuid}.jpg` for a
  new expense). Signed URLs only; a replaced photo is deleted after the expense saves.
- **Realtime**: `expenses, expense_participants, settlements, trip_members, trips, trip_days, notifications`.
  `expense_participants` has no `trip_id`, so it is subscribed unfiltered (RLS-limited) and matched against loaded
  expense ids.
