# Deploy Travel Bill Split from scratch

One guide, start to finish: the **database**, the **backend** (Supabase Auth, Storage, Edge
Functions) and the **frontend** (the PWA on Cloudflare), first on **staging**, then on
**production**.

More detail on each half lives next to the code. This guide links to it where useful:
- [supabase/DEPLOY.md](supabase/DEPLOY.md): backend, local stack and test suites
- [web/DEPLOY.md](web/DEPLOY.md): Cloudflare Worker setup and frontend releases
- [supabase/RELEASE.md](supabase/RELEASE.md): shipping **updates** once everything is live

**Contents**
- [0. The big picture](#0-the-big-picture)
- [1. Accounts and tools](#1-accounts-and-tools)
- [2. Values sheet](#2-values-sheet)
- [3. Check the code locally](#3-check-the-code-locally)
- [4. Database and backend on staging](#4-database-and-backend-on-staging)
- [5. Frontend on Cloudflare](#5-frontend-on-cloudflare)
- [6. Test staging end to end](#6-test-staging-end-to-end)
- [7. Production](#7-production)
- [8. Final checklist](#8-final-checklist)
- [9. After go-live](#9-after-go-live)
- [10. Troubleshooting](#10-troubleshooting)
- [Appendix A: every setting and where it lives](#appendix-a-every-setting-and-where-it-lives)
- [Appendix B: local stack (optional)](#appendix-b-local-stack-optional)

---

## 0. The big picture

```
 Browser / installed PWA  (web/, React + Vite)
   │   served by Cloudflare Workers static assets, built from GitHub
   │
   │  HTTPS: supabase-js with the public anon key
   ▼
 Supabase project  (supabase/)
   ├─ Postgres ── tables, RLS, RPCs, triggers        ← supabase/migrations/*.sql
   │    ├─ pg_cron ── daily FX fetch, cleanup jobs
   │    └─ pg_net ─── calls Edge Functions (push, FX, photo cleanup), secrets from Vault
   ├─ Auth ─────── email 6-digit code, Google (optional)
   ├─ Storage ──── private bucket trip-photos
   ├─ Realtime ─── live updates between trip members
   └─ Edge Functions ── join_trip, regenerate_invite, fetch_fx_rates, send_push
                          │
                          ├─► FX vendor (Open Exchange Rates, …)
                          └─► browser push services (Web Push / VAPID)
```

### Environments

| | Staging | Production |
|---|---|---|
| Supabase project | `travel-bill-split-staging` | `travel-bill-split` |
| Frontend | Cloudflare **preview** builds of every non-`main` branch (for example `uat`) | Cloudflare **production** build of `main` |
| Frontend URL | `https://uat-travel-bill-splitting-web-app.<SUBDOMAIN>.workers.dev` | `https://travel-bill-splitting-web-app.<SUBDOMAIN>.workers.dev` and/or your custom domain |
| Test suites allowed | all of them | read-only checks only |

The two environments share **nothing**: separate projects, keys, secrets, VAPID keys and data.

### Order of work

1. Accounts, tools and the values sheet (sections 1–2).
2. Staging database and backend (section 4).
3. The Cloudflare Worker, which serves both staging previews and production (section 5).
4. Test staging (section 6).
5. Production backend, then merge to `main` for the production frontend (section 7).

**Deploys that happen automatically:** only the frontend. Cloudflare rebuilds when you push to
GitHub. The database, Edge Functions, secrets and Dashboard settings are **always deployed by
hand** with the Supabase CLI or Dashboard. Release the backend **before** merging frontend code
that needs it.

---

## 1. Accounts and tools

### Accounts

| Account | Needed for | Notes |
|---|---|---|
| GitHub | the repo, Cloudflare builds | Cloudflare builds from `JustinBSG/Travel_Bill_Splitting_Web_App` |
| [Supabase](https://supabase.com/dashboard) | database, auth, storage, functions | Free plan works; free projects **pause after ~1 week idle** (click **Restore**) |
| [Cloudflare](https://dash.cloudflare.com) | hosting the frontend | Free plan works |
| FX rates vendor | daily exchange rates | [Open Exchange Rates](https://openexchangerates.org) (free plan, needs a key), [ExchangeRate-API](https://www.exchangerate-api.com) (key), or [Frankfurter](https://frankfurter.dev) (no key, but only ECB currencies: **no TWD** and some others) |
| Email sender (SMTP) | sign-in code emails in production | For example [Resend](https://resend.com) or Postmark, with a domain you control |
| Google Cloud (optional) | "Sign in with Google" | https://console.cloud.google.com |

**Find your Cloudflare workers.dev subdomain now.** Several backend settings need the frontend's
URL before the frontend exists. In Cloudflare: **Workers & Pages** (overview page, right side), or
**Account settings → workers.dev subdomain**. Choose one if the account has none. Write it down as
`SUBDOMAIN`.

### Tools on your PC

| Tool | Version | Check |
|---|---|---|
| Git | any recent | `git --version` |
| Node.js | **22** (20+ works) | `node --version` |
| Supabase CLI | none to install: `npx supabase` downloads it | `npx supabase --version` |
| Docker Desktop | only for pgTAP tests and the local stack | `docker info` |

**Windows:** run commands in PowerShell from the **repo root** unless told otherwise. Use
`curl.exe` (plain `curl` is a different command in PowerShell) and `Copy-Item` instead of `cp`.
Keep Docker's disk image outside OneDrive, on a drive with 15 GB+ free.

---

## 2. Values sheet

Keep this in a private notes file **outside the repo** (a password manager is ideal) and fill it in
as you go. Values marked 🔒 are secret: never put them in `web/`, git, Cloudflare build variables
or chat.

```
# Shared
SUBDOMAIN=                      # <SUBDOMAIN>.workers.dev
CUSTOM_DOMAIN=                  # optional, e.g. trips.example.com
FX_API_KEY=                     # 🔒 FX vendor key

# Staging                                   # Production
STAGING_REF=                                PROD_REF=                      # 20 letters in the project URL
STAGING_DB_PASSWORD=          🔒            PROD_DB_PASSWORD=          🔒
STAGING_ANON_KEY=                           PROD_ANON_KEY=                 # public
STAGING_SERVICE_ROLE_KEY=     🔒            PROD_SERVICE_ROLE_KEY=     🔒
STAGING_CRON_SECRET=          🔒            PROD_CRON_SECRET=          🔒
STAGING_PUSH_WEBHOOK_SECRET=  🔒            PROD_PUSH_WEBHOOK_SECRET=  🔒
STAGING_VAPID_PUBLIC_KEY=                   PROD_VAPID_PUBLIC_KEY=         # public
STAGING_VAPID_PRIVATE_KEY=    🔒            PROD_VAPID_PRIVATE_KEY=    🔒

# Optional
GOOGLE_CLIENT_ID=                           GOOGLE_CLIENT_SECRET=      🔒
SMTP_HOST=  SMTP_PORT=  SMTP_USER=  SMTP_PASSWORD= 🔒  SMTP_SENDER=
```

---

## 3. Check the code locally

Deploy only code that builds and passes its tests.

```bash
git switch uat
```
```bash
git pull
```
```bash
git status
```
`git status` must be clean, so what you deploy is a known commit.

**Frontend** (in `web/`):
```bash
cd web
```
```bash
npm ci
```
```bash
npm run lint
```
```bash
npm test
```
```bash
npm run build
```
The build type-checks and writes `web/dist`. Then go back to the repo root (`cd ..`).

**Backend offline tests** (no Supabase or Docker needed):
```bash
cd supabase/node-tests
```
```bash
npm install
```
```bash
npm test
```
Every test must pass. This runs all migrations on an embedded Postgres, a full trip flow, the Edge
Function helpers and the pgTAP files. Go back to the repo root afterwards.

To run the whole stack on your PC first, see [Appendix B](#appendix-b-local-stack-optional).

---

## 4. Database and backend on staging

Every command below targets **staging**: `<REF>` = `STAGING_REF`, and the secrets file is
`supabase/functions/.env.staging`. Section 7 repeats this for production.

### 4.1 Create the Supabase project

1. https://supabase.com/dashboard → **New project**.
2. Name `travel-bill-split-staging`. Region **Singapore** or **Tokyo** (close to Hong Kong). Use
   the **same region** for production later.
3. **Generate a password**, then save it as `STAGING_DB_PASSWORD`.
4. Wait until the project is ready (about 2 minutes), then record:
   - `STAGING_REF`: from the URL `https://supabase.com/dashboard/project/<REF>`.
   - `STAGING_ANON_KEY` and `STAGING_SERVICE_ROLE_KEY`: **Project Settings → API Keys → Legacy
     API keys** (the long `eyJ…` values).

### 4.2 Log in and link the CLI

```bash
npx supabase login
```
A browser window opens; approve it. Then set the database password for this terminal, so the CLI
doesn't keep asking:

| PowerShell | Bash |
|---|---|
| `$env:SUPABASE_DB_PASSWORD = "<STAGING_DB_PASSWORD>"` | `export SUPABASE_DB_PASSWORD="<STAGING_DB_PASSWORD>"` |

```bash
npx supabase link --project-ref <STAGING_REF>
```
Confirm which project is linked. It must print `STAGING_REF`:
```bash
Get-Content supabase/.temp/project-ref
```
(macOS/Linux: `cat supabase/.temp/project-ref`.) **Do this check before every command that uses
the linked project.**

### 4.3 Create the database (migrations)

The whole schema is code in `supabase/migrations/`, applied in file-name order:

| Migration | Creates |
|---|---|
| `20260924100000_schema.sql` | tables, currencies, constraints |
| `20260924100100_helpers_rls.sql` | helper functions, Row Level Security policies, grants |
| `20260924100200_triggers.sql` | triggers: activity log, notifications, push hook, sign-up profile |
| `20260924100300_storage.sql` | private `trip-photos` bucket and its policies, photo cleanup |
| `20260924100400_rpc.sql` | the RPC API the app calls |
| `20260924100500_realtime_cron.sql` | Realtime publication, `pg_cron` jobs |
| `20260925100000_expense_all_day.sql` | all-day expenses |

Preview first. It must list exactly those files:
```bash
npx supabase db push --project-ref <STAGING_REF> --dry-run
```
Apply:
```bash
npx supabase db push --project-ref <STAGING_REF>
```
If it stops with *permission denied for extension `pg_cron`* or `pg_net`, enable both under
**Database → Extensions**, then run the push again.

**Check in the Dashboard:**
- **Table Editor** (schema `public`): 14 tables: `activity_log`, `currencies`,
  `expense_participants`, `expenses`, `fx_rates`, `notification_settings`, `notifications`,
  `profiles`, `push_subscriptions`, `settlements`, `trip_days`, `trip_invites`, `trip_members`,
  `trips`.
- **Storage**: bucket `trip-photos`, **private**, 5 MB limit.
- **Integrations → Cron** (or **Database → Cron**): 3 jobs. `fetch-fx-rates` (16:10 UTC =
  00:10 HKT), `fetch-fx-rates-retry` (22:10 UTC) and `purge-join-attempts`.
- **Database → Publications → `supabase_realtime`**: includes the trip tables.

`supabase/seed.sql` (sample FX rates) is for the local stack only. Cloud projects get real rates in
4.9.

### 4.4 Generate this environment's secrets

Run this **twice**. Save the first output as `STAGING_CRON_SECRET` and the second as
`STAGING_PUSH_WEBHOOK_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Generate the Web Push (VAPID) key pair and save both keys:
```bash
npx web-push generate-vapid-keys
```
Keep VAPID keys stable once users have enabled push. New keys invalidate every existing push
subscription, and users have to turn push on again.

### 4.5 Write the function secrets file

```bash
Copy-Item supabase/functions/.env.example supabase/functions/.env.staging
```
(Bash: `cp supabase/functions/.env.example supabase/functions/.env.staging`.) The file is
git-ignored. Fill it in:
```
ALLOWED_ORIGINS=http://localhost:5173,https://*-travel-bill-splitting-web-app.<SUBDOMAIN>.workers.dev
FX_PROVIDER=openexchangerates
FX_API_BASE=https://openexchangerates.org/api
FX_API_KEY=<FX_API_KEY>
CRON_SECRET=<STAGING_CRON_SECRET>
PUSH_WEBHOOK_SECRET=<STAGING_PUSH_WEBHOOK_SECRET>
VAPID_PUBLIC_KEY=<STAGING_VAPID_PUBLIC_KEY>
VAPID_PRIVATE_KEY=<STAGING_VAPID_PRIVATE_KEY>
VAPID_SUBJECT=mailto:<your email>
JOIN_RATE_LIMIT_MAX_FAILURES=10
JOIN_RATE_LIMIT_MAX_FAILURES_PER_IP=30
JOIN_RATE_LIMIT_WINDOW_MINUTES=15
JOIN_RATE_LIMIT_SALT=
```
- `ALLOWED_ORIGINS`: browser origins allowed to call `join_trip` / `regenerate_invite`. It's a
  comma list with **no spaces** and no trailing `/`. `*` matches exactly one host label, so the
  pattern above covers this Worker's previews (`uat-…`, deployment IDs) and nothing else.
- Other FX vendors: `FX_PROVIDER=exchangerate-api` with `FX_API_BASE=https://v6.exchangerate-api.com/v6`,
  or `FX_PROVIDER=frankfurter` with an empty `FX_API_KEY`.
- **Don't** add `SUPABASE_URL`, `SUPABASE_ANON_KEY` or `SUPABASE_SERVICE_ROLE_KEY`. Supabase
  injects them into functions automatically.

### 4.6 Vault secrets (database → functions)

The database calls Edge Functions itself: the FX cron jobs, `send_push` when a notification is
inserted, and photo cleanup after a trip is deleted. It reads the target URL and secrets from
**Vault**. In **SQL Editor**, run once with the staging values:
```sql
select vault.create_secret('https://<STAGING_REF>.supabase.co', 'project_url');
select vault.create_secret('<STAGING_CRON_SECRET>', 'cron_secret');
select vault.create_secret('<STAGING_PUSH_WEBHOOK_SECRET>', 'push_webhook_secret');
select vault.create_secret('<STAGING_SERVICE_ROLE_KEY>', 'service_role_key');
```
The names must be exactly these. `cron_secret` and `push_webhook_secret` must equal `CRON_SECRET`
and `PUSH_WEBHOOK_SECRET` in `.env.staging`. A missing secret never breaks a save; that feature is
just skipped, with a warning in **Logs → Postgres**.

To change one later:
```sql
select vault.update_secret((select id from vault.secrets where name = 'cron_secret'), '<new value>');
```

### 4.7 Upload secrets and deploy the Edge Functions

```bash
npx supabase secrets set --project-ref <STAGING_REF> --env-file supabase/functions/.env.staging
```
```bash
npx supabase secrets list --project-ref <STAGING_REF>
```
Deploy all four functions. `--use-api` bundles them on Supabase's side, so Docker isn't needed:
```bash
npx supabase functions deploy --use-api --project-ref <STAGING_REF>
```
**Edge Functions** in the Dashboard should list:

| Function | JWT check (`config.toml`) | Called by |
|---|---|---|
| `join_trip` | on | the app, signed-in users joining by link or code |
| `regenerate_invite` | on | the app, trip admins |
| `fetch_fx_rates` | off; checks `x-cron-secret` | `pg_cron`, or you by hand |
| `send_push` | off; checks `x-webhook-secret` | the notifications trigger via `pg_net` |

Redeploy the functions after **every** `secrets set`, so running instances pick up the new values.

### 4.8 Auth settings (Dashboard)

**Authentication → Sign In / Providers → Email**
- Email provider **enabled**, **Confirm email** off (the code proves the address).
- **Email OTP length: 6**, **Email OTP expiration: 600** seconds.

**Authentication → URL Configuration**

| Field | Staging value |
|---|---|
| Site URL | `http://localhost:5173` (or your `uat` preview URL) |
| Redirect URLs | `http://localhost:5173/**` and `https://*-travel-bill-splitting-web-app.<SUBDOMAIN>.workers.dev/**` |

**Authentication → Emails → SMTP Settings** (optional on staging, **required** in production)

Without custom SMTP, Supabase's built-in sender delivers only to members of your Supabase
organization, and only a few emails per hour. To set it up, for example with Resend:
1. Add and verify your domain in Resend (DNS records), then create an API key.
2. In Supabase, turn on **Enable custom SMTP**: host `smtp.resend.com`, port `465`, username
   `resend`, password = the API key, sender email like `no-reply@<your domain>`, sender name
   `Travel Bill Split`.
3. **Authentication → Rate Limits**: raise the email limit to fit your usage (for example 30 per
   hour).

**Authentication → Emails → Templates** (editable only after custom SMTP is on)

Paste `supabase/templates/otp_code.html` into both **Magic link or OTP** and **Confirm sign up**.
Use the subject `Your Travel Bill Split code / 你的旅行分帳登入碼`. The app signs in by the typed
6-digit code, so the email must contain `{{ .Token }}`, which the template does.

Without SMTP on staging, the default email contains a link instead of a code. Open it **in the
same browser** where you asked for the code; it goes to the Site URL and finishes signing in.

### 4.9 Google sign-in (optional)

1. Google Cloud Console → create or select a project → **APIs & Services → OAuth consent screen**:
   User type **External**, app name `Travel Bill Split`, support email, scopes `email`, `profile`,
   `openid`. Publish it (or add test users while it's in Testing).
2. **Credentials → Create credentials → OAuth client ID → Web application**:
   - **Authorized JavaScript origins**: your site origins, for example
     `https://travel-bill-splitting-web-app.<SUBDOMAIN>.workers.dev` and
     `https://<CUSTOM_DOMAIN>` (and `http://localhost:5173` for local testing).
   - **Authorized redirect URIs**: `https://<REF>.supabase.co/auth/v1/callback`. Add one line
     per Supabase project (staging and production).
3. Copy the client ID and secret into Supabase → **Authentication → Sign In / Providers →
   Google** → enable, paste, save.

After sign-in, Google returns to Supabase, then Supabase returns to the page the user started on.
That page must match a **Redirect URL** from 4.8, which is why those end in `/**`.

### 4.10 Load exchange rates

Rates are fetched daily by cron. Load today's now, so foreign-currency expenses work at once:
```bash
curl.exe -X POST "https://<STAGING_REF>.supabase.co/functions/v1/fetch_fx_rates" -H "x-cron-secret: <STAGING_CRON_SECRET>"
```
Check in **SQL Editor**:
```sql
select rate_date, count(*) from fx_rates group by 1 order by 1 desc;
```
To backfill a past date (for expenses dated before today), add
`-H "Content-Type: application/json" -d "{\"date\":\"2026-09-01\"}"` to the same command, once per
date. The response's `missing` list shows currencies your vendor doesn't cover.

### 4.11 Quick backend checks

Needs Docker running, with staging linked (4.2):
```bash
npx supabase test db --linked
```
All pgTAP checks must pass. They run in a transaction and are rolled back.

Smoke test. This must return **401** (no signed-in user):
```bash
curl.exe -i -X POST "https://<STAGING_REF>.supabase.co/functions/v1/join_trip" -H "apikey: <STAGING_ANON_KEY>" -H "Content-Type: application/json" -d "{\"code\":\"K7P2QX\"}"
```

---

## 5. Frontend on Cloudflare

One Cloudflare Worker serves both environments. `main` builds with the **production** backend
values; every other branch builds a **preview** with the **staging** values.
`web/scripts/build-cloudflare.mjs` picks the set by branch name.

What's already in the repo:

| File | What it does |
|---|---|
| `web/wrangler.jsonc` | Worker name `travel-bill-splitting-web-app`; serves `./dist`; SPA fallback, so `/join/<token>` and `/trips/…` load `index.html`; preview URLs on |
| `web/scripts/build-cloudflare.mjs` | `npm run build:cloudflare`: maps `PROD_VITE_*` or `STAGING_VITE_*` to `VITE_*`, then runs `npm run build` |
| `web/vite.config.ts` | PWA: service worker with auto-update, `push-sw.js` for push notifications |

### 5.1 Create the Worker from GitHub

1. https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Import a repository**.
2. Authorize Cloudflare's GitHub app for `JustinBSG/Travel_Bill_Splitting_Web_App` and select it.
3. Configure:

   | Field | Value |
   |---|---|
   | Project / Worker name | `travel-bill-splitting-web-app` (**must equal** `"name"` in `web/wrangler.jsonc`) |
   | Build command | `npm run build:cloudflare` |
   | Deploy command | `npx wrangler deploy` (default) |
   | Non-production branch deploy command | leave the default |
   | Advanced → **Path / Root directory** | `web` |
   | Enable Preview Builds | **ticked** |

4. Add the build variables (5.2) before the first build if the screen allows it. Otherwise deploy
   once (it fails with *missing build variables*, which is expected), add them, then **Retry
   build**.

### 5.2 Build variables

Worker → **Settings → Build → Variables and secrets**. These are *build* variables, not the
runtime "Variables" higher up the page.

| Name | Value |
|---|---|
| `STAGING_VITE_SUPABASE_URL` | `https://<STAGING_REF>.supabase.co` |
| `STAGING_VITE_SUPABASE_ANON_KEY` | `STAGING_ANON_KEY` |
| `STAGING_VITE_VAPID_PUBLIC_KEY` | `STAGING_VAPID_PUBLIC_KEY` |
| `PROD_VITE_SUPABASE_URL` | `https://<PROD_REF>.supabase.co` (fill in after section 7.1) |
| `PROD_VITE_SUPABASE_ANON_KEY` | `PROD_ANON_KEY` |
| `PROD_VITE_VAPID_PUBLIC_KEY` | `PROD_VAPID_PUBLIC_KEY` |
| `NODE_VERSION` | `22` |
| `PRODUCTION_BRANCH` | optional; only if production isn't `main` |

- All of these are **public**: they end up in every browser. Never add the `service_role` key,
  the VAPID *private* key, or any other 🔒 value.
- The VAPID public key must be from the **same pair** as that environment's `VAPID_PRIVATE_KEY`
  function secret, or push can't be delivered.
- Values are baked in at build time. After changing one, **Retry build** (or push a commit).

### 5.3 Branch control and URLs

Worker → **Settings → Build → Branch control**:
- **Production branch**: `main`.
- **Enable Preview Builds**: ticked.
- **Build watch paths** (if shown): `web/*`, so backend-only pushes skip the build.

Worker → **Settings → Domains & Routes**:
- **Preview URLs**: enabled (`"preview_urls": true` in `wrangler.jsonc` keeps it on).
- Production URL: `https://travel-bill-splitting-web-app.<SUBDOMAIN>.workers.dev`.

The **staging frontend** is the `uat` preview. Push to `uat`, and Cloudflare builds it with the
`STAGING_*` values at `https://uat-travel-bill-splitting-web-app.<SUBDOMAIN>.workers.dev`. The build
log confirms it: `[build-cloudflare] branch "uat" -> staging (STAGING_VITE_*)`.

### 5.4 Custom domain (optional, production)

The domain must use Cloudflare DNS. Worker → **Settings → Domains & Routes → Add → Custom
domain**, for example `trips.example.com`. DNS and HTTPS are set up automatically. Then add it to
production's `ALLOWED_ORIGINS`, Site URL and Redirect URLs (section 7), and to Google's authorized
origins if you use Google sign-in.

---

## 6. Test staging end to end

**Only move on to production when all of this passes.**

1. **Live API suite** (creates throwaway users and a trip, then deletes them). Copy
   `supabase/node-tests/.env.live.example` to `supabase/node-tests/.env.live` and set:
   ```
   SUPABASE_URL=https://<STAGING_REF>.supabase.co
   SUPABASE_ANON_KEY=<STAGING_ANON_KEY>
   SUPABASE_SERVICE_ROLE_KEY=<STAGING_SERVICE_ROLE_KEY>
   LIVE_ALLOW_REMOTE=1
   PUSH_WEBHOOK_SECRET=<STAGING_PUSH_WEBHOOK_SECRET>
   CRON_SECRET=<STAGING_CRON_SECRET>
   LIVE_RUN_FX=0
   LIVE_ALLOWED_ORIGIN=https://uat-travel-bill-splitting-web-app.<SUBDOMAIN>.workers.dev
   LIVE_EMAIL_DOMAIN=example.com
   LIVE_JOIN_MAX_FAILURES=10
   ```
   ```bash
   cd supabase/node-tests
   ```
   ```bash
   npm run test:live
   ```
   Run it at most about twice per 15 minutes: each run triggers the join rate limit on purpose.
   `LIVE_ALLOW_REMOTE=1` is for staging only, **never** production.
2. **Click through the `uat` preview**, ideally on a phone and with a second browser profile:
   - [ ] The app loads, and not the "setup required" screen (that means missing build variables).
   - [ ] Sign in with an email code; the first login asks for a display name.
   - [ ] Google sign-in, if configured.
   - [ ] Create a trip with dates and a location per day.
   - [ ] In the other profile, open the invite link (and try the code) and join. Refreshing
         `/join/<token>` must not give a 404.
   - [ ] Add an expense in one profile; it appears **live** in the other.
   - [ ] A foreign-currency expense gets a rate (not "rate pending").
   - [ ] Attach a photo; it shows up for the other member.
   - [ ] Enable push (Android, desktop Chrome, or iPhone with the app on the Home Screen). A new
         expense from the other profile arrives as a push, and tapping it opens that day.
   - [ ] DevTools → Console shows no CORS errors.

---

## 7. Production

Repeat **section 4** with `<REF>` = `PROD_REF` and the file `supabase/functions/.env.production`,
generating **new** secrets and VAPID keys. Never copy staging's. The differences:

| Step | Production value |
|---|---|
| 4.1 Project | name `travel-bill-split`, same region as staging, new password |
| 4.2 Link | `$env:SUPABASE_DB_PASSWORD = "<PROD_DB_PASSWORD>"`, then `npx supabase link --project-ref <PROD_REF>`; **check** `supabase/.temp/project-ref` |
| 4.4 Secrets | new `PROD_CRON_SECRET`, `PROD_PUSH_WEBHOOK_SECRET`, VAPID pair |
| 4.5 `ALLOWED_ORIGINS` | `https://travel-bill-splitting-web-app.<SUBDOMAIN>.workers.dev,https://<CUSTOM_DOMAIN>` (exact origins only, no wildcards, no localhost) |
| 4.6 Vault | `project_url` = `https://<PROD_REF>.supabase.co`, and production's secrets and `service_role` key |
| 4.8 Site URL | `https://<CUSTOM_DOMAIN>`, or the workers.dev URL |
| 4.8 Redirect URLs | `https://travel-bill-splitting-web-app.<SUBDOMAIN>.workers.dev/**`, `https://<CUSTOM_DOMAIN>/**` |
| 4.8 SMTP + template | **required** |
| 4.9 Google | add `https://<PROD_REF>.supabase.co/auth/v1/callback` and the production origins |
| 4.11 Checks | `npx supabase test db --linked` and the 401 smoke test are safe. **Never** run `npm run test:live` on production |

### 7.1 Go live

1. Backend: finish section 4 on production, as described above.
2. Cloudflare: fill in the three `PROD_VITE_*` build variables (5.2).
3. Tag the release. The first one is `v1.0.0`:
   ```bash
   git tag -a v1.0.0 -m "v1.0.0: first production release"
   ```
   ```bash
   git push origin v1.0.0
   ```
4. Frontend: merge `uat` into `main`, preferably with a GitHub pull request `uat` → `main`.
   Cloudflare builds with the `PROD_*` values and deploys in 1–3 minutes. Check **Deployments**,
   and the build log line `branch "main" -> production (PROD_VITE_*)`.
5. Run the checklist in section 8 on the production URL.
6. Link the CLI back to staging for daily work, and clear the password from the terminal:
   ```bash
   npx supabase link --project-ref <STAGING_REF>
   ```
   PowerShell: `Remove-Item Env:SUPABASE_DB_PASSWORD`. Bash: `unset SUPABASE_DB_PASSWORD`.

---

## 8. Final checklist

Production, after go-live:

- [ ] Site loads on the production URL (and custom domain); no "setup required" screen.
- [ ] Sign-in email arrives within a minute, from your own sender, showing a 6-digit code.
- [ ] Create a trip, invite a second account, and join by link and by code.
- [ ] Live updates between the two accounts.
- [ ] `select rate_date, count(*) from fx_rates group by 1 order by 1 desc;` shows today's rates.
- [ ] **Integrations → Cron → job history**: `fetch-fx-rates` succeeds the next night.
- [ ] Push notification arrives on a phone, and tapping it opens the expense's day.
- [ ] "Add to Home Screen" / install works on iPhone and Android.
- [ ] **Edge Functions → Logs** and **Logs → Postgres** show no new errors.
- [ ] Secrets files `.env.staging` and `.env.production` are **not** in git (`git status` shows
      nothing under `supabase/functions/`).

---

## 9. After go-live

Day to day:
- **Frontend-only change:** push to `uat` (the preview uses staging), test, then merge to `main`.
- **Backend change** (new migration or function): staging first, then production, **then** merge the
  frontend. The full checklist, versioning, backups and rollback are in
  [supabase/RELEASE.md](supabase/RELEASE.md).

| To ship | Command (per environment) |
|---|---|
| New migration | `npx supabase db push --project-ref <REF> --dry-run`, then without `--dry-run` |
| Edge Function change | `npx supabase functions deploy --use-api --project-ref <REF>` |
| Secret change | `npx supabase secrets set --project-ref <REF> --env-file supabase/functions/.env.<env>`, then redeploy the functions |
| Build variable change | Cloudflare → **Retry build** |
| Frontend rollback | Cloudflare Worker → **Deployments** → last good version → **Rollback** |

**Never** edit a migration that has been pushed anywhere. Add a new one with
`npx supabase migration new <name>`.

---

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| App shows "setup required" | Build had empty `VITE_*` values. Check the `[build-cloudflare] branch … ->` log line and that environment's build variables, then retry the build |
| Build log: `missing build variables: …` | Add them under **Settings → Build → Variables and secrets**, then retry |
| Build: `wrangler.jsonc` / `package.json` not found | Root directory must be `web` |
| Build: Worker name mismatch | Dashboard name must equal `"name"` in `web/wrangler.jsonc` |
| Preview has no URL | **Settings → Domains & Routes** → enable **Preview URLs** |
| `/join/<token>` gives 404 on refresh | `wrangler.jsonc` must keep `"not_found_handling": "single-page-application"` |
| A preview shows production data | `STAGING_*` build variables hold production values |
| `db push`: permission denied for `pg_cron` / `pg_net` | Enable them under **Database → Extensions**, then push again |
| A command hit the wrong project | Always pass `--project-ref`; check `supabase/.temp/project-ref` before `--linked` commands |
| CORS error calling `join_trip` | The exact origin (scheme + host, no trailing `/`) is missing from `ALLOWED_ORIGINS`. Fix it, run `secrets set`, then `functions deploy` |
| Sign-in email never arrives | Built-in SMTP limits. Set up custom SMTP (4.8) and check **Authentication → Rate Limits** |
| Email has a link, not a code | Template not applied. Paste `otp_code.html` into both templates (needs custom SMTP) |
| Google sign-in: `redirect_uri_mismatch` | Add `https://<REF>.supabase.co/auth/v1/callback` in Google Cloud |
| Google sign-in lands on the wrong site | That site's origin with `/**` is missing from **Redirect URLs** |
| `fx_rate_missing` when saving an expense | No rates for that date. Run 4.10, check `FX_API_KEY`, and check cron history: `select * from cron.job_run_details order by start_time desc limit 5;` and `select * from net._http_response order by created desc limit 5;` |
| Push never arrives | Check Vault `project_url` / `push_webhook_secret` (must equal `PUSH_WEBHOOK_SECRET`), the VAPID secrets, the matching `*_VITE_VAPID_PUBLIC_KEY` build variable, and **Edge Functions → send_push → Logs** |
| Push works on Android but not iPhone | iOS 16.4+ **and** the app added to the Home Screen and opened from there |
| Tapping a push opens the wrong page | `send_push` isn't redeployed with the latest code: run `functions deploy` |
| Photos remain after a trip is deleted | Vault `service_role_key` is missing or outdated |
| Staging stopped responding | Free project paused after a week idle: Dashboard → **Restore** |
| `test db`: can't connect to Docker | Start Docker Desktop and wait for **Engine running** |

More backend cases: [supabase/DEPLOY.md §I](supabase/DEPLOY.md#i-troubleshooting). More frontend
cases: [web/DEPLOY.md §12](web/DEPLOY.md#12-troubleshooting).

---

## Appendix A: every setting and where it lives

| Setting | Lives in | Secret? | Must match |
|---|---|---|---|
| Database schema | `supabase/migrations/*.sql` → `db push` | no | same files on staging and production |
| `SUPABASE_DB_PASSWORD` | your terminal only | 🔒 | the project's database password |
| `VITE_SUPABASE_URL` | Cloudflare build variables (`PROD_` / `STAGING_`), `web/.env.local` | no | the project URL |
| `VITE_SUPABASE_ANON_KEY` | same as above | no (public) | that project's `anon` key |
| `VITE_VAPID_PUBLIC_KEY` | same as above | no (public) | that environment's `VAPID_PUBLIC_KEY` |
| `ALLOWED_ORIGINS` | function secrets | no | the frontend URLs |
| `FX_PROVIDER`, `FX_API_BASE`, `FX_API_KEY` | function secrets | key 🔒 | your FX vendor |
| `CRON_SECRET` | function secrets **and** Vault `cron_secret` | 🔒 | each other |
| `PUSH_WEBHOOK_SECRET` | function secrets **and** Vault `push_webhook_secret` | 🔒 | each other |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | function secrets | private 🔒 | the pair used in the build variables |
| `JOIN_RATE_LIMIT_*` | function secrets | no | `LIVE_JOIN_MAX_FAILURES` in `.env.live` |
| `project_url` | Vault | no | `https://<REF>.supabase.co` |
| `service_role_key` | Vault | 🔒 | that project's `service_role` key |
| Site URL, Redirect URLs | Dashboard → Auth → URL Configuration | no | the frontend URLs |
| SMTP credentials | Dashboard → Auth → SMTP Settings | 🔒 | your email provider |
| Google client ID and secret | Dashboard → Auth → Providers → Google | secret 🔒 | Google Cloud OAuth client |
| Email template | Dashboard → Auth → Email Templates | no | `supabase/templates/otp_code.html` |

Git-ignored files that hold real values: `supabase/functions/.env`, `.env.staging`,
`.env.production`, `supabase/node-tests/.env.live`, `web/.env.local`.

---

## Appendix B: local stack (optional)

Runs Supabase in Docker on your PC, with the same migrations, so you can try changes before
staging. It needs Docker Desktop showing **Engine running**.

```bash
npx supabase start
```
The first run downloads several GB. The migrations and `supabase/seed.sql` are applied
automatically. Then:

1. **Studio** http://127.0.0.1:54323 · **Mailpit** (sign-in codes) http://127.0.0.1:54324.
2. Edge Functions: copy `supabase/functions/.env.example` to `supabase/functions/.env`, put any
   random text in `CRON_SECRET` and `PUSH_WEBHOOK_SECRET`, then in a second terminal:
   ```bash
   npx supabase functions serve
   ```
3. Frontend: in `web/.env.local`, set `VITE_SUPABASE_URL=http://127.0.0.1:54321` and
   `VITE_SUPABASE_ANON_KEY` to the `ANON_KEY` from `npx supabase status -o env`. Then, in `web/`:
   ```bash
   npm run dev
   ```
   Open http://localhost:5173.
4. Tests: `npx supabase test db` (pgTAP); `npm run test:live` in `supabase/node-tests` with
   `.env.live` pointing at `http://127.0.0.1:54321`.
5. `npx supabase db reset` wipes and re-applies everything. `npx supabase stop` stops the stack.

The local stack uses well-known default keys. Stop it on public Wi-Fi.
