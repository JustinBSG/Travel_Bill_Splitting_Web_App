# Deploy the backend: local → staging → production

This is the first-time setup: from nothing to a tested staging project and a live production
project. To ship **updates** to production afterwards, see [RELEASE.md](RELEASE.md).

Run every command from the **repo root**; the CLI finds `supabase/config.toml` there. Commands use
`npx supabase …`, which downloads the CLI on first use. If you installed the CLI, plain
`supabase …` works the same. On Windows PowerShell, type `curl.exe` (plain `curl` is a different
command there) and `Copy-Item` instead of `cp`.

**Contents**
- [0. How the environments fit together](#0-how-the-environments-fit-together)
- [A. Tools](#a-tools)
- [B. Offline tests](#b-offline-tests-no-supabase-no-docker)
- [C. Local stack](#c-local-stack-supabase-on-your-pc)
- [D. Create and deploy an environment](#d-create-and-deploy-an-environment) (do it for staging first)
- [E. Test staging](#e-test-staging)
- [F. Production](#f-production-first-deploy)
- [G. Connect the frontend](#g-connect-the-frontend-cloudflare-pages)
- [H. Test suites at a glance](#h-test-suites-at-a-glance)
- [I. Troubleshooting](#i-troubleshooting)

---

## 0. How the environments fit together

| Environment | What it is | Used by | Live test suite allowed |
|---|---|---|---|
| **Local** | Supabase in Docker on your PC (`npx supabase start`) | you, while developing | yes |
| **Staging** | a separate cloud project: a disposable copy of production | you, and Cloudflare *preview* builds (non-`main` branches) | yes (`LIVE_ALLOW_REMOTE=1`) |
| **Production** | the cloud project real users use | the production site (`main` branch) | **never** |

The rules:
- Every change goes local → staging → production, with the same migrations, functions and commands.
- Staging and production each have their **own** keys and secrets. Never reuse production secrets on staging.
- Always say which project a command targets: pass `--project-ref <REF>` on deploy commands, and
  check the linked project (`Get-Content supabase/.temp/project-ref`) before any command that uses it.

### Values sheet

Keep a private notes file **outside the repo** and fill it in as you go:

```
STAGING_REF=               PROD_REF=                  (20 letters from the project URL)
STAGING_DB_PASSWORD=       PROD_DB_PASSWORD=
STAGING_ANON_KEY=          PROD_ANON_KEY=             (Project Settings → API Keys → Legacy API keys)
STAGING_SERVICE_ROLE_KEY=  PROD_SERVICE_ROLE_KEY=     (admin key: never in web/, git or chat)
SUBDOMAIN=                 CUSTOM_DOMAIN=             (SUBDOMAIN: your <sub>.workers.dev, see web/DEPLOY.md §6)
FX_API_KEY=                (Open Exchange Rates free plan works)
```

---

## A. Tools

| Need | For | How |
|---|---|---|
| Node.js 20+ | `npx supabase`, the tests | https://nodejs.org |
| Supabase CLI | everything | nothing to install: `npx supabase` runs it. Optional installs: Scoop on Windows, `brew install supabase/tap/supabase` on macOS |
| Docker Desktop | only the local stack (C) and `test db` | https://www.docker.com/products/docker-desktop |

```bash
npx supabase --version
```

**Docker on Windows:** keep Docker's disk on a drive with at least 15 GB free, and **not inside
OneDrive**. Set it under Docker Desktop → Settings → Resources → Advanced → *Disk image location*
(for example `F:\WSL\Docker`).

## B. Offline tests (no Supabase, no Docker)

```bash
cd supabase/node-tests
```
```bash
npm install
```
```bash
npm test
```

Expect `pass 34`. This covers the migrations and a full trip flow on an embedded Postgres, the
Edge Function helpers, and the pgTAP files. Run it after every change.

## C. Local stack (Supabase on your PC)

Needs Docker Desktop showing **Engine running**.

```bash
npx supabase start
```

The first run downloads several GB of images. When it finishes, the migrations and
`supabase/seed.sql` (sample FX rates) are applied, and it prints the URLs.
`npx supabase db reset` wipes the local database and re-applies everything whenever you want a
fresh start.

1. **Studio**: http://127.0.0.1:54323 (tables, storage, SQL editor). **Mailpit** (sign-in
   codes): http://127.0.0.1:54324.
2. **pgTAP inside the local database:**
   ```bash
   npx supabase test db
   ```
3. **Edge Functions.** Copy `supabase/functions/.env.example` to `supabase/functions/.env`, put
   any random text in `CRON_SECRET` and `PUSH_WEBHOOK_SECRET`, then serve the functions in a
   **second terminal** and leave it running:
   ```bash
   npx supabase functions serve
   ```
4. **Live tests.** Copy `supabase/node-tests/.env.live.example` to `.env.live` and set
   `SUPABASE_URL=http://127.0.0.1:54321`. Set the two keys from the **`ANON_KEY`** and
   **`SERVICE_ROLE_KEY`** lines (the long `eyJ…` values) printed by:
   ```bash
   npx supabase status -o env
   ```
   Then:
   ```bash
   cd supabase/node-tests && npm run test:live
   ```
5. **The app against local:** in `web/.env.local`, set `VITE_SUPABASE_URL=http://127.0.0.1:54321`
   and `VITE_SUPABASE_ANON_KEY=<ANON_KEY>`, then run `npm run dev` in `web/`.
6. **Stop** (`start` resumes in seconds):
   ```bash
   npx supabase stop
   ```

The local stack uses shared default keys and listens on your network. It's fine at home; stop it
on public Wi-Fi.

---

## D. Create and deploy an environment

Do this whole section **for staging first**, using `<REF>` = `STAGING_REF` and the file
`.env.staging`. Part F repeats it for production with the differences listed there.

### D0. One-time preparation
```bash
npx supabase login
```
```bash
git status
```
Commit anything outstanding, so the deployed code is a known version. Then create one secrets
file per environment (both are git-ignored):
```bash
cp supabase/functions/.env.example supabase/functions/.env.staging
```
```bash
cp supabase/functions/.env.example supabase/functions/.env.production
```

### D1. Create the project
In the Dashboard, click **New project**:
- Name: `travel-bill-split-staging` (production: `travel-bill-split`).
- Region: **Singapore** or **Tokyo**, the same for both projects.
- Database password: generate and save it.

When it's ready, record the ref and the `anon` / `service_role` keys in your values sheet.

Free-plan projects pause after about a week without activity. Click **Restore** in the Dashboard
if staging is paused.

### D2. Link
Set the database password for this terminal session so the CLI doesn't keep asking:

| PowerShell | Bash |
|---|---|
| `$env:SUPABASE_DB_PASSWORD = "<password>"` | `export SUPABASE_DB_PASSWORD="<password>"` |

```bash
npx supabase link --project-ref <REF>
```
```bash
Get-Content supabase/.temp/project-ref
```
(On macOS/Linux, `cat supabase/.temp/project-ref`.) It must print `<REF>`.

### D3. Push the database
Preview first; it should list the migrations in `supabase/migrations/`:
```bash
npx supabase db push --project-ref <REF> --dry-run
```
Then apply them:
```bash
npx supabase db push --project-ref <REF>
```
If it stops at `pg_cron` or `pg_net`: enable them under **Database → Extensions**, then push again.

Check it in the Dashboard: **Table Editor** shows 14 tables, **Storage** shows `trip-photos` (private),
and **Integrations → Cron** shows 3 jobs.

### D4. Generate this environment's secrets
Run this twice, saving one output as `CRON_SECRET` and the other as `PUSH_WEBHOOK_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Generate the Web Push keys (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`):
```bash
npx web-push generate-vapid-keys
```
Fill in `supabase/functions/.env.staging` (or `.env.production`):
```
ALLOWED_ORIGINS=<see the table in F>
FX_PROVIDER=openexchangerates
FX_API_BASE=https://openexchangerates.org/api
FX_API_KEY=<FX_API_KEY>
CRON_SECRET=<first random string>
PUSH_WEBHOOK_SECRET=<second random string>
VAPID_PUBLIC_KEY=<public key>
VAPID_PRIVATE_KEY=<private key>
VAPID_SUBJECT=mailto:<your email>
JOIN_RATE_LIMIT_MAX_FAILURES=10
JOIN_RATE_LIMIT_MAX_FAILURES_PER_IP=30
JOIN_RATE_LIMIT_WINDOW_MINUTES=15
```

### D5. Vault secrets
The database calls the Edge Functions itself: the daily FX fetch, push on new notifications, and
photo cleanup when a trip is deleted. It reads the URL and secrets for those calls from Vault. In
this project's **SQL Editor**, run with this environment's values:
```sql
select vault.create_secret('https://<REF>.supabase.co', 'project_url');
select vault.create_secret('<CRON_SECRET>', 'cron_secret');
select vault.create_secret('<PUSH_WEBHOOK_SECRET>', 'push_webhook_secret');
select vault.create_secret('<service_role key>', 'service_role_key');
```

To change one later, use `vault.update_secret` or **Database → Vault**. A missing secret never
breaks a write; that feature is just skipped, with a warning in the Postgres logs.

### D6. Function secrets and deploy
```bash
npx supabase secrets set --project-ref <REF> --env-file supabase/functions/.env.staging
```
```bash
npx supabase secrets list --project-ref <REF>
```
Deploy the functions. `--use-api` bundles them on Supabase's side, so Docker isn't needed:
```bash
npx supabase functions deploy --use-api --project-ref <REF>
```

**Edge Functions** in the Dashboard should list `join_trip`, `regenerate_invite`, `fetch_fx_rates`
and `send_push`. `verify_jwt` comes from `config.toml`: on for the first two, off for the last two,
which check their own secrets.

### D7. Auth settings (Dashboard)
- **Authentication → Sign In / Providers → Email:** enabled, OTP length **6**, expiry **600** seconds.
- **Authentication → Emails → Templates:** templates can only be edited **after custom SMTP is
  set up** (Emails → SMTP Settings). Then paste `supabase/templates/otp_code.html` into
  **Magic link or OTP** and **Confirm sign up**, so emails carry the 6-digit code.
  - **Production:** custom SMTP and this template are required.
  - **Staging without SMTP:** the default template is used, and the built-in sender only delivers
    to members of your Supabase organization, a few emails per hour. If the default email has a
    link instead of a code, click it **in the same browser** where you requested it. It opens the
    **Site URL** (set it to where you test: `http://localhost:5173` or the staging preview URL),
    and the app finishes signing in.
- **SMTP, Google sign-in and URL Configuration:** see the table in F.

### D8. Load exchange rates
```bash
curl.exe -X POST "https://<REF>.supabase.co/functions/v1/fetch_fx_rates" -H "x-cron-secret: <CRON_SECRET>"
```
Then check in the SQL Editor:
```sql
select rate_date, count(*) from fx_rates group by 1 order by 1 desc;
```

Optionally backfill past dates for pre-trip expenses, one call per date: add
`-H "Content-Type: application/json" -d "{\"date\":\"2026-09-01\"}"`. The response's `missing`
list shows currencies your vendor doesn't cover.

---

## E. Test staging

1. **pgTAP in the staging database** (Docker running; staging must be the linked project, D2):
   ```bash
   npx supabase test db --linked
   ```
   27 + 40 checks, all rolled back.
2. **Live end-to-end suite.** In `supabase/node-tests/.env.live`:
   ```
   SUPABASE_URL=https://<STAGING_REF>.supabase.co
   SUPABASE_ANON_KEY=<STAGING_ANON_KEY>
   SUPABASE_SERVICE_ROLE_KEY=<STAGING_SERVICE_ROLE_KEY>
   LIVE_ALLOW_REMOTE=1
   PUSH_WEBHOOK_SECRET=<staging value>
   CRON_SECRET=<staging value>
   LIVE_RUN_FX=0
   LIVE_ALLOWED_ORIGIN=https://uat-<WORKER_NAME>.<SUBDOMAIN>.workers.dev
   LIVE_EMAIL_DOMAIN=example.com
   LIVE_JOIN_MAX_FAILURES=10
   ```
   All `.env.live` settings. Write values without quotes, one per line:

   | Setting | Required? | What it does | Staging value |
   |---|---|---|---|
   | `SUPABASE_URL` | yes | API URL the suite talks to | `https://<STAGING_REF>.supabase.co` (local: `http://127.0.0.1:54321`) |
   | `SUPABASE_ANON_KEY` | yes | public key, like the app uses | staging legacy `anon` key (local: `ANON_KEY` from `npx supabase status -o env`) |
   | `SUPABASE_SERVICE_ROLE_KEY` | yes | admin key, used only to create and delete the throwaway test users | staging legacy `service_role` key |
   | `LIVE_ALLOW_REMOTE` | yes for non-local URLs | safety switch: the suite refuses any URL that isn't `localhost` / `127.0.0.1` unless this is `1` | `1`. **Never** set it for production |
   | `PUSH_WEBHOOK_SECRET` | optional | enables the check that `send_push` accepts its secret. Empty skips it | the same value as in `.env.staging` |
   | `CRON_SECRET` | optional | used with `LIVE_RUN_FX=1` to call `fetch_fx_rates` | the same value as in `.env.staging` |
   | `LIVE_RUN_FX` | optional | `1` really calls `fetch_fx_rates`, which uses one FX API request. `0` skips it | `0` |
   | `LIVE_ALLOWED_ORIGIN` | optional | enables the CORS check: this origin must be allowed, and a fake one refused. It must match your staging `ALLOWED_ORIGINS`. Empty skips it | your `uat` preview origin, no trailing `/` |
   | `LIVE_EMAIL_DOMAIN` | optional | domain for the test users `e2e-<run>-<name>@<domain>`. No email is sent to them | `example.com` |
   | `LIVE_JOIN_MAX_FAILURES` | optional | how many bad invite codes the rate-limit test tries before expecting 429. Must equal the functions' `JOIN_RATE_LIMIT_MAX_FAILURES` | `10` (the default) |

   ```bash
   cd supabase/node-tests && npm run test:live
   ```
   Keep it to about 2 runs per 15 minutes: each run makes roughly 12 failed join attempts on
   purpose, and the per-IP limit is 30. Delete leftover `e2e-…` users under Authentication → Users
   if a run is interrupted.
3. **Click through the app.** Point `web/.env.local` at staging, then check: sign-in by code,
   creating a trip, joining from a second browser profile, live updates, and a foreign-currency
   expense.

**Only move on to production when all three pass.**

---

## F. Production (first deploy)

Repeat **D1 to D8** with `<REF>` = `PROD_REF` and `supabase/functions/.env.production`, and apply
these differences:

| Setting | Staging | Production |
|---|---|---|
| Secrets (D4) | its own | **new** ones: never copy staging's |
| `ALLOWED_ORIGINS` | `http://localhost:5173,https://*-travel-bill-splitting-web-app.<SUBDOMAIN>.workers.dev` | `https://travel-bill-splitting-web-app.<SUBDOMAIN>.workers.dev,https://<CUSTOM_DOMAIN>` |
| Auth → Site URL | `http://localhost:5173` | `https://<CUSTOM_DOMAIN>` (or the workers.dev URL) |
| Auth → Redirect URLs | `http://localhost:5173/**`, `https://*-travel-bill-splitting-web-app.<SUBDOMAIN>.workers.dev/**` | `https://travel-bill-splitting-web-app.<SUBDOMAIN>.workers.dev/**`, `https://<CUSTOM_DOMAIN>/**` |
| SMTP (Authentication → Emails → SMTP Settings) | built-in is OK | **custom SMTP required** (Resend, Postmark, …). The built-in sender allows only a few emails per hour |
| Google sign-in | optional | configure it; callback `https://<PROD_REF>.supabase.co/auth/v1/callback` |
| Vault `project_url` | `https://<STAGING_REF>.supabase.co` | `https://<PROD_REF>.supabase.co` |

Then verify production:

1. pgTAP. Safe, because everything rolls back; production must be the linked project:
   ```bash
   npx supabase test db --linked
   ```
2. Smoke test. This must return **401**, since there's no user token:
   ```bash
   curl.exe -i -X POST "https://<PROD_REF>.supabase.co/functions/v1/join_trip" -H "apikey: <PROD_ANON_KEY>" -H "Content-Type: application/json" -d "{\"code\":\"K7P2QX\"}"
   ```
3. **Do not** run `npm run test:live` against production.
4. Tag this first release: see [RELEASE.md](RELEASE.md#2-versioning).
5. Afterwards, link back to staging for day-to-day work, and clear the password
   (`Remove-Item Env:SUPABASE_DB_PASSWORD`).

---

## G. Connect the frontend (Cloudflare)

Step-by-step setup, auto-deploys and frontend releases: **[web/DEPLOY.md](../web/DEPLOY.md)**.

The frontend is a Cloudflare Worker serving static files, built from GitHub. Its build variables
hold both environments: `PROD_VITE_SUPABASE_URL` / `PROD_VITE_SUPABASE_ANON_KEY` /
`PROD_VITE_VAPID_PUBLIC_KEY` (used on `main`), and the same names with `STAGING_` (used on every
other branch). Preview builds therefore talk to staging, and only production talks to production.
Your own `web/.env.local` should normally point at staging or local.

---

## H. Test suites at a glance

| Suite | Where | Runs against | Command | Needs |
|---|---|---|---|---|
| Offline | `supabase/node-tests/offline/` | embedded Postgres (PGlite) with Supabase stubs | `cd supabase/node-tests && npm test` | Node |
| pgTAP | `supabase/tests/*.test.sql` | a real database: local, or the linked project | `npx supabase test db [--linked]` | Docker |
| Live | `supabase/node-tests/live/` | the real HTTP API: local or **staging** | `cd supabase/node-tests && npm run test:live` | a running stack |

---

## I. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `scoop` is not recognized | Scoop isn't installed. You don't need it: use `npx supabase …` |
| `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified` | Docker Desktop isn't running. Start it and wait for **Engine running** (`docker info` should work) |
| `input/output error` / `read-only file system` while pulling images | Docker's disk is full or damaged. In Docker Desktop: Troubleshoot → Clean / Purge data. Then move the disk image to a drive with space, outside OneDrive (Settings → Resources → Advanced) |
| `supabase start`: `error running container: exit 139` | A container crashed. Run `npx supabase stop --no-backup`, then retry. If it repeats, start without Realtime: `npx supabase start -x realtime` |
| `db push`: permission denied for extension `pg_cron` / `pg_net` | Enable them under **Database → Extensions**, then push again |
| A command acted on the wrong project | Always pass `--project-ref`. Check `supabase/.temp/project-ref` before `test db --linked` |
| Browser: CORS error calling `join_trip` | Add the exact origin to `ALLOWED_ORIGINS`, then `secrets set` and `functions deploy` |
| `join_trip` returns 401 from the app | The request lacks a user access token; the user must be signed in |
| Saving a foreign-currency expense returns `fx_rate_missing` | No rates stored yet. Run D8, then check cron history: `select * from cron.job_run_details order by start_time desc limit 5;` and `select * from net._http_response order by created desc limit 5;` |
| Push notifications never arrive | Check the Vault `project_url` / `push_webhook_secret`, the VAPID secrets, and **Edge Functions → send_push → Logs** |
| Photos remain after a trip is deleted | The Vault secret `service_role_key` is missing |
| OTP emails don't arrive | The built-in SMTP rate limit: set up custom SMTP |
| Live suite: joins start returning 429 | The per-IP join limit. Wait 15 minutes |
| Live suite refuses to run | Set `LIVE_ALLOW_REMOTE=1` for a staging URL, never for production |
| `test db`: cannot connect to Docker | Start Docker Desktop; `test db` runs `pg_prove` in a container |
