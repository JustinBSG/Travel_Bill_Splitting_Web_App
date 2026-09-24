# Travel Bill Split: backend (Supabase)

Backend-as-code for the PWA in `web/`, built to [`docs/backend-requirement.txt`](../docs/backend-requirement.txt)
and spec §6–9 and §12. Everything runs on one Supabase project: Auth, Postgres + RLS, Storage,
Realtime, Edge Functions and pg_cron. There is no Node server.

```
backend/
  config.toml                 CLI config: local dev, function verify_jwt, OTP email template
  migrations/
    20260924100000_schema.sql        tables, constraints, indexes, currency seed
    20260924100100_helpers_rls.sql   RLS helpers, JSON validators, policies, table grants
    20260924100200_triggers.sql      signup, updated_at, hard-delete guard, activity log,
                                     notifications, send_push hook
    20260924100300_storage.sql       private trip-photos bucket + storage policies
    20260924100400_rpc.sql           all RPCs + function grants
    20260924100500_realtime_cron.sql realtime publication, pg_cron jobs
  functions/
    join_trip/ regenerate_invite/ fetch_fx_rates/ send_push/
    _shared/                  CORS + errors, service client, Web Push (RFC 8291/8292), FX vendors
    .env.example              every Edge Function secret
  templates/otp_code.html     email OTP template (6-digit code, no link)
  seed.sql                    local-only sample FX rates
  scripts/supabase.mjs        CLI bridge (see below)
  tests/                      PGlite acceptance tests + Edge Function unit tests
```

## The CLI bridge (why there's a script)

The Supabase CLI always reads `<workdir>/supabase/config.toml`, and the requirements forbid a folder
named `supabase/`. So `supabase --workdir backend` cannot work as written. Instead, `scripts/supabase.mjs`
links `<os temp>/travel-bill-split-supabase/<hash>/supabase → backend/`, then runs
`supabase --workdir <that dir> …`. The link lives outside the repo so no tool walks into a loop. CLI
state such as the linked project ref is saved in `backend/.temp/` (git-ignored). Relative file
arguments like `--env-file backend/functions/.env` are turned into absolute paths. Use it anywhere
you would type `supabase`:

```bash
node backend/scripts/supabase.mjs db push
```

It uses `supabase` from PATH, or whatever is in `SUPABASE_BIN` (for example `SUPABASE_BIN="npx supabase"`).

## Deploy (one-time setup, then `db push` / `functions deploy`)

1. **Create the project** in `ap-southeast-1` (Singapore) or `ap-northeast-1` (Tokyo).
2. **Link and push the schema:**
   ```bash
   node backend/scripts/supabase.mjs link --project-ref <PROJECT_REF>
   ```
   ```bash
   node backend/scripts/supabase.mjs db push
   ```
3. **Vault secrets.** pg_cron and the database triggers read these. Run once in the SQL editor:
   ```sql
   select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'project_url');
   select vault.create_secret('<random 32+ chars>', 'cron_secret');          -- = CRON_SECRET
   select vault.create_secret('<random 32+ chars>', 'push_webhook_secret');  -- = PUSH_WEBHOOK_SECRET
   select vault.create_secret('<service_role key>', 'service_role_key');     -- delete_trip photo cleanup
   ```
4. **Edge Function secrets.** Copy `functions/.env.example` to `functions/.env` (git-ignored), fill it in, then:
   ```bash
   node backend/scripts/supabase.mjs secrets set --env-file backend/functions/.env
   ```
   ```bash
   node backend/scripts/supabase.mjs functions deploy
   ```
   `verify_jwt` comes from `config.toml`: on for `join_trip` / `regenerate_invite`; off for
   `fetch_fx_rates` / `send_push`, which check `CRON_SECRET` / `PUSH_WEBHOOK_SECRET` themselves.
5. **Auth (Dashboard, not code):**
   - Email: turn on email OTP with a 6-digit code. Paste `templates/otp_code.html` into the
     *Magic Link* and *Confirm signup* templates, so emails carry the code and no link.
   - Providers: Google and Apple.
   - Site URL and redirect allowlist: `http://localhost:5173`, the Pages production URL,
     `https://*.<project>.pages.dev` for previews, and the custom domain.
6. **First FX fetch.** Don't wait for the 00:10 HKT cron run:
   ```bash
   curl -X POST https://<PROJECT_REF>.supabase.co/functions/v1/fetch_fx_rates -H "x-cron-secret: <CRON_SECRET>"
   ```
   Backfill a past date with `-d '{"date":"2026-09-01"}'` (Open Exchange Rates and Frankfurter
   support this; ExchangeRate-API needs a paid plan). Frankfurter doesn't cover every seeded
   currency (TWD, VND, …). The response lists what's `missing`.
7. **Frontend env:** `web/.env.local` needs `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and
   `VITE_VAPID_PUBLIC_KEY`. Never put the service role key there.

Scheduled jobs (pg_cron): `fetch-fx-rates` runs at 16:10 UTC (00:10 HKT) and `fetch-fx-rates-retry`
at 22:10 UTC. The retry skips the vendor call when today's rates are already stored.
`purge-join-attempts` runs daily.

### Local development

```bash
node backend/scripts/supabase.mjs start
```
```bash
node backend/scripts/supabase.mjs db reset
```
```bash
node backend/scripts/supabase.mjs functions serve --env-file backend/functions/.env
```

`db reset` loads `seed.sql`, which holds sample FX rates for today, so expenses save without an FX
key. Emails appear in the local inbox at http://localhost:54324.

## Tests

```bash
cd backend/tests && npm install && npm test
```

- `acceptance.test.mjs` applies every migration to PGlite (Postgres 18 compiled to WASM) with small
  stand-ins for Supabase's `auth`, `storage`, `vault`, `pg_net` and `pg_cron`. It then plays the §10
  acceptance trip: 4 people, KRW + HKD, 4 days, a multi-day hotel, a loan, a personal souvenir, an
  AB meal, a date-range edit, a placeholder claim, and an HKD repayment of a KRW debt with an
  idempotent replay. After that it locks the trip, regenerates the invite, uploads photos and deletes
  the trip, checking every invariant along the way.
- `functions.test.mjs` checks Web Push encryption byte-for-byte against the RFC 8291 test vector,
  plus VAPID signatures, push texts, FX adapters (including API-key redaction) and CORS.

Not covered here: Realtime delivery itself, Storage signed URLs, and the Auth emails. Those need a
real project. The tests only check the prerequisites (publication, replica identity, RLS, private
bucket).

## API reference

Every request sends `apikey: <anon key>` and `Authorization: Bearer <access token>`. Field names are
column names. Money is always an integer in minor units: a JSON integer or a digit string. Fractions
are rejected.

| Call | Who | Notes |
|---|---|---|
| `GET /rest/v1/profiles?id=eq.{uid}` · `PATCH` `display_name`, `language` | self | Created at signup. Name from OAuth metadata, else `''` |
| `GET /rest/v1/currencies`, `GET /rest/v1/fx_rates?...` | signed in | `1 base = rate quote`; both X→HKD and HKD→X are stored |
| `POST /rest/v1/rpc/create_trip` `{name,start_date,end_date,days[]}` | signed in, name set | One transaction. Returns trip + `trip_days` + `trip_members` + `invite{invite_token,invite_code,join_path}` |
| `POST /rest/v1/rpc/update_trip` `{trip_id,name?,start_date?,end_date?,days?}` | admin | Days end up matching the range exactly. Every date needs a location |
| `GET /rest/v1/trips` · `PATCH /rest/v1/trips?id=eq.{id}` `name`, `joining_enabled` | member · admin | The trips table has no invite columns |
| `POST /rest/v1/rpc/lock_trip` / `unlock_trip` `{trip_id}` | admin | Lock notifies members |
| `POST /rest/v1/rpc/delete_trip` `{trip_id}` | owner, unlocked | Cascades everything and queues photo deletion |
| `POST /rest/v1/rpc/get_trip_invite` `{trip_id}` (or `GET ?trip_id=`) | admin | `{invite_token,invite_code,join_path}`. Anyone else gets 403 |
| `GET /rest/v1/trip_days?trip_id=eq.{id}` · `PATCH` a date's location | member · admin | Range changes go through `update_trip` |
| `GET /rest/v1/trip_members?trip_id=eq.{id}` | member | Includes removed members. `user_id null` = placeholder |
| `POST /rest/v1/trip_members` `{trip_id,display_name,role:'member',user_id:null}` | member | Placeholders only |
| `POST /rest/v1/rpc/set_member_role` `{member_id,role}` · `remove_member` `{member_id}` | admin | The owner can't be changed or removed |
| `POST /functions/v1/join_trip` `{code}`/`{token}`, `claim_placeholder_id?`, `preview?` | signed in | `{trip_id,member_id,claimed}`. With `preview`: trip + open placeholders, joins nothing |
| `POST /functions/v1/regenerate_invite` `{trip_id}` | admin | New `{invite_token,invite_code,join_path}`. The old ones die at once |
| `POST /rest/v1/rpc/save_expense` (body per requirement §5.G) | member | Create when `id` is null, else update (needs `expected_updated_at`). Returns expense + `expense_participants` |
| `POST /rest/v1/rpc/soft_delete_expense` `{expense_id,expected_updated_at}` · `restore_expense` `{expense_id}` | member | |
| `GET /rest/v1/expenses?trip_id=eq.{id}&deleted_at=is.null&select=*,expense_participants(*)` | member | |
| `POST /rest/v1/settlements` | member | Duplicate `idempotency_key` → 409 (`23505`) |
| `POST /rest/v1/rpc/record_settlement` (same fields) | member | Duplicate key → 200, the original row, `idempotent_replay: true` |
| `GET /rest/v1/activity_log?trip_id=eq.{id}&order=created_at.desc` | member | Append-only |
| `GET/PATCH /rest/v1/notifications` (`read_at`), `notification_settings`, `push_subscriptions` | self | |
| Storage `trip-photos` · `{trip_id}/{expense_id}/{uuid}.jpg` | member | Private, 5 MB, images only. Signed URLs only. Writes blocked while locked |

**Errors.** RPC errors keep PostgREST's envelope `{code,message,details,hint}`, with `code` set to a
contract code and the matching HTTP status. Edge Functions return `{"error":{"code","message"}}`.

| Code | HTTP | Code | HTTP |
|---|---|---|---|
| `unauthenticated` | 401 | `share_sum_mismatch` | 422 |
| `forbidden` | 403 | `fx_rate_missing` | 422 |
| `not_found` | 404 | `validation_error` | 422 |
| `invite_invalid` | 404 | `trip_locked` | 423 (403 from `join_trip`) |
| `joining_disabled` | 403 | `rate_limited` | 429 |
| `conflict_updated_at` | 409 (`details` = current row as JSON) | | |

`expected_updated_at` must be the `updated_at` string exactly as the API returned it, with
microseconds. Parsing it into a JS `Date` truncates to milliseconds and causes false 409s.

## Decisions where the requirement was silent or couldn't be followed literally

- **RPC verbs.** PostgREST RPCs accept only POST, and GET for read-only functions. The
  requirement's `PATCH /rpc/...` and GET-with-body forms are served as POST.
- **`join_trip` preview.** Spec §5.4 lets a joiner choose "I am <placeholder>", but a non-member
  can't read the member list. So `join_trip` takes `preview: true`, which returns the trip and its
  open placeholders without joining. Bad codes in preview count toward the rate limit.
- **Rate limit.** Failed lookups per user (10) and per IP-HMAC (30) in 15 minutes, set by env.
  Only hashes are stored, never the code, token or IP.
- **Rejoining.** Someone removed who joins again gets their old `trip_members` row back rather than
  a second row, so their history stays in one balance.
- **Past-dated FX.** Uses that date's rate. If that day is missing (cron gap, vendor holiday) it
  uses the nearest earlier stored day. If the date is older than all stored rates (a pre-trip
  booking made before launch) it uses the earliest stored rate. `fx_rate_date` always records the
  day used, and `fx_rate_missing` only fires when the currency has no rates at all.
- **Lock scope.** Invariant 9 is applied literally: while locked, even admins can't edit trip
  settings, roles or invites, or delete the trip. `unlock_trip` is the only write allowed.
- **Where logging happens.** Expense log rows are written by the expense RPCs, because the log
  needs the participants before and after a change. Every other table is logged by triggers. Invite
  rotation is logged without either secret.
- **Photo cleanup.** Deleting `storage.objects` rows in SQL would orphan the files. So `delete_trip`
  queues one Storage API `DELETE` per object through pg_net, sent after commit. This needs the
  `service_role_key` Vault secret.

## What `web/` must change to use this backend

The current frontend was written before this contract existed (its code comments say
"GAP: confirm with backend"). These calls need updating:

| web/ today | Use instead |
|---|---|
| `tripApi.createTrip`: insert into `trips`, `trip_members`, `trip_days` | `rpc('create_trip', {name,start_date,end_date,days})` (direct trip inserts aren't granted) |
| `saveTripSettings`: update trips dates + upsert/delete days | `rpc('update_trip', …)` (dates are only writable here) |
| `setTripFlags({is_locked})` | `rpc('lock_trip' / 'unlock_trip')`. `joining_enabled` can still be PATCHed |
| `deleteTrip`: `delete from trips` | `rpc('delete_trip', {trip_id})` |
| `fetchInvite`: selects `invite_token, invite_code` from `trips` | `rpc('get_trip_invite', {trip_id})` |
| `promoteToAdmin` / `removeMember`: update `trip_members` | `rpc('set_member_role')` / `rpc('remove_member')` |
| `expenseApi` create/update/`syncParticipants`/soft delete/restore | `rpc('save_expense')`, `rpc('soft_delete_expense')`, `rpc('restore_expense')` |
| `PHOTO_BUCKET = 'expense-photos'` | `'trip-photos'`. The current `{trip_id}/{uuid}.jpg` paths are accepted |
| Notification types `expense_changed` | `expense_updated` and `expense_deleted`. Also offer `placeholder_claimed` |
| `functionErrorMessage` reads `body.error` as a string | `body.error.message` (`body.error.code` for branching) |
| Activity: invite rotation | `entity_type 'trip_invite'`, `action 'invite_regen'`. Member removal: `remove` / `leave` |

These already match and need no change: settlement inserts (a 409 on a replayed key is still
handled), push subscribe/unsubscribe, notification reads, realtime subscriptions, `join_trip`
preview/join bodies, and the push payload `{title, body, url}`.
