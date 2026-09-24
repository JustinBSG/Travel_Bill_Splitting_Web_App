// Test harness: a fresh PGlite database with the Supabase stubs and every
// migration applied, plus helpers to act as a signed-in user or the service
// role the way PostgREST does (SET ROLE + request.jwt.claims).
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', 'migrations')

export async function createDb() {
  const pg = new PGlite({ extensions: { pgcrypto } })
  await pg.exec(readFileSync(join(here, 'supabase_stubs.sql'), 'utf8'))
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await pg.exec(readFileSync(join(migrationsDir, file), 'utf8'))
    } catch (e) {
      e.message = `${file}: ${e.message}`
      throw e
    }
  }
  return new Db(pg)
}

export class Db {
  constructor(pg) {
    this.pg = pg
  }

  /** Run as the database owner (migrations / fixtures). */
  async admin(sql, params) {
    await this.pg.exec(`reset role; select set_config('request.jwt.claims', '', false);`)
    return (await this.pg.query(sql, params)).rows
  }

  /** Run as PostgREST would for a signed-in user. */
  async as(userId, sql, params) {
    const claims = JSON.stringify({ sub: userId, role: 'authenticated' })
    await this.pg.exec(`reset role; select set_config('request.jwt.claims', '${claims}', false); set role authenticated;`)
    try {
      return (await this.pg.query(sql, params)).rows
    } finally {
      await this.pg.exec('reset role;')
    }
  }

  /** Run as the service role (Edge Functions). */
  async service(sql, params) {
    await this.pg.exec(`reset role; select set_config('request.jwt.claims', '{"role":"service_role"}', false); set role service_role;`)
    try {
      return (await this.pg.query(sql, params)).rows
    } finally {
      await this.pg.exec('reset role;')
    }
  }

  /** POST /rest/v1/rpc/<fn> with a JSON body, for single-jsonb-param RPCs. */
  async rpc(userId, fn, body) {
    const rows = await this.as(userId, `select public.${fn}($1::jsonb) as r`, [JSON.stringify(body)])
    return rows[0].r
  }

  async createUser(email, meta = {}) {
    const [u] = await this.admin(
      'insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id',
      [email, JSON.stringify(meta)],
    )
    return u.id
  }
}

/** Parse a private.api_error (PGRST) failure into { code, status, message, details }. */
export function apiError(e) {
  if (e?.code !== 'PGRST') return null
  const body = JSON.parse(e.message)
  const detail = JSON.parse(e.detail)
  return { code: body.code, message: body.message, details: body.details, status: detail.status }
}

export async function expectApiError(promise, code, status) {
  let err
  try {
    await promise
  } catch (e) {
    err = e
  }
  if (!err) throw new Error(`expected ${code} (${status}) but the call succeeded`)
  const parsed = apiError(err)
  if (!parsed) throw new Error(`expected ${code} (${status}) but got: ${err.message}`)
  if (parsed.code !== code || parsed.status !== status) {
    throw new Error(`expected ${code} (${status}) but got ${parsed.code} (${parsed.status}): ${parsed.message}`)
  }
  return parsed
}

/** Expect a plain Postgres error (RLS, privileges, constraints). */
export async function expectPgError(promise, pattern) {
  let err
  try {
    await promise
  } catch (e) {
    err = e
  }
  if (!err) throw new Error(`expected an error matching ${pattern} but the call succeeded`)
  if (!pattern.test(err.message) && !pattern.test(err.code ?? '')) {
    throw new Error(`expected an error matching ${pattern} but got: ${err.code} ${err.message}`)
  }
  return err
}
