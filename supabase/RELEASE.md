# Releasing updates to production

How to ship a new version of the backend (and the frontend that depends on it) once staging and
production already exist. First-time setup is in [DEPLOY.md](DEPLOY.md).

**The short version:**

```
change → offline tests → local → commit → STAGING (push, deploy, test) → tag → PRODUCTION (push, deploy, verify) → frontend
```

**Contents**
1. [What a release contains](#1-what-a-release-contains)
2. [Versioning](#2-versioning)
3. [Writing changes safely](#3-writing-changes-safely)
4. [Release checklist](#4-release-checklist)
5. [Rolling back](#5-rolling-back)
6. [Hotfixes](#6-hotfixes)
7. [Changing secrets or settings only](#7-changing-secrets-or-settings-only)

---

## 1. What a release contains

| Part | Changes when you edit | Shipped with | Reversible? |
|---|---|---|---|
| Database | `supabase/migrations/*.sql` (always a **new** file) | `npx supabase db push` | **No**: fix forward with another migration |
| Edge Functions | `supabase/functions/**` | `npx supabase functions deploy --use-api` | Yes: redeploy the previous version |
| Function secrets | `supabase/functions/.env.<env>` | `npx supabase secrets set` | Yes: set the old value |
| Dashboard settings | Auth, SMTP, URLs (not in git) | Dashboard | Yes, by hand |
| Frontend | `web/**` | Cloudflare Workers Builds (auto-deploys on push to `main`) | Yes: Cloudflare rollback |

To see what changed since the last release (here `v1.0.0`):

```bash
git diff --stat v1.0.0..HEAD -- supabase/migrations supabase/functions web
```

And to list migrations not yet applied to the linked project:

```bash
npx supabase migration list --linked
```

## 2. Versioning

Tag each production release in git with [semantic versioning](https://semver.org), so you always
know exactly what's live and can go back to it:

- **Patch** (`v1.0.1`): bug fixes; no schema or API change.
- **Minor** (`v1.1.0`): new features; additive migrations or new RPC fields; old clients keep working.
- **Major** (`v2.0.0`): breaking API or schema changes (plan them as described in section 3).

Tag *after* staging passes, and *before* deploying to production:

```bash
git tag -a v1.1.0 -m "v1.1.0: <one-line summary>"
```
```bash
git push origin v1.1.0
```

The first production deploy is `v1.0.0`. Optionally keep a `CHANGELOG.md` at the repo root with
one short section per tag.

## 3. Writing changes safely

**Migrations**
- Create a new file for every change; never edit one that has been pushed anywhere:
  ```bash
  npx supabase migration new <short_name>
  ```
- Prefer **additive** changes: new tables, new nullable columns, new RPCs, or new optional RPC
  fields. Old app versions keep working, because installed PWAs may run old code for a while.
- **Breaking** changes (renaming or dropping a column, changing an RPC's body or return shape) go
  in two releases, an approach called "expand then contract":
  1. Release N: add the new thing next to the old one, and ship the frontend that uses the new
     thing.
  2. Release N+1, once every client has updated: remove the old thing.
- Adding a `NOT NULL` column to a table with data: give it a `default`, or add it as nullable,
  backfill it, then set `not null` in a later migration.
- Keep the security model in every new object: `enable row level security` plus policies on new
  tables, explicit `grant`s, `security definer` + `set search_path = ''` on RPCs, and
  `revoke all … from public, anon` on new functions. `01_platform.test.sql` fails if a table lacks
  RLS or `anon` gains access.
- Never change `currencies.decimals` for a code that has expenses; stored amounts would change
  meaning.
- Add or extend tests for what you changed: `supabase/tests/*.test.sql` (pgTAP) and/or
  `supabase/node-tests/offline/acceptance.test.mjs`.

**Edge Functions**
- Keep request and response fields backward compatible (add fields; don't rename or remove them).
- If a function needs a new RPC or column, **push the database before deploying the function**.

**Frontend**
- Release the backend **before** merging frontend code that depends on it. Cloudflare deploys the
  production branch automatically, so an early merge would call RPCs that don't exist yet.

## 4. Release checklist

Copy this into your release notes or an issue and tick it off. Replace `vX.Y.Z` with the new tag.

### 4.1 Prepare
- [ ] The change is committed on your main branch, and `git status` is clean.
- [ ] Offline tests pass:
  ```bash
  cd supabase/node-tests && npm test
  ```
- [ ] Local stack (Docker) is fresh, and the migrations plus pgTAP pass:
  ```bash
  npx supabase db reset
  ```
  ```bash
  npx supabase test db
  ```
- [ ] Optionally, `npm run test:live` against the local stack, and a quick click-through of the app.

### 4.2 Staging
Set the staging password for this terminal. PowerShell: `$env:SUPABASE_DB_PASSWORD = "<STAGING_DB_PASSWORD>"`;
bash: `export SUPABASE_DB_PASSWORD=...`.

- [ ] Link to staging and confirm the ref:
  ```bash
  npx supabase link --project-ref <STAGING_REF>
  ```
  ```bash
  Get-Content supabase/.temp/project-ref
  ```
- [ ] Database, if there are new migrations:
  ```bash
  npx supabase db push --project-ref <STAGING_REF> --dry-run
  ```
  ```bash
  npx supabase db push --project-ref <STAGING_REF>
  ```
- [ ] Secrets, only if `.env.staging` changed:
  ```bash
  npx supabase secrets set --project-ref <STAGING_REF> --env-file supabase/functions/.env.staging
  ```
- [ ] Functions, if `supabase/functions/**` changed (safe to always run):
  ```bash
  npx supabase functions deploy --use-api --project-ref <STAGING_REF>
  ```
- [ ] Verify:
  ```bash
  npx supabase test db --linked
  ```
  ```bash
  cd supabase/node-tests && npm run test:live
  ```
  (with `.env.live` pointing at staging and `LIVE_ALLOW_REMOTE=1`)
- [ ] Frontend: open the Cloudflare **preview** build of the branch (it uses staging) and
  click through the changed features.

### 4.3 Tag
- [ ] Tag the release and push the tag:
  ```bash
  git tag -a vX.Y.Z -m "vX.Y.Z: <summary>"
  ```
  ```bash
  git push origin vX.Y.Z
  ```

### 4.4 Production
Set the production password. PowerShell: `$env:SUPABASE_DB_PASSWORD = "<PROD_DB_PASSWORD>"`.

- [ ] **Backup before risky migrations** (anything that drops, renames or rewrites data). This
  needs Docker and runs against the linked project, so link first:
  ```bash
  npx supabase link --project-ref <PROD_REF>
  ```
  ```bash
  npx supabase db dump --linked --data-only -f backup-vX.Y.Z-data.sql
  ```
  Keep the backup file **outside the repo**. Paid plans also have Dashboard backups and
  point-in-time recovery.
- [ ] Confirm the linked ref is production:
  ```bash
  Get-Content supabase/.temp/project-ref
  ```
- [ ] Database: the dry run must list exactly the migrations you tested on staging:
  ```bash
  npx supabase db push --project-ref <PROD_REF> --dry-run
  ```
  ```bash
  npx supabase db push --project-ref <PROD_REF>
  ```
- [ ] Secrets, only if `.env.production` changed:
  ```bash
  npx supabase secrets set --project-ref <PROD_REF> --env-file supabase/functions/.env.production
  ```
- [ ] Functions:
  ```bash
  npx supabase functions deploy --use-api --project-ref <PROD_REF>
  ```
- [ ] Frontend: merge or push to `main`. Wait for the Cloudflare build and deployment to
  succeed (Worker → **Deployments**).

### 4.5 Verify production
- [ ] pgTAP (rolled back, so safe):
  ```bash
  npx supabase test db --linked
  ```
- [ ] Smoke test. This must return `401`:
  ```bash
  curl.exe -i -X POST "https://<PROD_REF>.supabase.co/functions/v1/join_trip" -H "apikey: <PROD_ANON_KEY>" -H "Content-Type: application/json" -d "{\"code\":\"K7P2QX\"}"
  ```
- [ ] Open the production site, sign in, and use the changed feature once.
- [ ] Check **Edge Functions → Logs** and **Logs → Postgres** in the Dashboard for new errors over
  the next few minutes.
- [ ] Never run `npm run test:live` on production.

### 4.6 Finish
- [ ] Link back to staging for daily work:
  ```bash
  npx supabase link --project-ref <STAGING_REF>
  ```
- [ ] Clear the password from the terminal: PowerShell `Remove-Item Env:SUPABASE_DB_PASSWORD`,
  bash `unset SUPABASE_DB_PASSWORD`.
- [ ] Add a note to `CHANGELOG.md` (optional).

## 5. Rolling back

Choose by what broke. Always roll back on **staging first** if there's time.

**Edge Functions.** Redeploy the last good tag:
```bash
git switch --detach v1.0.0
```
```bash
npx supabase functions deploy --use-api --project-ref <PROD_REF>
```
```bash
git switch main
```

**Frontend.** In Cloudflare, open the Worker → **Deployments**, pick the last good version, and
click **Rollback**.

**Secrets.** Set the previous value again with `npx supabase secrets set --project-ref <PROD_REF> NAME=value`,
then redeploy the functions.

**Database.** There is no automatic "undo" for a pushed migration:
1. **Fix forward (normal):** write a new migration that reverses or repairs the change (for
   example re-create the dropped function, or add back the column), test it on staging, and
   release it as a patch.
2. **Restore data (last resort):** reload from the backup taken in 4.4, or use the paid-plan
   Dashboard backups / point-in-time recovery. Restores replace data, so anything written after
   the backup is lost.

Never edit or delete a migration file that production has already applied. The CLI tracks
applied versions by file name, and changing history makes staging and production drift apart.

## 6. Hotfixes

For an urgent production bug when main already has unreleased work:

1. Branch from the live tag:
   ```bash
   git switch -c hotfix/vX.Y.Z+1 vX.Y.Z
   ```
2. Fix it, add a test, and run `npm test`.
3. Run section 4.2 (staging) from this branch.
4. Tag it as a patch, for example `v1.1.1`, then run 4.4 and 4.5.
5. Merge the hotfix branch back into main, so the fix isn't lost in the next release:
   ```bash
   git switch main
   ```
   ```bash
   git merge hotfix/vX.Y.Z+1
   ```

If the hotfix adds a migration, create it with `npx supabase migration new` **on the hotfix
branch**. After merging, check that main's migrations still sort in the right order (by
timestamp) before the next release.

## 7. Changing secrets or settings only

No code release is needed.

- **Function secret** (for example a new FX key, or a new allowed origin): edit
  `.env.production`, run `npx supabase secrets set --project-ref <PROD_REF> --env-file supabase/functions/.env.production`,
  then `npx supabase functions deploy --use-api --project-ref <PROD_REF>` so running functions
  pick it up at once.
- **Vault secret** (`project_url`, `cron_secret`, `push_webhook_secret`, `service_role_key`):
  in the SQL Editor, run `select vault.update_secret((select id from vault.secrets where name = 'cron_secret'), '<new value>');`.
  When you rotate `CRON_SECRET` or `PUSH_WEBHOOK_SECRET`, update the Vault **and** the function
  secret together.
- **Rotating API keys** (Project Settings → API Keys): update the Cloudflare build variables
  (`PROD_VITE_SUPABASE_ANON_KEY` / `STAGING_VITE_SUPABASE_ANON_KEY`) and retry the build. After a `service_role` rotation, update
  the Vault `service_role_key`.
- **Auth settings:** change them in the Dashboard, on staging first.
