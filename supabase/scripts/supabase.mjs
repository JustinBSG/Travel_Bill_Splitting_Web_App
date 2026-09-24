#!/usr/bin/env node
// Runs the Supabase CLI against backend/ without a folder named supabase/.
//
// The CLI always reads <workdir>/supabase/{config.toml,migrations,functions},
// while this repo keeps them directly in backend/. This script links
//     <os temp>/travel-bill-split-supabase/<hash>/supabase  ->  backend/
// (a junction on Windows, a symlink elsewhere; outside the repo so no tool
// ever walks into a link loop) and runs
//     supabase --workdir <that dir> <your arguments>
// CLI state (linked project ref etc.) lands in backend/.temp, which is
// git-ignored, so it survives the temp link being cleaned up.
//
// Examples (from the repo root):
//     node backend/scripts/supabase.mjs link --project-ref <PROJECT_REF>
//     node backend/scripts/supabase.mjs db push
//     node backend/scripts/supabase.mjs functions deploy
//     node backend/scripts/supabase.mjs secrets set --env-file backend/functions/.env
//
// Uses `supabase` from PATH, or SUPABASE_BIN (e.g. SUPABASE_BIN="npx supabase").
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workdir = join(tmpdir(), 'travel-bill-split-supabase', createHash('sha1').update(backend).digest('hex').slice(0, 12))
const link = join(workdir, 'supabase')

if (!existsSync(link)) {
  mkdirSync(workdir, { recursive: true })
  symlinkSync(backend, link, process.platform === 'win32' ? 'junction' : 'dir')
} else if (realpathSync(link) !== realpathSync(backend)) {
  console.error(`${link} exists but does not point to ${backend}; remove it and retry.`)
  process.exit(1)
}

// The CLI runs from the link's workdir, so relative paths to existing files
// (e.g. --env-file backend/functions/.env) are made absolute first.
function absolutize(arg) {
  const m = /^(--[\w-]+=)(.+)$/.exec(arg)
  const [prefix, value] = m ? [m[1], m[2]] : ['', arg]
  if (!value.startsWith('-') && /[\\/]/.test(value) && !isAbsolute(value) && existsSync(resolve(value))) {
    return prefix + resolve(value)
  }
  return arg
}

// Quote for the shell that runs the command (cmd.exe on Windows, sh elsewhere).
const quote =
  process.platform === 'win32'
    ? (s) => (/^[\w@+=:,./\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`)
    : (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
const bin = process.env.SUPABASE_BIN || 'supabase'
const args = ['--workdir', workdir, ...process.argv.slice(2).map(absolutize)]
const result = spawnSync([bin, ...args.map(quote)].join(' '), { stdio: 'inherit', shell: true })
process.exit(result.status ?? 1)
