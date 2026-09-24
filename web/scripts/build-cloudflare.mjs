// Build for Cloudflare Workers Builds (`npm run build:cloudflare`).
//
// Workers Builds has one set of build variables for every branch, so both
// environments are stored side by side with a prefix and picked here by the
// branch Cloudflare is building (WORKERS_CI_BRANCH):
//   production branch (PRODUCTION_BRANCH, default "main")  ->  PROD_VITE_*
//   any other branch (previews)                            ->  STAGING_VITE_*
// The chosen values become the VITE_* variables Vite bakes into the bundle.
// Outside Cloudflare (no WORKERS_CI_BRANCH) it is a plain `npm run build`
// using web/.env.local as usual.
import { spawnSync } from 'node:child_process'

const KEYS = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_VAPID_PUBLIC_KEY']
const REQUIRED = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']

const branch = process.env.WORKERS_CI_BRANCH
const env = { ...process.env }

if (branch) {
  const production = branch === (process.env.PRODUCTION_BRANCH || 'main')
  const prefix = production ? 'PROD_' : 'STAGING_'
  console.log(`[build-cloudflare] branch "${branch}" -> ${production ? 'production' : 'staging'} (${prefix}VITE_*)`)
  for (const key of KEYS) {
    const value = process.env[prefix + key]
    if (value) env[key] = value
    else delete env[key]
  }
  const missing = REQUIRED.filter((key) => !env[key])
  if (missing.length) {
    console.error(`[build-cloudflare] missing build variables: ${missing.map((k) => prefix + k).join(', ')}`)
    console.error('[build-cloudflare] add them under Worker -> Settings -> Build -> Variables and secrets')
    process.exit(1)
  }
}

const result = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', env, shell: true })
process.exit(result.status ?? 1)
