// Runs the pgTAP files in backend/tests/ (what `supabase test db` runs on a
// real Supabase database) against PGlite + the platform stubs, so they are
// exercised offline too. Each file is one transaction that rolls back.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createDb } from './harness.mjs'

const testsDir = new URL('../../tests/', import.meta.url)

for (const file of readdirSync(testsDir).filter((f) => f.endsWith('.sql')).sort()) {
  test(`pgTAP ${file}`, async () => {
    const db = await createDb({ pgtap: true })
    try {
      const results = await db.pg.exec(readFileSync(new URL(file, testsDir), 'utf8'))
      // TAP lines come back as single-column text rows (plan, ok, finish, ...)
      const lines = results
        .flatMap((r) => r.rows.flatMap((row) => Object.values(row)))
        .filter((v) => typeof v === 'string' && v !== '')
        .flatMap((v) => v.split('\n'))
      const plan = lines.find((l) => /^1\.\.\d+$/.test(l))
      assert.ok(plan, 'no plan() line')
      const ran = lines.filter((l) => /^(not )?ok \d+/.test(l))
      const problems = lines.filter((l) => l.startsWith('not ok') || l.startsWith('#'))
      assert.deepEqual(problems, [], `pgTAP reported:\n${problems.join('\n')}`)
      assert.equal(ran.length, Number(plan.slice(3)), `planned ${plan.slice(3)} tests but ran ${ran.length}`)
    } finally {
      await db.pg.close()
    }
  })
}
