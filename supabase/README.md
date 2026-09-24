# Travel Bill Split: backend (Supabase)

Backend-as-code for the PWA in `web/`, built to [`docs/backend-requirement.txt`](../docs/backend-requirement.txt)
and spec §6–9 and §12. Everything runs on one Supabase project: Auth, Postgres + RLS, Storage,
Realtime, Edge Functions and pg_cron. There is no Node server.

```
supabase/
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
  tests/                      pgTAP tests, run by `supabase test db` on the real database
  node-tests/                 Node tests: offline/ (PGlite, no Supabase needed), live/ (HTTP end-to-end)
  DEPLOY.md                   first-time setup: local, staging, production, troubleshooting
  RELEASE.md                  shipping updates to production: checklist, versioning, rollback
```

## Running the Supabase CLI

This folder is the CLI's standard `supabase/` project folder, so run the CLI from the repo root and
it finds `supabase/config.toml` by itself. Use an installed `supabase` or `npx supabase` (no
install needed):

```bash
npx supabase --version
```

CLI state such as the linked project ref is saved in `supabase/.temp/` (git-ignored).

## Deploy and release

- **[DEPLOY.md](DEPLOY.md)**: first-time setup. Local stack, then a **staging** project, then
  **production**, each with its own keys and secrets. Covers Vault, function secrets, Auth
  settings, the first FX fetch, verification, Cloudflare build variables and troubleshooting.
- **[RELEASE.md](RELEASE.md)**: shipping a new version to production. Covers semantic-version
  tags, safe migrations (expand then contract), the staging-then-production checklist, rollback
  and hotfixes.

Every deploy command names its target explicitly:

```bash
npx supabase db push --project-ref <REF>
```
```bash
npx supabase secrets set --project-ref <REF> --env-file supabase/functions/.env.staging
```
```bash
npx supabase functions deploy --use-api --project-ref <REF>
```

Scheduled jobs (pg_cron): `fetch-fx-rates` runs at 16:10 UTC (00:10 HKT) and `fetch-fx-rates-retry`
at 22:10 UTC. The retry skips the vendor call when today's rates are already stored.
`purge-join-attempts` runs daily.

## Tests

| Suite | Runs against | Command |
|---|---|---|
| `node-tests/offline/` | PGlite (Postgres 18 in WASM) + stand-ins for Supabase's `auth`, `storage`, `vault`, `pg_net`, `pg_cron`. No Supabase or Docker needed | `cd supabase/node-tests && npm install && npm test` |
| `tests/*.test.sql` (pgTAP) | the real database, local or deployed; one transaction per file, rolled back | `npx supabase test db [--linked]` |
| `node-tests/live/` | the real HTTP API of the local stack or a **staging** project | `cd supabase/node-tests && npm run test:live` |

- **Offline** (34 tests): `acceptance.test.mjs` plays the §10 acceptance trip. That's 4 people,
  KRW + HKD, 4 days, a multi-day hotel, a loan, a personal souvenir, an AB meal, a date-range
  edit, a placeholder claim, and an HKD repayment of a KRW debt with an idempotent replay. After
  that it locks the trip, regenerates the invite, uploads photos and deletes the trip.
  `functions.test.mjs` checks Web Push against the RFC 8291 test vector, plus VAPID, push texts,
  FX adapters and CORS. `pgtap.test.mjs` runs the pgTAP files below on PGlite, so they are
  checked on every run too.
- **pgTAP** (67 checks): `01_platform` covers grants, RLS, storage, Realtime, cron and the seed.
  `02_behaviour` covers the core flows as real users inside one rolled-back transaction.
- **Live**: Realtime delivery to a second member, photos unreachable without a signed URL, no
  invite code in a member's `GET /trips`, and join / claim / regenerate through the Edge
  Functions. Also rate limiting, locked-trip errors over HTTP, the machine-function secrets and
  CORS. It creates throwaway users and deletes them at the end; never point it at production.

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

## Frontend

`web/` calls exactly this contract; its `*Api.ts` modules are summarised in
[`web/README.md`](../web/README.md#backend-contract).
