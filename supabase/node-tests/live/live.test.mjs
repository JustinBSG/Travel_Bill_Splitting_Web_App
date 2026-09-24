// Live end-to-end tests against a running Supabase: the local stack
// (`supabase start` + `functions serve`) or a STAGING project. Everything goes
// through the public HTTP surface the PWA uses (PostgREST, RPCs, Edge
// Functions, Storage, Realtime) with real Auth sessions, covering the parts
// of the acceptance bar (requirement §10) the offline suite can't:
//   * Realtime delivers an expense INSERT to a second signed-in member
//   * photos are unreachable without a signed URL
//   * invite_code is absent from a member's GET /trips
//   * join / claim / regenerate through the Edge Functions
// It creates throwaway users (e2e-<run>-*@example.com) and one trip, and
// deletes them at the end. Run: npm run test:live (see supabase/DEPLOY.md).
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { admin, anonClient, callFunction, cfg, hkDate, newUser, runId, skipReason } from './support.mjs'

describe('live backend', { skip: skipReason }, () => {
  const U = {} // users: { id, email, client, token }
  const M = {} // trip_members ids
  let trip // create_trip result
  let expenseId
  let photoPath
  let oldCode

  const rpc = async (user, fn, args) => {
    const res = await user.client.rpc(fn, args)
    return { data: res.data, error: res.error, status: res.status }
  }
  const expenseBody = (extra) => ({
    id: null,
    trip_id: trip.id,
    title: 'E2E expense',
    category: 'Food & Drink',
    amount: '1000',
    currency: 'HKD',
    paid_by: M.alice,
    split_method: 'equal',
    occurred_at: `${hkDate(30)}T19:00:00+09:00`,
    timezone: 'Asia/Seoul',
    end_date: null,
    currency_manually_set: false,
    expected_updated_at: null,
    participants: [],
    ...extra,
  })

  before(async () => {
    U.alice = await newUser('alice', 'Alice')
    U.bob = await newUser('bob', 'Bob')
    U.carol = await newUser('carol', 'Carol')
    U.eve = await newUser('eve', 'Eve') // never joins
  })

  after(async () => {
    const problems = []
    if (trip) {
      await U.alice.client.rpc('unlock_trip', { trip_id: trip.id })
      if (photoPath) await U.alice.client.storage.from('trip-photos').remove([photoPath])
      const del = await U.alice.client.rpc('delete_trip', { trip_id: trip.id })
      if (del.error) problems.push(`trip ${trip.id}: ${del.error.message}`)
    }
    for (const u of Object.values(U)) {
      await u.client.removeAllChannels()
      await u.client.realtime.disconnect()
      const res = await admin.auth.admin.deleteUser(u.id)
      if (res.error) problems.push(`user ${u.email}: ${res.error.message}`)
    }
    if (problems.length) console.warn(`live test cleanup left data behind:\n  ${problems.join('\n  ')}`)
  })

  it('signup created profiles; anon can read nothing', async () => {
    const { data } = await U.alice.client.from('profiles').select('display_name, language').single()
    assert.deepEqual(data, { display_name: 'Alice', language: 'en' })
    const others = await U.alice.client.from('profiles').select('id').eq('id', U.bob.id)
    assert.deepEqual(others.data, [])
    const anon = await anonClient().from('trips').select('id')
    assert.ok(anon.error || anon.data.length === 0, 'anon must not read trips')
  })

  it('create_trip returns the trip, days, owner and invite in one call', async () => {
    const days = [30, 31, 32].map((n) => ({
      date: hkDate(n),
      location_name: 'Seoul',
      country_code: 'KR',
      latitude: 37.5665,
      longitude: 126.978,
      timezone: 'Asia/Seoul',
      currency: 'KRW',
    }))
    const res = await rpc(U.alice, 'create_trip', { name: `E2E ${runId}`, start_date: hkDate(30), end_date: hkDate(32), days })
    assert.ifError(res.error)
    trip = res.data
    assert.equal(trip.trip_days.length, 3)
    assert.match(trip.invite.invite_code, /^[2-9A-HJ-NP-Z]{6}$/)
    M.alice = trip.trip_members[0].id
    oldCode = trip.invite.invite_code
  })

  it('join_trip: auth required, bad code 404, preview, join, idempotent', async () => {
    assert.equal((await callFunction('join_trip', { body: { code: oldCode } })).status, 401)

    const bad = await callFunction('join_trip', { token: U.bob.token, body: { code: 'ZZZZZZ' } })
    assert.equal(bad.status, 404)
    assert.equal(bad.body.error.code, 'invite_invalid')

    const preview = await callFunction('join_trip', { token: U.bob.token, body: { code: oldCode, preview: true } })
    assert.equal(preview.status, 200)
    assert.equal(preview.body.trip.id, trip.id)
    assert.equal(preview.body.already_member, false)

    const joined = await callFunction('join_trip', { token: U.bob.token, body: { code: oldCode.toLowerCase() } })
    assert.equal(joined.status, 200)
    assert.equal(joined.body.trip_id, trip.id)
    M.bob = joined.body.member_id

    const again = await callFunction('join_trip', { token: U.bob.token, body: { token: trip.invite.invite_token } })
    assert.equal(again.body.member_id, M.bob)
  })

  it('invite secrets: absent from a member’s GET /trips, get_trip_invite is admin-only', async () => {
    const rows = await U.bob.client.from('trips').select('*').eq('id', trip.id)
    assert.equal(rows.data.length, 1)
    assert.ok(!JSON.stringify(rows.data).includes(oldCode), 'invite_code leaked in GET /trips')
    assert.deepEqual((await U.bob.client.from('trip_invites').select('*')).data, [])

    const denied = await rpc(U.bob, 'get_trip_invite', { trip_id: trip.id })
    assert.equal(denied.error?.code, 'forbidden')
    assert.equal(denied.status, 403)
    const allowed = await rpc(U.alice, 'get_trip_invite', { trip_id: trip.id })
    assert.equal(allowed.data.invite_code, oldCode)

    assert.deepEqual((await U.eve.client.from('trips').select('id').eq('id', trip.id)).data, [])
  })

  it('placeholder claim keeps the same trip_members.id', async () => {
    const ph = await U.alice.client
      .from('trip_members')
      .insert({ trip_id: trip.id, display_name: 'Carol (placeholder)', role: 'member', user_id: null })
      .select()
      .single()
    assert.ifError(ph.error)

    const preview = await callFunction('join_trip', { token: U.carol.token, body: { code: oldCode, preview: true } })
    assert.deepEqual(preview.body.placeholders, [{ id: ph.data.id, display_name: 'Carol (placeholder)' }])

    const claimed = await callFunction('join_trip', {
      token: U.carol.token,
      body: { code: oldCode, claim_placeholder_id: ph.data.id },
    })
    assert.equal(claimed.status, 200)
    assert.deepEqual([claimed.body.member_id, claimed.body.claimed], [ph.data.id, true])
    M.carol = ph.data.id
  })

  it('Realtime delivers an expense INSERT to a second signed-in member', async () => {
    const channel = U.bob.client.channel(`e2e-${runId}`)
    const inserted = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no Realtime INSERT within 20 s')), 20_000)
      channel.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'expenses', filter: `trip_id=eq.${trip.id}` },
        (payload) => {
          clearTimeout(timer)
          resolve(payload.new)
        },
      )
    })
    await new Promise((resolve, reject) =>
      channel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') resolve()
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(err ?? new Error(status))
      }),
    )
    await new Promise((r) => setTimeout(r, 1500)) // let the changes subscription settle

    const saved = await rpc(
      U.alice,
      'save_expense',
      expenseBody({ title: 'Dinner', amount: '10000', participants: [M.alice, M.bob, M.carol].map((member_id) => ({ member_id })) }),
    )
    assert.ifError(saved.error)
    expenseId = saved.data.id
    const shares = saved.data.expense_participants.map((p) => p.share_amount)
    assert.equal(shares.reduce((a, b) => a + b, 0), 10000)
    assert.deepEqual([...shares].sort(), [3333, 3333, 3334])

    const row = await inserted
    assert.equal(row.id, expenseId)
    await U.bob.client.removeChannel(channel)
  })

  it('save_expense: AB check, optimistic lock round trip, personal expense', async () => {
    const mismatch = await rpc(
      U.bob,
      'save_expense',
      expenseBody({
        split_method: 'exact',
        amount: '12000',
        paid_by: M.bob,
        participants: [
          { member_id: M.bob, share_amount: '8000' },
          { member_id: M.alice, share_amount: '3000' },
        ],
      }),
    )
    assert.equal(mismatch.error?.code, 'share_sum_mismatch')
    assert.equal(mismatch.status, 422)

    // updated_at exactly as PostgREST returns it is the optimistic-lock token
    const { data: current } = await U.bob.client.from('expenses').select('updated_at').eq('id', expenseId).single()
    const stale = await rpc(U.bob, 'save_expense', expenseBody({ id: expenseId, expected_updated_at: '2000-01-01T00:00:00Z', participants: [{ member_id: M.bob }] }))
    assert.equal(stale.error?.code, 'conflict_updated_at')
    assert.equal(stale.status, 409)
    const edited = await rpc(
      U.bob,
      'save_expense',
      expenseBody({
        id: expenseId,
        title: 'Dinner (edited)',
        amount: '10000',
        expected_updated_at: current.updated_at,
        participants: [M.alice, M.bob, M.carol].map((member_id) => ({ member_id })),
      }),
    )
    assert.ifError(edited.error)
    assert.equal(edited.data.title, 'Dinner (edited)')

    const personal = await rpc(U.carol, 'save_expense', expenseBody({ title: 'Souvenir', paid_by: M.carol }))
    assert.ifError(personal.error)
    assert.deepEqual(personal.data.expense_participants, [])

    const direct = await U.bob.client.from('expenses').update({ title: 'hack' }).eq('id', expenseId)
    assert.ok(direct.error, 'direct expense writes must be refused')
  })

  it('a foreign-currency expense locks a rate (skipped when no FX rates are loaded yet)', async (t) => {
    const res = await rpc(U.alice, 'save_expense', expenseBody({ title: 'Taxi', amount: '5000', currency: 'KRW', participants: [{ member_id: M.bob }] }))
    if (res.error?.code === 'fx_rate_missing') return t.skip('no KRW rate stored: run fetch_fx_rates (or db reset locally) first')
    assert.ifError(res.error)
    const expected = Math.round(5000 * Number(res.data.fx_rate_to_hkd) * 100)
    assert.ok(Math.abs(res.data.amount_hkd - expected) <= 1, 'amount_hkd = amount × locked rate, in HKD cents')
    assert.ok(res.data.fx_rate_date <= hkDate(0))
  })

  it('settlements: an idempotency_key replay never double-pays', async () => {
    const body = {
      trip_id: trip.id,
      from_member: M.bob,
      to_member: M.alice,
      debt_currency: 'HKD',
      debt_amount: '3333',
      paid_currency: 'HKD',
      paid_amount: '3333',
      idempotency_key: `e2e-${runId}-settle`,
    }
    const first = await rpc(U.bob, 'record_settlement', body)
    assert.ifError(first.error)
    const replay = await rpc(U.bob, 'record_settlement', body)
    assert.deepEqual([replay.data.id, replay.data.idempotent_replay], [first.data.id, true])

    const { idempotency_key, ...row } = body
    const dup = await U.bob.client.from('settlements').insert({ ...row, idempotency_key, paid_at: new Date().toISOString() })
    assert.equal(dup.error?.code, '23505')
    const count = await U.alice.client.from('settlements').select('id', { count: 'exact', head: true }).eq('trip_id', trip.id)
    assert.equal(count.count, 1)
  })

  it('photos: private bucket, signed URLs only, members only', async () => {
    photoPath = `${trip.id}/${expenseId}/${crypto.randomUUID()}.jpg`
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9])
    const up = await U.bob.client.storage
      .from('trip-photos')
      .upload(photoPath, new Blob([bytes], { type: 'image/jpeg' }), { contentType: 'image/jpeg', upsert: false })
    assert.ifError(up.error)

    const publicUrl = U.bob.client.storage.from('trip-photos').getPublicUrl(photoPath).data.publicUrl
    assert.notEqual((await fetch(publicUrl)).status, 200, 'public URL must not serve the photo')
    const noUser = await fetch(`${cfg.url}/storage/v1/object/authenticated/trip-photos/${photoPath}`, {
      headers: { apikey: cfg.anonKey },
    })
    assert.notEqual(noUser.status, 200, 'object must not be served without a user session')

    const signed = await U.alice.client.storage.from('trip-photos').createSignedUrl(photoPath, 60)
    assert.ifError(signed.error)
    const got = await fetch(signed.data.signedUrl)
    assert.equal(got.status, 200)
    assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes)

    const outsider = await U.eve.client.storage.from('trip-photos').createSignedUrl(photoPath, 60)
    assert.ok(outsider.error, 'a non-member must not be able to sign the photo')
  })

  it('locked trip rejects member writes; admin unlock works', async () => {
    assert.ifError((await rpc(U.alice, 'lock_trip', { trip_id: trip.id })).error)

    const blocked = await rpc(U.bob, 'save_expense', expenseBody({ paid_by: M.bob }))
    assert.equal(blocked.error?.code, 'trip_locked')
    assert.equal(blocked.status, 423)
    const regen = await callFunction('regenerate_invite', { token: U.alice.token, body: { trip_id: trip.id } })
    assert.equal(regen.status, 423)
    assert.equal(regen.body.error.code, 'trip_locked')

    assert.ifError((await rpc(U.alice, 'unlock_trip', { trip_id: trip.id })).error)
  })

  it('regenerate_invite: admin only; the old code dies immediately', async () => {
    const denied = await callFunction('regenerate_invite', { token: U.bob.token, body: { trip_id: trip.id } })
    assert.equal(denied.status, 403)

    const fresh = await callFunction('regenerate_invite', { token: U.alice.token, body: { trip_id: trip.id } })
    assert.equal(fresh.status, 200)
    assert.notEqual(fresh.body.invite_code, oldCode)

    const byOld = await callFunction('join_trip', { token: U.eve.token, body: { code: oldCode, preview: true } })
    assert.equal(byOld.status, 404)
    const byNew = await callFunction('join_trip', { token: U.eve.token, body: { code: fresh.body.invite_code, preview: true } })
    assert.equal(byNew.status, 200)
  })

  it('activity log and notifications recorded the changes', async () => {
    const { data: log } = await U.alice.client
      .from('activity_log')
      .select('entity_type, action')
      .eq('trip_id', trip.id)
      .order('created_at', { ascending: false })
    const actions = new Set(log.map((r) => `${r.entity_type}:${r.action}`))
    for (const needed of [
      'trip:create', 'trip_member:join', 'trip_member:create', 'trip_member:claim', 'expense:create',
      'expense:update', 'settlement:create', 'trip:lock', 'trip:unlock', 'trip_invite:invite_regen',
    ]) {
      assert.ok(actions.has(needed), `activity_log is missing ${needed}`)
    }

    const { data: mine } = await U.bob.client.from('notifications').select('type, payload').eq('trip_id', trip.id)
    assert.ok(mine.some((n) => n.type === 'expense_added' && n.payload.actor_name === 'Alice'))
    const { data: alices } = await U.alice.client.from('notifications').select('type').eq('trip_id', trip.id)
    assert.ok(alices.some((n) => n.type === 'settlement_received'))
  })

  it('join_trip is rate-limited after repeated bad codes', async () => {
    const mallory = await newUser('mallory', 'Mallory')
    U.mallory = mallory
    for (let i = 0; i < cfg.joinMaxFailures; i++) {
      const r = await callFunction('join_trip', { token: mallory.token, body: { code: 'ZZZZZZ' } })
      assert.equal(r.status, 404)
    }
    const blocked = await callFunction('join_trip', { token: mallory.token, body: { code: 'ZZZZZZ' } })
    assert.equal(blocked.status, 429)
    assert.equal(blocked.body.error.code, 'rate_limited')
  })

  it('machine-to-machine functions reject callers without their secret', async () => {
    assert.equal((await callFunction('send_push', { body: { record: {} } })).status, 401)
    assert.equal((await callFunction('fetch_fx_rates', { body: {} })).status, 401)
  })

  it('send_push accepts the webhook secret (no subscription -> nothing sent)', { skip: !cfg.pushSecret && 'set PUSH_WEBHOOK_SECRET' }, async () => {
    const res = await callFunction('send_push', {
      headers: { 'x-webhook-secret': cfg.pushSecret },
      body: { record: { user_id: U.eve.id, trip_id: null, type: 'trip_locked', payload: {} } },
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.sent, 0)
  })

  it('fetch_fx_rates runs with the cron secret', { skip: !(cfg.cronSecret && cfg.runFx) && 'set CRON_SECRET and LIVE_RUN_FX=1 (calls the FX vendor)' }, async () => {
    const res = await callFunction('fetch_fx_rates', { headers: { 'x-cron-secret': cfg.cronSecret }, body: {} })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.ok(res.body.provider)
  })

  it('CORS: preflight allows the app origin only', { skip: !cfg.allowedOrigin && 'set LIVE_ALLOWED_ORIGIN' }, async () => {
    const pre = (origin) =>
      callFunction('join_trip', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' },
      })
    const ok = await pre(cfg.allowedOrigin)
    assert.equal(ok.headers.get('access-control-allow-origin'), cfg.allowedOrigin)
    assert.match(ok.headers.get('access-control-allow-headers') ?? '', /x-retry-count/)
    const evil = await pre('https://evil.example')
    assert.equal(evil.headers.get('access-control-allow-origin'), null)
  })
})
