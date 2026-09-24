# Deploy the frontend to Cloudflare Pages

The PWA in `web/` is a static Vite build (`web/dist`), hosted on Cloudflare Pages and connected to
GitHub. Set up the backend first ([supabase/DEPLOY.md](../supabase/DEPLOY.md)): you need the
staging and production project URLs, anon keys and VAPID public keys.

**Contents**
1. [How automatic deploys work](#1-how-automatic-deploys-work)
2. [Check the build locally](#2-check-the-build-locally)
3. [Create the Pages project](#3-create-the-pages-project)
4. [Environment variables](#4-environment-variables)
5. [Branch settings: production vs preview](#5-branch-settings-production-vs-preview)
6. [Custom domain (optional)](#6-custom-domain-optional)
7. [Connect it to the backend](#7-connect-it-to-the-backend)
8. [Verify](#8-verify)
9. [Releasing changes](#9-releasing-changes)
10. [Rollback and pausing deploys](#10-rollback-and-pausing-deploys)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. How automatic deploys work

| You push to… | Cloudflare builds… | URL | Uses backend |
|---|---|---|---|
| the **production branch** (`main`) | a **production** deployment, which replaces the live site | `https://<PAGES_PROJECT>.pages.dev` (+ custom domain) | production |
| any other branch (`uat`, `frontend`, `backend`, …) | a **preview** deployment; live users see nothing | `https://<branch>.<PAGES_PROJECT>.pages.dev` and `https://<hash>.<PAGES_PROJECT>.pages.dev` | staging |

So **yes**, pushing to `main` updates production automatically, usually within 1–3 minutes.
Pushing to other branches never touches production. That makes `uat` a natural staging branch
for the frontend: its preview URL, `https://uat.<PAGES_PROJECT>.pages.dev`, talks to the staging
backend.

**Two things are *not* automatic:**
- **The backend.** Database migrations and Edge Functions are shipped with the Supabase CLI
  ([supabase/RELEASE.md](../supabase/RELEASE.md)). Release the backend **before** merging
  frontend code that needs it.
- **Environment variable changes.** `VITE_*` values are baked into the build. After changing
  them, redeploy (section 4).

Installed PWAs pick up a new version automatically (`registerType: 'autoUpdate'`), normally on the
next launch after the service worker has downloaded it.

## 2. Check the build locally

Cloudflare runs the same command, so if this fails locally it fails there too:

```bash
cd web
```
```bash
npm ci
```
```bash
npm run build
```
```bash
npm run preview
```

`npm run build` runs `tsc -b && vite build` into `web/dist`. `npm run preview` serves it at
http://localhost:4173.

## 3. Create the Pages project

1. Log in at https://dash.cloudflare.com → **Workers & Pages** → **Create** → choose the **Pages**
   tab → **Connect to Git** (Import an existing Git repository).
   Choose *Pages*, not *Workers*: the Workers flow gives you a `workers.dev` site with different
   settings.
2. Authorize Cloudflare's GitHub app (access to `JustinBSG/Travel_Bill_Splitting_Web_App` is
   enough), select the repository, then **Begin setup**.
3. **Set up builds and deployments:**

   | Field | Value |
   |---|---|
   | Project name | e.g. `travel-bill-split`. This becomes `<PAGES_PROJECT>.pages.dev`; if the name is taken, Cloudflare adds a suffix |
   | Production branch | `main` |
   | Framework preset | `Vite` (or `None`) |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Root directory (advanced) | `web` |

4. Under **Environment variables (advanced)**, add the **production** values from section 4. You
   add the preview values after the first deploy.
5. Click **Save and Deploy**. The first build takes 1–3 minutes, then shows your URL, for example
   `https://travel-bill-split.pages.dev`. Write down the real subdomain: that's `<PAGES_PROJECT>`.

Don't add a `404.html` to `web/public`. Without it, Pages serves `index.html` for unknown paths,
which the app's client-side routes (`/join/<token>`, `/trips/<id>/…`) rely on.

## 4. Environment variables

In the project, open **Settings → Variables and Secrets** (older layout: *Settings → Environment
variables*). Set each variable for **Production** and **Preview** separately:

| Variable | Production | Preview |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://<PROD_REF>.supabase.co` | `https://<STAGING_REF>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | production **anon** key | staging **anon** key |
| `VITE_VAPID_PUBLIC_KEY` | production VAPID **public** key | staging VAPID **public** key |
| `NODE_VERSION` | `22` | `22` |

- These values are public: they're shipped to every browser. **Never** add the `service_role`
  key, the VAPID *private* key, or any other secret here.
- `NODE_VERSION` pins the build to Node 22, which Vite 8 needs.
- After changing a variable, go to **Deployments**, open the latest deployment of that environment,
  and choose **⋯ → Retry deployment**. Or push a new commit. Running deployments keep their old
  values until rebuilt.

## 5. Branch settings: production vs preview

**Settings → Builds** (older layout: *Builds & deployments*):

- **Branch control**
  - Production branch: `main`, with automatic deployments **enabled**.
  - Preview branches: **All non-Production branches**, or *Custom* with just `uat` if you don't
    want every branch built.
- **Build watch paths** (optional): *Include* `web/*`. Pushes that only touch `supabase/` or
  `docs/` then skip the frontend build.

## 6. Custom domain (optional)

**Custom domains → Set up a custom domain**, then enter for example `trips.yourdomain.com` and
follow the DNS steps. It's automatic if the domain's DNS is on Cloudflare; otherwise add the CNAME
it shows. HTTPS is issued automatically.

After adding a domain, also do the steps in section 7 for it.

## 7. Connect it to the backend

The backend only accepts browser calls and sign-in redirects from known addresses:

| Where | Staging project | Production project |
|---|---|---|
| `supabase/functions/.env.<env>`: `ALLOWED_ORIGINS` | `http://localhost:5173,https://*.<PAGES_PROJECT>.pages.dev` | `https://<PAGES_PROJECT>.pages.dev` (+ `,https://<custom-domain>`) |
| Supabase Dashboard → Authentication → URL Configuration → Redirect URLs | `http://localhost:5173/**`, `https://*.<PAGES_PROJECT>.pages.dev/**` | `https://<PAGES_PROJECT>.pages.dev/**` (+ `https://<custom-domain>/**`) |
| Supabase Dashboard → Authentication → URL Configuration → Site URL | `http://localhost:5173` | the custom domain, or the pages.dev URL |

After editing `ALLOWED_ORIGINS`, apply it:
```bash
npx supabase secrets set --project-ref <REF> --env-file supabase/functions/.env.<env>
```
```bash
npx supabase functions deploy --use-api --project-ref <REF>
```

## 8. Verify

On the production URL, and on `https://uat.<PAGES_PROJECT>.pages.dev` for preview:

- [ ] The app loads, and doesn't show the **"setup required"** screen. That screen means the
      `VITE_*` variables are missing for that environment.
- [ ] Sign in with an email code works, and the code arrives by email.
- [ ] Create a trip. Open the invite link in another browser profile and join. A deep link like
      `/join/<token>` loads instead of a 404.
- [ ] Add an expense; it appears live in the other profile.
- [ ] Browser DevTools → Console shows no CORS errors when joining (otherwise see section 7).
- [ ] On a phone: "Add to Home Screen" / install works, and it opens full-screen.
- [ ] Settings → push notifications can be enabled (Android, or an installed iOS 16.4+ app).

## 9. Releasing changes

**Day-to-day (preview / staging):**
1. Work on a branch, e.g. `uat` (or a feature branch).
2. Push it. Cloudflare builds a preview against the **staging** backend.
3. Test on `https://uat.<PAGES_PROJECT>.pages.dev` (or the hash URL shown in **Deployments**).

**Release to production:**
1. If the change needs backend changes, release the backend to production first
   ([supabase/RELEASE.md](../supabase/RELEASE.md), section 4).
2. Merge into `main`: either a pull request on GitHub (`uat` → `main`, which is recommended
   because you can review the diff), or on the command line:
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
3. Cloudflare builds and publishes production automatically. Watch **Deployments** until it shows
   **Success**, then run the checks in section 8 on the production URL.
4. Tag the release (`git tag -a vX.Y.Z …`) as described in RELEASE.md.

**First release to production:** `main` doesn't contain the app yet. Your work is on `uat` and
`backend`. Deploy the backend to production first, then merge `uat` into `main` as above. Until
then, the production URL only has what's on `main`.

## 10. Rollback and pausing deploys

- **Rollback:** **Deployments** → find the last good *Production* deployment → **⋯ → Rollback to
  this deployment**. It's instant, with no rebuild. Fix the code afterwards, since the next push to
  `main` deploys again.
- **Pause production deploys** (for example while the backend release is in progress): **Settings →
  Builds → Branch control**, then turn off automatic production deployments. Turn it back on when
  ready, or deploy a specific commit by hand from **Deployments**.

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| Build fails on a Node / Vite version error | Set `NODE_VERSION=22` for both environments and retry |
| Build fails with TypeScript errors | Run `npm run build` in `web/` locally, fix, and push |
| Build log says it can't find `package.json` | Root directory must be `web` (Settings → Builds) |
| Site shows the "setup required" screen | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are missing for that environment. Add them, then retry the deployment |
| `/join/<token>` or `/trips/...` gives 404 on refresh | A `404.html` ended up in the output. Remove it from `web/public` |
| Browser console: CORS error on `join_trip` | Add the exact site origin to the backend's `ALLOWED_ORIGINS` (section 7) |
| Google/Apple sign-in returns to the wrong site or errors | Add the site to Supabase Auth → Redirect URLs (section 7) |
| Pushed to a branch but production didn't change | Only the production branch (`main`) deploys to production. Merge into `main` |
| Pushed to `main` but the site looks old | Check **Deployments** for a failed build. Installed PWAs update on the next launch; close and reopen the app |
| Preview works but talks to production data | The Preview variables point at the production project. Set them to staging |
