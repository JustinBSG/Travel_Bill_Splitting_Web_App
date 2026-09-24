# Deploy the frontend to Cloudflare (Workers)

The PWA in `web/` is a static Vite build (`web/dist`), served by **Cloudflare Workers static
assets** and connected to GitHub with **Workers Builds**. New Cloudflare accounts no longer get the
separate "Pages" product, so this guide uses Workers. If your account still has Pages, see
[the appendix](#appendix-accounts-that-still-have-pages).

Set up the backend first ([supabase/DEPLOY.md](../supabase/DEPLOY.md)): you need the staging and
production project URLs, anon keys and VAPID public keys.

What's in the repo for this:

| File | Purpose |
|---|---|
| `web/wrangler.jsonc` | Worker name `travel-bill-split`; serves `./dist`; SPA fallback, so `/join/<token>` and `/trips/...` load `index.html` |
| `web/scripts/build-cloudflare.mjs` (`npm run build:cloudflare`) | picks `PROD_VITE_*` on the production branch and `STAGING_VITE_*` on other branches, then runs `npm run build` |

**Contents**
1. [How automatic deploys work](#1-how-automatic-deploys-work)
2. [Check the build locally](#2-check-the-build-locally)
3. [Create the Worker from GitHub](#3-create-the-worker-from-github)
4. [Build variables](#4-build-variables)
5. [Branch settings](#5-branch-settings)
6. [Find your URLs](#6-find-your-urls)
7. [Custom domain (optional)](#7-custom-domain-optional)
8. [Connect it to the backend](#8-connect-it-to-the-backend)
9. [Verify](#9-verify)
10. [Releasing changes](#10-releasing-changes)
11. [Rollback](#11-rollback)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. How automatic deploys work

| You push to… | Cloudflare… | URL | Uses backend |
|---|---|---|---|
| the **production branch** (`main`) | builds with `PROD_*` values and **deploys**, replacing the live site | `https://travel-bill-split.<subdomain>.workers.dev` (+ custom domain) | production |
| any other branch (`uat`, `frontend`, …) | builds with `STAGING_*` values and uploads a **preview version**; the live site is unchanged | a preview URL shown in the build, e.g. `https://<branch-or-id>-travel-bill-split.<subdomain>.workers.dev` | staging |

So **yes**, a push to `main` updates production automatically, usually within 1–3 minutes, and
pushes to other branches never touch production.

**Not automatic:**
- **The backend.** Migrations and Edge Functions ship with the Supabase CLI
  ([supabase/RELEASE.md](../supabase/RELEASE.md)). Release the backend **before** merging frontend
  code that needs it.
- **Build variable changes.** The `VITE_*` values are baked in at build time, so after changing a
  variable, trigger a new build (section 4).

Installed PWAs pick up a new version automatically, normally on the next launch.

## 2. Check the build locally

```bash
cd web
```
```bash
npm ci
```
```bash
npm run build
```
Optionally, serve the built site exactly as Cloudflare will, at http://localhost:8787:
```bash
npx wrangler dev
```

## 3. Create the Worker from GitHub

1. Log in at https://dash.cloudflare.com → **Workers & Pages** → **Create** (or **Create
   application**).
2. Choose **Import a repository** (or **Continue with GitHub**), authorize Cloudflare's GitHub app
   for `JustinBSG/Travel_Bill_Splitting_Web_App`, and select the repository.
3. On the configuration screen, set:

   | Field | Value |
   |---|---|
   | Project name / Worker name | `travel-bill-split`. It **must match** `"name"` in `web/wrangler.jsonc`; change both if you want another name |
   | Build command | `npm run build:cloudflare` |
   | Deploy command | `npx wrangler deploy` (the default) |
   | Non-production branch deploy / preview command | leave the default |
   | Advanced settings → **Path** / **Root directory** | `web` |
   | Builds for non-production branches | **enabled** |

   There is no "build output directory" field in Workers. The output folder comes from
   `"assets": { "directory": "./dist" }` in `web/wrangler.jsonc`.
4. Before the first deploy, add the **build variables** from section 4. If the screen has no place
   for them, deploy once, add them under **Settings → Build**, then retry the build.
5. Click **Deploy**. The first build fails with *missing build variables* if you haven't added
   them yet; that's expected, so add them and retry.

## 4. Build variables

Open the Worker → **Settings** → **Build** → **Variables and secrets** (these are *build*
variables, not the runtime "Variables" further up the page). Add:

| Name | Value |
|---|---|
| `PROD_VITE_SUPABASE_URL` | `https://<PROD_REF>.supabase.co` |
| `PROD_VITE_SUPABASE_ANON_KEY` | production **anon** key |
| `PROD_VITE_VAPID_PUBLIC_KEY` | production VAPID **public** key |
| `STAGING_VITE_SUPABASE_URL` | `https://<STAGING_REF>.supabase.co` |
| `STAGING_VITE_SUPABASE_ANON_KEY` | staging **anon** key |
| `STAGING_VITE_VAPID_PUBLIC_KEY` | staging VAPID **public** key |
| `NODE_VERSION` | `22` |
| `PRODUCTION_BRANCH` | `main`. Optional; only set it if your production branch has another name |

- All of these are public: they're shipped to every browser. **Never** add the `service_role` key,
  the VAPID *private* key, or any other secret here.
- The build log shows which set was used, e.g.
  `[build-cloudflare] branch "uat" -> staging (STAGING_VITE_*)`.
- After changing a variable, go to **Deployments** (or **Builds**) → latest build → **Retry build**,
  or push a new commit.

## 5. Branch settings

Worker → **Settings** → **Build**:
- **Branch control / Production branch:** `main`.
- **Builds for non-production branches:** enabled. Every other branch builds a preview against
  staging.
- **Build watch paths** (if shown): include `web/*`, so backend-only pushes skip the build.

## 6. Find your URLs

- **Production:** Worker → **Settings** → **Domains & Routes** shows
  `travel-bill-split.<subdomain>.workers.dev`. `<subdomain>` is your account's workers.dev
  subdomain (also shown on the Workers & Pages overview page, or under **Account settings →
  workers.dev subdomain**).
- **Previews:** each non-production build prints its preview URL in the build log and under
  **Deployments** (or **Versions**). If branch aliases are enabled, `uat` gets a stable address
  like `https://uat-travel-bill-split.<subdomain>.workers.dev`.
- If **Preview URLs** are off: **Settings → Domains & Routes** → enable **Preview URLs**.

## 7. Custom domain (optional)

The domain must be on Cloudflare DNS. Worker → **Settings** → **Domains & Routes** → **Add** →
**Custom domain**, for example `trips.yourdomain.com`. DNS and HTTPS are set up automatically.
Then add it to the backend (section 8).

## 8. Connect it to the backend

The backend only accepts browser calls and sign-in redirects from known addresses. Replace
`<subdomain>` with yours:

| Where | Staging project | Production project |
|---|---|---|
| `supabase/functions/.env.<env>`: `ALLOWED_ORIGINS` | `http://localhost:5173,https://*.<subdomain>.workers.dev` | `https://travel-bill-split.<subdomain>.workers.dev` (+ `,https://<custom-domain>`) |
| Supabase → Authentication → URL Configuration → Redirect URLs | `http://localhost:5173/**`, `https://*.<subdomain>.workers.dev/**` | `https://travel-bill-split.<subdomain>.workers.dev/**` (+ `https://<custom-domain>/**`) |
| Supabase → Authentication → URL Configuration → Site URL | `http://localhost:5173` | the custom domain, or the workers.dev URL |

On staging, `*.<subdomain>.workers.dev` also matches any other Worker on your account. That's fine
for a test project; production lists exact origins only.

Apply the new origins:
```bash
npx supabase secrets set --project-ref <REF> --env-file supabase/functions/.env.<env>
```
```bash
npx supabase functions deploy --use-api --project-ref <REF>
```

## 9. Verify

On the production URL, and on a preview URL:

- [ ] The app loads, and doesn't show the **"setup required"** screen (that means missing variables).
- [ ] Sign in with an email code works.
- [ ] Create a trip. Open the invite link in another browser profile and join. A deep link like
      `/join/<token>` loads, and refreshing it doesn't give a 404.
- [ ] An expense added in one profile appears live in the other.
- [ ] Browser DevTools → Console shows no CORS errors (otherwise see section 8).
- [ ] On a phone, "Add to Home Screen" / install works.
- [ ] Settings → push notifications can be enabled (Android, or an installed iOS 16.4+ app).

## 10. Releasing changes

**Day-to-day (staging):** push to `uat` or a feature branch. Cloudflare builds a preview against
the staging backend; open the preview URL from the build and test.

**Release to production:**
1. If the change needs backend changes, release the backend to production first
   ([supabase/RELEASE.md](../supabase/RELEASE.md), section 4).
2. Merge into `main`, preferably with a GitHub pull request `uat` → `main`, or:
   ```bash
   git switch main
   ```
   ```bash
   git pull
   ```
   ```bash
   git merge uat
   ```
   ```bash
   git push origin main
   ```
3. Cloudflare builds with the `PROD_*` values and deploys. Watch **Deployments** / **Builds** until
   it succeeds, then run the checks in section 9 on production.
4. Tag the release (`git tag -a vX.Y.Z …`) as described in RELEASE.md.

**First release:** `main` doesn't contain the app yet (the work is on `uat` / `backend`). Deploy
the backend to production, then merge `uat` into `main`.

## 11. Rollback

- Worker → **Deployments** → pick the last good version → **Rollback**. This is instant, with no
  rebuild. The next push to `main` deploys again, so fix the code too.
- To stop production deploys for a while: **Settings → Build**, then disconnect or pause the
  production branch builds (or temporarily set the production branch to an unused branch name).

## 12. Troubleshooting

| Symptom | Fix |
|---|---|
| Build log: `missing build variables: PROD_VITE_...` | Add the variables in section 4 under **Settings → Build → Variables and secrets**, then retry |
| Build log: Worker name mismatch | The dashboard Worker name must equal `"name"` in `web/wrangler.jsonc` |
| Build log: `package.json` not found / `wrangler.jsonc` not found | Root directory / Path must be `web` |
| Build fails on a Node or Vite version | Set `NODE_VERSION=22` |
| Build fails with TypeScript errors | Run `npm run build` in `web/` locally, fix, and push |
| The site shows the "setup required" screen | The build used empty values. Check the log line `[build-cloudflare] branch … -> …` and the matching variables |
| A preview talks to production data | `STAGING_*` holds production values. Fix them, then retry the build |
| `/join/<token>` gives 404 on refresh | `web/wrangler.jsonc` must keep `"not_found_handling": "single-page-application"` |
| CORS error on `join_trip` | Add the exact origin to the backend's `ALLOWED_ORIGINS` (section 8) |
| Pushed to a branch but production didn't change | Only `main` deploys to production. Merge into `main` |
| Pushed to `main` but the site looks old | Check **Builds** for a failure. Installed PWAs update on the next launch |

---

## Appendix: accounts that still have Pages

If **Workers & Pages → Create** offers a **Pages** tab with **Connect to Git**, you can use Pages
instead. There, `wrangler.jsonc` and `build:cloudflare` aren't used:

- Build settings: Root directory `web`, Build command `npm run build`, Build output directory
  `dist`, Production branch `main`.
- **Settings → Variables and Secrets**, set per environment. **Production:** `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`, `VITE_VAPID_PUBLIC_KEY` with production values, and `NODE_VERSION=22`.
  **Preview:** the same names with staging values.
- URLs are `https://<project>.pages.dev` (production) and `https://<branch>.<project>.pages.dev`
  (previews). Use `https://*.<project>.pages.dev` in the staging `ALLOWED_ORIGINS` and Redirect URLs.
- Rollback: Deployments → last good production deployment → **Rollback to this deployment**.
