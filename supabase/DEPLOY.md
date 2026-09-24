# Deploy and test the backend on Supabase

This takes you from zero to a working production backend, then shows how to verify it and how to
ship changes afterwards. Run every command from the **repo root**. The Supabase CLI always goes
through `node backend/scripts/supabase.mjs …`, because the repo can't have a `supabase/` folder
(see [README](README.md#the-cli-bridge-why-theres-a-script)).

**Contents**
1. [Prerequisites](#1-prerequisites)
2. [Create the project](#2-create-the-project)
3. [Link the repo](#3-link-the-repo)
4. [Push the database](#4-push-the-database)
5. [Generate secrets](#5-generate-secrets)
6. [Vault secrets](#6-vault-secrets-for-cron-push-and-photo-cleanup)
7. [Edge Function secrets and deploy](#7-edge-function-secrets-and-deploy)
8. [Auth settings](#8-auth-settings-dashboard)
9. [Load exchange rates](#9-load-exchange-rates)
10. [Verify the deployment](#10-verify-the-deployment)
11. [Connect the frontend](#11-connect-the-frontend)
12. [Shipping changes later](#12-shipping-changes-later)
13. [Local stack](#13-local-stack-full-supabase-on-your-machine)
14. [Test suites at a glance](#14-test-suites-at-a-glance)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. Prerequisites

| Need | For | How |
|---|---|---|
| Supabase account | everything | https://supabase.com/dashboard |
| Node.js 20+ | bridge script, tests | https://nodejs.org |
| Supabase CLI | deploy | Windows: `scoop bucket add supabase https://github.com/supabase/scoop-bucket.git` then `scoop install supabase`. macOS: `brew install supabase/tap/supabase`. Or skip installing and set `SUPABASE_BIN="npx supabase"` |
| Docker Desktop | only the local stack and `test db` | https://www.docker.com/products/docker-desktop |
| FX API key | daily exchange rates | Open Exchange Rates (free plan works) or ExchangeRate-API |
| VAPID keys | Web Push | generated in step 5 |

Check the CLI works through the bridge:

```bash
node backend/scripts/supabase.mjs --version
```

## 2. Create the project

1. Dashboard → **New project**. Region: **Southeast Asia (Singapore)** or **Northeast Asia (Tokyo)**.
   Save the **database password**; the CLI asks for it.
2. Note these from **Project Settings**:
   - **Project ref**: the 20 lowercase letters in `https://<PROJECT_REF>.supabase.co`.
   - **API keys**: the `anon` key and the `service_role` key, under the *Legacy API keys* tab.
     This backend uses them, so keep legacy keys enabled. The service_role key never goes in `web/`.

> Tip: make a second, free project for **staging**. The live end-to-end suite (step 10) should run
> there, never on production.

## 3. Link the repo

```bash
node backend/scripts/supabase.mjs login
```
```bash
node backend/scripts/supabase.mjs link --project-ref <PROJECT_REF>
```

The link is saved in `backend/.temp/`, which is git-ignored.

## 4. Push the database

Preview first, then apply the six migrations in `backend/migrations/`:

```bash
node backend/scripts/supabase.mjs db push --dry-run
```
```bash
node backend/scripts/supabase.mjs db push
```

This creates the tables, RLS policies, triggers, RPCs, the private `trip-photos` bucket, the
Realtime publication and the pg_cron jobs. Check it in the Dashboard: **Table Editor** (13 tables
in `public`), **Storage** (bucket `trip-photos`, private) and **Integrations → Cron** (3 jobs).

If it stops at `pg_cron` or `pg_net`, enable them under **Database → Extensions** and run
`db push` again. Migrations that already ran are skipped.

## 5. Generate secrets

Run each of these and keep the output for steps 6 and 7:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Run it twice: once for **CRON_SECRET**, once for **PUSH_WEBHOOK_SECRET**.

```bash
npx web-push generate-vapid-keys
```
This gives **VAPID_PUBLIC_KEY** and **VAPID_PRIVATE_KEY**. The public key also goes to the
frontend (step 11).

## 6. Vault secrets (for cron, push and photo cleanup)

The database calls Edge Functions itself: pg_cron calls `fetch_fx_rates`, the notifications
trigger calls `send_push`, and `delete_trip` removes photos through the Storage API. It reads the
URL and secrets from Vault. Open **SQL Editor** and run, with your values:

```sql
select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'project_url');
select vault.create_secret('<CRON_SECRET>', 'cron_secret');
select vault.create_secret('<PUSH_WEBHOOK_SECRET>', 'push_webhook_secret');
select vault.create_secret('<service_role key>', 'service_role_key');
```

To change one later, use `vault.update_secret` or **Database → Vault** in the Dashboard. A
missing secret never breaks a write; that feature is just skipped, with a warning in the
Postgres logs.

## 7. Edge Function secrets and deploy

1. Copy `backend/functions/.env.example` to `backend/functions/.env` (git-ignored) and fill it in:
   - `ALLOWED_ORIGINS`: your Pages URL, `https://*.<project>.pages.dev` for previews, any custom
     domain, and `http://localhost:5173`.
   - `FX_PROVIDER`, `FX_API_BASE`, `FX_API_KEY`.
   - `CRON_SECRET` and `PUSH_WEBHOOK_SECRET`: the same values as in Vault.
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (`mailto:you@yourdomain`).
2. Upload the secrets:
   ```bash
   node backend/scripts/supabase.mjs secrets set --env-file backend/functions/.env
   ```
   ```bash
   node backend/scripts/supabase.mjs secrets list
   ```
3. Deploy all four functions. `--use-api` bundles them on Supabase's side, so Docker isn't needed:
   ```bash
   node backend/scripts/supabase.mjs functions deploy --use-api
   ```
   `verify_jwt` comes from `backend/config.toml`: **on** for `join_trip` and `regenerate_invite`,
   **off** for `fetch_fx_rates` and `send_push`, which check their own secrets. Confirm under
   **Edge Functions** in the Dashboard.

## 8. Auth settings (Dashboard)

**Authentication → Sign In / Providers → Email**
- Enable Email. Email OTP length **6**, expiry **600** seconds.

**Authentication → Emails → Templates**
- Paste `backend/templates/otp_code.html` into both **Magic Link** and **Confirm signup**. The
  template contains only `{{ .Token }}`, so emails carry the 6-digit code and no sign-in link.

**Authentication → Emails → SMTP Settings**
- Set up custom SMTP (Resend, Postmark, SES, …). The built-in sender allows only a few emails per
  hour and is not meant for real users.

**Authentication → Sign In / Providers → Google and Apple**
- Create the OAuth clients with the providers. The redirect/callback URL for both is
  `https://<PROJECT_REF>.supabase.co/auth/v1/callback`. Paste the client IDs and secrets here.

**Authentication → URL Configuration**
- **Site URL**: your production frontend URL.
- **Redirect URLs**: `http://localhost:5173/**`, `https://<project>.pages.dev/**`,
  `https://*.<project>.pages.dev/**` and `https://<custom-domain>/**`.

## 9. Load exchange rates

Expenses in a foreign currency need at least one day of rates. Fetch today's instead of waiting
for the 00:10 HKT cron run:

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/fetch_fx_rates" -H "x-cron-secret: <CRON_SECRET>"
```

Optionally backfill past days, one call per date, for pre-trip expenses:

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/fetch_fx_rates" -H "x-cron-secret: <CRON_SECRET>" -H "Content-Type: application/json" -d "{\"date\":\"2026-09-01\"}"
```

Check in the SQL Editor:
```sql
select rate_date, count(*) from public.fx_rates group by 1 order by 1 desc;
```
The response's `missing` list shows currencies your vendor doesn't cover.

## 10. Verify the deployment

**a) pgTAP inside the deployed database** (needs Docker running). Both files run in one
transaction and roll back, so this is safe on production:

```bash
node backend/scripts/supabase.mjs test db --linked
```

- `01_platform.test.sql` (27 checks): RLS on every table, no `anon` access, the column-level
  grants, RPC execute rights, triggers, the private bucket and its policies, the Realtime
  publication, the pg_cron jobs and the currency seed.
- `02_behaviour.test.sql` (40 checks): throwaway users and a trip exercising create/join,
  invite secrecy, placeholders, AA/AB/personal expenses, conflicts, settlement replay, lock, soft
  delete, append-only log, storage visibility, invite rotation and delete.

**b) Live end-to-end over HTTP, on staging only.** It goes through the real gateway, Edge
Functions, Realtime and Storage, and covers the acceptance items the database can't check alone:
Realtime delivery to a second member, photos unreachable without a signed URL, and no invite code
in a member's `GET /trips`.

```bash
cd backend/node-tests && npm install
```
Copy `backend/node-tests/.env.live.example` to `.env.live`. Set `SUPABASE_URL`, the anon and
service_role keys **of the staging project**, and `LIVE_ALLOW_REMOTE=1`. Optionally set
`PUSH_WEBHOOK_SECRET`, `CRON_SECRET` + `LIVE_RUN_FX=1` and `LIVE_ALLOWED_ORIGIN`. Then:

```bash
npm run test:live
```

It creates users named `e2e-<run>-alice@example.com` and so on (no email is sent) plus one
trip, and deletes them at the end. If a run is interrupted, delete leftover `e2e-` users under
**Authentication → Users**.

**c) A quick smoke test on production.** This must return `401` (no user token):

```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/join_trip" -H "apikey: <anon key>" -H "Content-Type: application/json" -d "{\"code\":\"K7P2QX\"}"
```

## 11. Connect the frontend

- Local: `web/.env.local` gets `VITE_SUPABASE_URL=https://<PROJECT_REF>.supabase.co`,
  `VITE_SUPABASE_ANON_KEY=<anon key>` and `VITE_VAPID_PUBLIC_KEY=<VAPID public key>`.
- Cloudflare Pages: add the same three variables under **Settings → Environment variables** for
  Production and Preview, then redeploy.
- The Pages domain must be listed in `ALLOWED_ORIGINS` (step 7) and in Auth Redirect URLs
  (step 8).

## 12. Shipping changes later

1. Create a migration. Never edit one that has already been pushed:
   ```bash
   node backend/scripts/supabase.mjs migration new <short_name>
   ```
   This creates `backend/migrations/<timestamp>_<short_name>.sql`.
2. Test offline (no Docker, a few seconds):
   ```bash
   cd backend/node-tests && npm test
   ```
3. Optionally test on the local stack (section 13): `db reset`, then `test db`, then `npm run test:live`.
4. Ship it:
   ```bash
   node backend/scripts/supabase.mjs db push
   ```
   ```bash
   node backend/scripts/supabase.mjs functions deploy --use-api
   ```
   Run `db push` before `functions deploy` when a function depends on a new RPC.
5. Verify with `node backend/scripts/supabase.mjs test db --linked`.

Changed a secret? Run `secrets set` again. Running functions pick it up on their next cold start;
redeploy if you need it immediately.

## 13. Local stack (full Supabase on your machine)

Needs Docker Desktop running.

```bash
node backend/scripts/supabase.mjs start
```
```bash
node backend/scripts/supabase.mjs db reset
```
`db reset` applies the migrations plus `backend/seed.sql` (sample FX rates for today).

Serve the functions in a second terminal. They read `backend/functions/.env`:
```bash
node backend/scripts/supabase.mjs functions serve
```

Then:
```bash
node backend/scripts/supabase.mjs test db
```
```bash
node backend/scripts/supabase.mjs status -o env
```
Copy `API_URL`, `ANON_KEY` and `SERVICE_ROLE_KEY` into `backend/node-tests/.env.live`
(`LIVE_ALLOW_REMOTE` isn't needed for localhost), then:
```bash
cd backend/node-tests && npm run test:live
```

Local extras: Studio at http://localhost:54323 and the email inbox at http://localhost:54324.
For push and cron to reach the local functions from inside Postgres, set the Vault secret
`project_url` to `http://host.docker.internal:54321`.

## 14. Test suites at a glance

| Suite | Where | Runs against | Command | Needs |
|---|---|---|---|---|
| Offline acceptance + unit + pgTAP-on-PGlite | `backend/node-tests/offline/` | embedded Postgres (PGlite) with Supabase stubs | `cd backend/node-tests && npm test` | Node only |
| pgTAP | `backend/tests/*.test.sql` | the real database: local or linked | `node backend/scripts/supabase.mjs test db [--linked]` | Docker |
| Live end-to-end | `backend/node-tests/live/` | the real HTTP API: local or **staging** | `cd backend/node-tests && npm run test:live` | a running stack |

## 15. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `db push`: permission denied for extension `pg_cron` / `pg_net` | Enable it under **Database → Extensions**, then push again |
| Browser: CORS error calling `join_trip` | Add the exact origin to `ALLOWED_ORIGINS`, run `secrets set` again, and redeploy the function |
| `join_trip` returns 401 from the app | The request lacks a user access token. The user must be signed in (supabase-js adds it) |
| Saving a JPY/KRW/… expense returns `fx_rate_missing` | No rates stored yet. Run step 9, then check the cron history: `select * from cron.job_run_details order by start_time desc limit 5;` and `select * from net._http_response order by created desc limit 5;` |
| Push notifications never arrive | Check the Vault `project_url` / `push_webhook_secret`, the VAPID secrets, **Edge Functions → send_push → Logs**, and `net._http_response` |
| Photos remain after a trip is deleted | The Vault secret `service_role_key` is missing |
| OTP emails don't arrive | The built-in SMTP rate limit. Set up custom SMTP (step 8) |
| Live suite: joins start returning 429 | The per-IP join limit (30 failed attempts in 15 minutes); each live run makes about 12. Wait 15 minutes, or raise `JOIN_RATE_LIMIT_MAX_FAILURES_PER_IP` on staging |
| `test db`: cannot connect to Docker | Start Docker Desktop. `test db` runs `pg_prove` in a container |
| `functions deploy` wants Docker | Add `--use-api` |
