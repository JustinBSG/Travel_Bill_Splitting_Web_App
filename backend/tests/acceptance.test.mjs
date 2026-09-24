// Acceptance bar (docs/backend-requirement.txt §10) plus the §3 invariants,
// run against the real migrations on PGlite. Steps share one database and
// run in order, like a real trip:
//   4 people (one starts as a placeholder), 2 currencies (KRW + HKD), 4 days,
//   multi-day hotel, loan, personal souvenir, AB exact meal, date-range edit,
//   placeholder claim, HKD repayment of a KRW debt with idempotent replay,
//   lock, invite regeneration, photos, delete.
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createDb, expectApiError, expectPgError } from './harness.mjs'

let db
let today
const U = {} // user ids
const M = {} // trip_members ids
const E = {} // expense ids
let trip
let firstInviteCode

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const day = (n) => addDays(today, n)
// PGlite hands back DATE columns as JS Dates (at local midnight); PostgREST sends 'YYYY-MM-DD'
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const seoul = (date) => ({
  date,
  location_name: 'Seoul',
  country_code: 'KR',
  latitude: 37.5665,
  longitude: 126.978,
  timezone: 'Asia/Seoul',
  currency: 'KRW',
})

const join = (userId, target, extra = {}) =>
  db
    .service(
      `select public.join_trip_as(p_user_id => $1, p_code => $2, p_token => $3,
         p_claim_placeholder_id => $4, p_preview => $5, p_client_hash => $6) as r`,
      [userId, target.code ?? null, target.token ?? null, extra.claim ?? null, extra.preview ?? false, extra.client ?? 'ip-hash-1'],
    )
    .then((rows) => rows[0].r)

const expense = (userId, fields) =>
  db.rpc(userId, 'save_expense', {
    id: null,
    trip_id: trip.id,
    category: 'Food & Drink',
    currency: 'KRW',
    split_method: 'equal',
    timezone: 'Asia/Seoul',
    end_date: null,
    currency_manually_set: false,
    expected_updated_at: null,
    ...fields,
  })

const shares = (e) => Object.fromEntries(e.expense_participants.map((p) => [p.member_id, p.share_amount]))
const logActions = async () =>
  (await db.admin('select action, entity_type from public.activity_log where trip_id = $1 order by created_at', [trip.id]))
    .map((r) => `${r.entity_type}:${r.action}`)

before(async () => {
  db = await createDb()
  ;[{ d: today }] = await db.admin(`select ((now() at time zone 'Asia/Hong_Kong')::date)::text as d`)

  U.alice = await db.createUser('alice@example.com', { display_name: 'Alice', language: 'zh-Hant' })
  U.bob = await db.createUser('bob@example.com', { full_name: 'Bob' })
  U.carol = await db.createUser('carol@example.com') // no name yet
  U.dave = await db.createUser('dave@example.com', { name: 'Dave' })
  U.eve = await db.createUser('eve@example.com', { name: 'Eve' })

  // FX: today (USD-based vendor) and an older day for past-dated expenses
  await db.service(`select public.upsert_fx_rates($1::date, 'USD', $2::jsonb, 'test')`, [
    today,
    JSON.stringify({ USD: '1', HKD: '7.78', KRW: '1350', JPY: '149.5' }),
  ])
  await db.service(`select public.upsert_fx_rates($1::date, 'USD', $2::jsonb, 'test')`, [
    day(-60),
    JSON.stringify({ USD: 1, HKD: 7.8, KRW: 1400, JPY: 150 }),
  ])
})

test('signup creates profiles; profile is own-row only; blank name blocks trip creation', async () => {
  const [alice] = await db.as(U.alice, 'select * from public.profiles')
  assert.equal(alice.display_name, 'Alice')
  assert.equal(alice.language, 'zh-Hant')
  assert.equal((await db.as(U.alice, 'select * from public.profiles where id = $1', [U.bob])).length, 0)

  const [carol] = await db.as(U.carol, 'select display_name, language from public.profiles')
  assert.deepEqual(carol, { display_name: '', language: 'en' })
  await expectApiError(
    db.rpc(U.carol, 'create_trip', { name: 'x', start_date: day(1), end_date: day(1), days: [seoul(day(1))] }),
    'validation_error',
    422,
  )
  await db.as(U.carol, `update public.profiles set display_name = '  Carol  ' where id = auth.uid()`)
  assert.equal((await db.as(U.carol, 'select display_name from public.profiles'))[0].display_name, 'Carol')
  // only display_name / language are writable
  await expectPgError(db.as(U.carol, `update public.profiles set created_at = now()`), /permission denied/)
  assert.equal((await db.as(U.carol, `update public.profiles set display_name = 'x' where id = $1 returning id`, [U.bob])).length, 0)
})

test('FX rates are stored both ways from a USD-based vendor, in numeric', async () => {
  const rows = await db.as(
    U.alice,
    `select base_currency, quote_currency, rate::text from public.fx_rates where rate_date = $1 and 'KRW' in (base_currency, quote_currency)
     order by base_currency`,
    [today],
  )
  assert.deepEqual(rows, [
    { base_currency: 'HKD', quote_currency: 'KRW', rate: '173.52185089974293' },
    { base_currency: 'KRW', quote_currency: 'HKD', rate: '0.00576296296296' },
  ])
  await expectPgError(db.as(U.alice, `select public.upsert_fx_rates(current_date, 'USD', '{}', 'x')`), /permission denied/)
})

test('create_trip: one transaction for trip, every day, owner and invite', async () => {
  const input = { name: 'Seoul', start_date: day(20), end_date: day(23), days: [20, 21, 22, 23].map((n) => seoul(day(n))) }

  await expectApiError(db.rpc(U.alice, 'create_trip', { ...input, days: input.days.slice(0, 3) }), 'validation_error', 422)
  await expectApiError(db.rpc(U.alice, 'create_trip', { ...input, days: [...input.days, seoul(day(24))] }), 'validation_error', 422)
  await expectApiError(
    db.rpc(U.alice, 'create_trip', { ...input, days: input.days.map((d) => ({ ...d, timezone: 'Mars/Olympus' })) }),
    'validation_error',
    422,
  )

  trip = await db.rpc(U.alice, 'create_trip', input)
  assert.equal(trip.base_currency, 'HKD')
  assert.equal(trip.home_timezone, 'Asia/Hong_Kong')
  assert.equal(trip.trip_days.length, 4)
  assert.equal(trip.trip_members.length, 1)
  assert.equal(trip.trip_members[0].role, 'owner')
  assert.match(trip.invite.invite_code, /^[2-9A-HJ-NP-Z]{6}$/)
  assert.ok(trip.invite.invite_token.length >= 43)
  assert.equal(trip.invite.join_path, `/join/${trip.invite.invite_token}`)
  M.alice = trip.trip_members[0].id
  firstInviteCode = trip.invite.invite_code

  assert.deepEqual(await logActions(), ['trip:create'])
  // no direct insert path for trips
  await expectPgError(
    db.as(U.alice, `insert into public.trips (name, start_date, end_date, created_by) values ('x', current_date, current_date, auth.uid())`),
    /permission denied/,
  )
})

test('join_trip: preview, join by code / token, idempotent re-join', async () => {
  const preview = await join(U.bob, { code: firstInviteCode.toLowerCase() }, { preview: true })
  assert.equal(preview.ok, true)
  assert.equal(preview.trip.name, 'Seoul')
  assert.deepEqual(preview.placeholders, [])
  assert.equal(preview.already_member, false)
  assert.equal((await db.admin('select count(*)::int as n from public.trip_members where trip_id = $1', [trip.id]))[0].n, 1)

  const bob = await join(U.bob, { code: firstInviteCode })
  assert.equal(bob.ok, true)
  assert.equal(bob.claimed, false)
  M.bob = bob.member_id
  const again = await join(U.bob, { code: firstInviteCode })
  assert.equal(again.already_member, true)
  assert.equal(again.member_id, M.bob)

  const carol = await join(U.carol, { token: trip.invite.invite_token })
  M.carol = carol.member_id

  // invite secrets are not readable by members
  assert.equal((await db.as(U.bob, 'select * from public.trip_invites')).length, 0)
  const tripRow = (await db.as(U.bob, 'select to_jsonb(t) as j from public.trips t where t.id = $1', [trip.id]))[0].j
  assert.ok(!JSON.stringify(tripRow).includes(firstInviteCode))
  assert.ok(!('invite_code' in tripRow))
  await expectApiError(db.as(U.bob, 'select public.get_trip_invite($1)', [trip.id]), 'forbidden', 403)
  const inv = (await db.as(U.alice, 'select public.get_trip_invite($1) as r', [trip.id]))[0].r
  assert.equal(inv.invite_code, firstInviteCode)

  // outsiders see nothing
  assert.equal((await db.as(U.eve, 'select * from public.trips')).length, 0)
  assert.equal((await db.as(U.eve, 'select * from public.trip_members')).length, 0)
})

test('any member may add a placeholder (member role only, unlocked trip)', async () => {
  const [ph] = await db.as(
    U.alice,
    `insert into public.trip_members (trip_id, display_name, role, user_id) values ($1, ' Dave ', 'member', null) returning *`,
    [trip.id],
  )
  assert.equal(ph.display_name, 'Dave')
  assert.equal(ph.user_id, null)
  M.dave = ph.id

  await expectPgError(
    db.as(U.bob, `insert into public.trip_members (trip_id, display_name, role, user_id) values ($1, 'X', 'admin', null)`, [trip.id]),
    /row-level security/,
  )
  await expectPgError(
    db.as(U.bob, `insert into public.trip_members (trip_id, display_name, role, user_id) values ($1, 'X', 'member', $2)`, [trip.id, U.eve]),
    /row-level security/,
  )
  await expectPgError(
    db.as(U.eve, `insert into public.trip_members (trip_id, display_name, role, user_id) values ($1, 'X', 'member', null)`, [trip.id]),
    /row-level security/,
  )
})

test('save_expense: multi-day hotel (AA), one row, local_date from occurred_at + zone', async () => {
  const hotel = await expense(U.alice, {
    title: 'Hotel 4 nights',
    category: 'Accommodation',
    amount: 1200000,
    paid_by: M.alice,
    occurred_at: `${day(20)}T15:00:00+09:00`,
    end_date: day(23),
    participants: [M.alice, M.bob, M.carol, M.dave].map((member_id) => ({ member_id, share_amount: 999 })),
  })
  E.hotel = hotel.id
  assert.equal(hotel.local_date, day(20))
  assert.equal(hotel.end_date, day(23))
  assert.equal(hotel.split_method, 'equal')
  assert.deepEqual(Object.values(shares(hotel)), [300000, 300000, 300000, 300000]) // client share_amount ignored for AA
  assert.equal(hotel.fx_rate_date, today) // future date -> latest rate
  assert.equal(String(hotel.fx_rate_to_hkd), '0.00576296296296')
  assert.equal(hotel.amount_hkd, 691556) // round(1_200_000 * 0.00576296296296 * 100)
  assert.equal(hotel.created_by, U.alice)
})

test('save_expense: AA remainder goes to members in ascending trip_members.id order', async () => {
  const e = await expense(U.bob, {
    title: 'Taxi',
    category: 'Transport',
    currency: 'HKD',
    amount: 10000,
    paid_by: M.bob,
    occurred_at: `${day(21)}T09:00:00+09:00`,
    participants: [M.carol, M.alice, M.bob].map((member_id) => ({ member_id })),
  })
  E.taxi = e.id
  const sorted = [M.alice, M.bob, M.carol].sort()
  assert.deepEqual(e.expense_participants.map((p) => p.member_id), sorted)
  assert.deepEqual(e.expense_participants.map((p) => p.share_amount), [3334, 3333, 3333])
  assert.equal(e.amount_hkd, 10000)
  assert.equal(String(e.fx_rate_to_hkd), '1')
})

test('save_expense: loan, personal souvenir, AB exact meal', async () => {
  const loan = await expense(U.bob, {
    title: 'Cash for Carol',
    category: 'Loan',
    amount: 10000,
    paid_by: M.bob,
    occurred_at: `${day(21)}T12:00:00+09:00`,
    participants: [{ member_id: M.carol }],
  })
  E.loan = loan.id
  assert.deepEqual(shares(loan), { [M.carol]: 10000 })

  const souvenir = await expense(U.carol, {
    title: 'Souvenir',
    category: 'Shopping',
    amount: '25000', // digit strings are accepted
    paid_by: M.carol,
    occurred_at: `${day(22)}T18:00:00+09:00`,
    participants: [],
  })
  E.souvenir = souvenir.id
  assert.deepEqual(souvenir.expense_participants, [])

  const meal = {
    title: 'BBQ dinner',
    currency: 'HKD',
    amount: 12000,
    paid_by: M.dave, // a placeholder can pay
    split_method: 'exact',
    occurred_at: `${day(22)}T20:00:00+09:00`,
  }
  const mismatch = await expectApiError(
    expense(U.bob, { ...meal, participants: [{ member_id: M.dave, share_amount: 8000 }, { member_id: M.bob, share_amount: 3000 }] }),
    'share_sum_mismatch',
    422,
  )
  assert.match(mismatch.message, /11000/)
  await expectApiError(
    expense(U.bob, { ...meal, participants: [{ member_id: M.dave, share_amount: 8000 }, { member_id: M.bob }] }),
    'validation_error',
    422,
  )
  const ab = await expense(U.bob, {
    ...meal,
    participants: [{ member_id: M.dave, share_amount: 8000 }, { member_id: M.bob, share_amount: '4000' }],
  })
  E.meal = ab.id
  assert.deepEqual(shares(ab), { [M.dave]: 8000, [M.bob]: 4000 })
})

test('save_expense: rejects floats, bad members, missing FX, outsiders', async () => {
  const base = { title: 'x', amount: 100, paid_by: M.bob, occurred_at: `${day(21)}T12:00:00+09:00`, participants: [] }
  await expectApiError(expense(U.bob, { ...base, amount: 120.5 }), 'validation_error', 422)
  await expectApiError(expense(U.bob, { ...base, amount: '120.50' }), 'validation_error', 422)
  await expectApiError(expense(U.bob, { ...base, amount: 0 }), 'validation_error', 422)
  await expectApiError(expense(U.bob, { ...base, occurred_at: `${day(21)}T12:00:00` }), 'validation_error', 422)
  await expectApiError(expense(U.bob, { ...base, participants: [{ member_id: M.bob, share_amount: 1.5 }], split_method: 'exact' }), 'validation_error', 422)
  await expectApiError(expense(U.bob, { ...base, participants: [{ member_id: M.bob }, { member_id: M.bob }] }), 'validation_error', 422)
  await expectApiError(expense(U.bob, { ...base, paid_by: '00000000-0000-0000-0000-000000000000' }), 'validation_error', 422)
  await expectApiError(expense(U.bob, { ...base, currency: 'ZWL' }), 'fx_rate_missing', 422)
  await expectApiError(expense(U.bob, { ...base, photo_path: `${crypto.randomUUID()}/a/b.jpg` }), 'validation_error', 422)
  await expectApiError(expense(U.eve, base), 'forbidden', 403)
  const { participants, ...noParticipants } = base
  void participants
  await expectApiError(expense(U.bob, noParticipants), 'validation_error', 422)

  // no direct writes to expenses / participants
  await expectPgError(db.as(U.bob, `update public.expenses set title = 'hack' where id = $1`, [E.hotel]), /permission denied/)
  await expectPgError(
    db.as(U.bob, `insert into public.expense_participants (expense_id, member_id, share_amount) values ($1, $2, 1)`, [E.hotel, M.bob]),
    /permission denied/,
  )
  await expectPgError(db.as(U.bob, `delete from public.expenses where id = $1`, [E.hotel]), /permission denied/)
})

test('save_expense: page date follows the stored zone; past dates lock that day’s rate', async () => {
  // 00:30 in Seoul is 23:30 the previous day in Hong Kong
  const hk = await expense(U.alice, {
    title: 'Airport express',
    category: 'Transport',
    currency: 'HKD',
    amount: 11500,
    paid_by: M.alice,
    timezone: 'Asia/Hong_Kong',
    occurred_at: `${day(20)}T00:30:00+09:00`,
    participants: [{ member_id: M.alice }],
  })
  assert.equal(hk.local_date, day(19))

  // pre-trip booking 50 days ago: nearest earlier stored rate (60 days ago, KRW 1400)
  const early = await expense(U.alice, {
    title: 'Palace tickets',
    category: 'Activities & Tickets',
    amount: 60000,
    paid_by: M.alice,
    occurred_at: `${day(-50)}T10:00:00+09:00`,
    participants: [{ member_id: M.alice }, { member_id: M.bob }],
  })
  E.early = early.id
  assert.equal(early.fx_rate_date, day(-60))
  assert.equal(early.amount_hkd, 33429) // round(60000 * 7.8/1400 * 100)

  // older than any stored rate: the earliest stored rate is used, and shown via fx_rate_date
  const ancient = await expense(U.alice, {
    title: 'Guidebook',
    category: 'Shopping',
    amount: 20000,
    paid_by: M.alice,
    occurred_at: `${day(-100)}T10:00:00+09:00`,
    participants: [],
  })
  assert.equal(ancient.fx_rate_date, day(-60))
})

test('optimistic lock, FX only re-locked on amount / currency / date change, AA <-> AB switch', async () => {
  const [hotel] = await db.as(U.bob, 'select * from public.expenses where id = $1', [E.hotel])
  const stale = { ...hotel, expected_updated_at: '2000-01-01T00:00:00+00:00' }
  const body = (e, extra) => ({
    id: e.id,
    trip_id: trip.id,
    title: e.title,
    category: e.category,
    amount: e.amount,
    currency: e.currency,
    paid_by: e.paid_by,
    split_method: e.split_method,
    occurred_at: new Date(e.occurred_at).toISOString(),
    timezone: e.timezone,
    end_date: e.end_date ? isoDate(e.end_date) : null,
    currency_manually_set: e.currency_manually_set,
    expected_updated_at: e.expected_updated_at,
    participants: [M.alice, M.bob, M.carol, M.dave].map((member_id) => ({ member_id })),
    ...extra,
  })
  const conflict = await expectApiError(db.rpc(U.bob, 'save_expense', body(stale)), 'conflict_updated_at', 409)
  assert.equal(JSON.parse(conflict.details).id, E.hotel) // current row comes back

  // PostgREST returns timestamptz as ISO text; clients echo it back
  const [{ ts }] = await db.as(U.bob, `select to_json(updated_at)#>>'{}' as ts from public.expenses where id = $1`, [E.hotel])
  const renamed = await db.rpc(U.bob, 'save_expense', body({ ...hotel, expected_updated_at: ts }, { title: 'Hotel (4 nights)' }))
  assert.equal(renamed.title, 'Hotel (4 nights)')
  assert.equal(renamed.fx_rate_date, isoDate(hotel.fx_rate_date))
  assert.notEqual(new Date(renamed.updated_at).getTime(), new Date(ts).getTime())
  // the old token is now stale
  await expectApiError(db.rpc(U.bob, 'save_expense', body({ ...hotel, expected_updated_at: ts })), 'conflict_updated_at', 409)

  // taxi: AA -> AB -> AA replaces shares each time
  const [taxi] = await db.as(U.bob, `select *, to_json(updated_at)#>>'{}' as ts from public.expenses where id = $1`, [E.taxi])
  const toAB = await db.rpc(U.bob, 'save_expense', {
    ...body({ ...taxi, expected_updated_at: taxi.ts }),
    split_method: 'exact',
    participants: [{ member_id: M.alice, share_amount: 7000 }, { member_id: M.bob, share_amount: 3000 }],
  })
  assert.deepEqual(shares(toAB), { [M.alice]: 7000, [M.bob]: 3000 })
  const [{ ts: ts2 }] = await db.as(U.bob, `select to_json(updated_at)#>>'{}' as ts from public.expenses where id = $1`, [E.taxi])
  const toAA = await db.rpc(U.bob, 'save_expense', {
    ...body({ ...taxi, expected_updated_at: ts2 }),
    split_method: 'equal',
    participants: [{ member_id: M.alice }, { member_id: M.bob }],
  })
  assert.deepEqual(Object.values(shares(toAA)), [5000, 5000])

  const updates = await db.admin(
    `select count(*)::int as n from public.activity_log where entity_id = $1 and action = 'update'`,
    [E.taxi],
  )
  assert.equal(updates[0].n, 2)
})

test('soft delete and restore; hard delete is impossible even for the service role', async () => {
  const [{ ts }] = await db.as(U.carol, `select to_json(updated_at)#>>'{}' as ts from public.expenses where id = $1`, [E.souvenir])
  await expectApiError(
    db.as(U.carol, `select public.soft_delete_expense($1, '2000-01-01T00:00:00Z')`, [E.souvenir]),
    'conflict_updated_at',
    409,
  )
  const del = (await db.as(U.carol, 'select public.soft_delete_expense($1, $2) as r', [E.souvenir, ts]))[0].r
  assert.ok(del.deleted_at)
  const live = await db.as(U.bob, 'select id from public.expenses where trip_id = $1 and deleted_at is null', [trip.id])
  assert.ok(!live.some((r) => r.id === E.souvenir))

  const restored = (await db.as(U.bob, 'select public.restore_expense($1) as r', [E.souvenir]))[0].r
  assert.equal(restored.deleted_at, null)
  assert.deepEqual(restored.expense_participants, []) // still personal

  await expectApiError(db.service('delete from public.expenses where id = $1', [E.souvenir]), 'forbidden', 403)
  const actions = (await db.admin(`select action from public.activity_log where entity_id = $1 order by created_at`, [E.souvenir])).map((r) => r.action)
  assert.deepEqual(actions, ['create', 'delete', 'restore'])
})

test('update_trip: date-range edit keeps expenses, every date keeps a location', async () => {
  const moved = await db.rpc(U.alice, 'update_trip', { trip_id: trip.id, start_date: day(19), days: [seoul(day(19))] })
  assert.equal(moved.start_date, day(19))
  assert.deepEqual(moved.trip_days.map((d) => d.date), [19, 20, 21, 22, 23].map(day))

  // shrinking drops the day; the hotel keeps its stored dates and FX
  const shrunk = await db.rpc(U.alice, 'update_trip', { trip_id: trip.id, end_date: day(22) })
  assert.equal(shrunk.trip_days.length, 4)
  const [hotel] = await db.as(U.bob, 'select local_date::text, end_date::text, fx_rate_date::text from public.expenses where id = $1', [E.hotel])
  assert.deepEqual(hotel, { local_date: day(20), end_date: day(23), fx_rate_date: today })

  // growing again needs a location for the new date
  await expectApiError(db.rpc(U.alice, 'update_trip', { trip_id: trip.id, end_date: day(23) }), 'validation_error', 422)
  const grown = await db.rpc(U.alice, 'update_trip', { trip_id: trip.id, end_date: day(23), days: [seoul(day(23))] })
  assert.equal(grown.trip_days.length, 5)
  trip = { ...trip, ...grown }

  await expectApiError(db.rpc(U.bob, 'update_trip', { trip_id: trip.id, name: 'Bob trip' }), 'forbidden', 403)

  // direct admin edit of a date's location is allowed and logged; non-admins can't
  await db.as(U.alice, `update public.trip_days set location_name = 'Busan', timezone = 'Asia/Seoul' where trip_id = $1 and date = $2`, [trip.id, day(23)])
  const none = await db.as(U.bob, `update public.trip_days set location_name = 'X' where trip_id = $1 and date = $2 returning *`, [trip.id, day(23)])
  assert.equal(none.length, 0)
  await expectApiError(db.as(U.alice, `delete from public.trip_days where trip_id = $1 and date = $2`, [trip.id, day(21)]), 'validation_error', 422)
  await expectApiError(
    db.as(U.alice, `insert into public.trip_days select trip_id, $2::date, location_name, country_code, latitude, longitude, timezone, currency from public.trip_days where trip_id = $1 and date = $3`, [trip.id, day(40), day(21)]),
    'validation_error',
    422,
  )

  // name / joining via PATCH /trips (admin)
  await db.as(U.alice, `update public.trips set name = 'Seoul & Busan' where id = $1`, [trip.id])
  await expectPgError(db.as(U.alice, `update public.trips set is_locked = true where id = $1`, [trip.id]), /permission denied/)
  await expectPgError(db.as(U.alice, `update public.trips set base_currency = 'USD' where id = $1`, [trip.id]), /permission denied/)

  const log = await logActions()
  assert.equal(log.filter((a) => a === 'trip:update').length, 4) // 3 update_trip + 1 rename
  assert.ok(log.includes('trip_day:update'))
})

test('placeholder claim keeps the SAME trip_members.id', async () => {
  const preview = await join(U.dave, { code: firstInviteCode }, { preview: true })
  assert.deepEqual(preview.placeholders, [{ id: M.dave, display_name: 'Dave' }])
  const before = (await db.admin('select count(*)::int as n from public.trip_members where trip_id = $1', [trip.id]))[0].n

  const claimed = await join(U.dave, { code: firstInviteCode }, { claim: M.dave })
  assert.deepEqual(claimed, { ok: true, trip_id: trip.id, member_id: M.dave, claimed: true })
  const after = (await db.admin('select count(*)::int as n from public.trip_members where trip_id = $1', [trip.id]))[0].n
  assert.equal(after, before)

  const [meal] = await db.as(U.dave, 'select paid_by from public.expenses where id = $1', [E.meal])
  assert.equal(meal.paid_by, M.dave)
  const [row] = await db.as(U.dave, 'select user_id, display_name from public.trip_members where id = $1', [M.dave])
  assert.deepEqual(row, { user_id: U.dave, display_name: 'Dave' })

  // a claimed placeholder cannot be claimed again
  const eve = await join(U.eve, { code: firstInviteCode }, { claim: M.dave })
  assert.equal(eve.status, 422)
  assert.equal((await db.admin(`select count(*)::int as n from public.trip_members where user_id = $1`, [U.eve]))[0].n, 0)

  const claimLog = await db.admin(`select actor_member from public.activity_log where action = 'claim' and entity_id = $1`, [M.dave])
  assert.deepEqual(claimLog, [{ actor_member: M.dave }])
  const notified = await db.admin(`select user_id from public.notifications where type = 'placeholder_claimed' order by user_id`)
  assert.deepEqual(notified.map((r) => r.user_id).sort(), [U.alice, U.bob, U.carol].sort())
})

test('HKD repayment of a KRW debt: idempotency_key replay never double-pays', async () => {
  const body = {
    trip_id: trip.id,
    from_member: M.carol,
    to_member: M.bob,
    debt_currency: 'KRW',
    debt_amount: 10000,
    paid_currency: 'HKD',
    paid_amount: 5763,
    fx_rate: '0.00576296296296',
    idempotency_key: 'settle-carol-bob-0001',
  }
  await expectApiError(db.rpc(U.carol, 'record_settlement', { ...body, fx_rate: null }), 'validation_error', 422)
  await expectApiError(
    db.rpc(U.carol, 'record_settlement', { ...body, paid_currency: 'KRW', paid_amount: 9000, idempotency_key: 'other-key-0001' }),
    'validation_error',
    422,
  )
  await expectApiError(db.rpc(U.carol, 'record_settlement', { ...body, paid_amount: 57.63 }), 'validation_error', 422)

  const first = await db.rpc(U.carol, 'record_settlement', body)
  assert.equal(first.idempotent_replay, false)
  assert.equal(first.created_by, U.carol)
  const replay = await db.rpc(U.carol, 'record_settlement', body)
  assert.equal(replay.idempotent_replay, true)
  assert.equal(replay.id, first.id)

  // the plain table POST path hits the unique constraint instead
  await expectPgError(
    db.as(
      U.carol,
      `insert into public.settlements (trip_id, from_member, to_member, debt_currency, debt_amount, paid_currency, paid_amount, fx_rate, paid_at, idempotency_key)
       values ($1, $2, $3, 'KRW', 10000, 'HKD', 5763, 0.00576296296296, now(), 'settle-carol-bob-0001')`,
      [trip.id, M.carol, M.bob],
    ),
    /23505|duplicate key/,
  )
  const count = await db.admin(`select count(*)::int as n from public.settlements where trip_id = $1`, [trip.id])
  assert.equal(count[0].n, 1)

  // direct POST works for a new key and forces created_by
  const [direct] = await db.as(
    U.alice,
    `insert into public.settlements (trip_id, from_member, to_member, debt_currency, debt_amount, paid_currency, paid_amount, paid_at, idempotency_key)
     values ($1, $2, $3, 'HKD', 5000, 'HKD', 5000, now(), 'alice-bob-taxi-01') returning created_by`,
    [trip.id, M.alice, M.bob],
  )
  assert.equal(direct.created_by, U.alice)

  const received = await db.as(U.bob, `select payload from public.notifications where type = 'settlement_received' order by created_at`)
  assert.equal(received.length, 2)
  assert.equal(received[0].payload.amount_display, '57.63 HKD')
  assert.equal(received[0].payload.actor_name, 'Carol')

  await expectApiError(db.service(`update public.settlements set paid_amount = 1 where id = $1`, [first.id]), 'forbidden', 403)
  await expectApiError(db.service(`delete from public.settlements where id = $1`, [first.id]), 'forbidden', 403)
})

test('roles: admins promote; the owner is untouchable; placeholders never admin', async () => {
  const bob = (await db.as(U.alice, `select public.set_member_role($1, 'admin') as r`, [M.bob]))[0].r
  assert.equal(bob.role, 'admin')
  await expectApiError(db.as(U.bob, `select public.set_member_role($1, 'member')`, [M.alice]), 'forbidden', 403)
  await expectApiError(db.as(U.bob, `select public.remove_member($1)`, [M.alice]), 'forbidden', 403)
  await expectApiError(db.as(U.alice, `select public.set_member_role($1, 'owner')`, [M.bob]), 'validation_error', 422)
  await expectApiError(db.as(U.carol, `select public.set_member_role($1, 'admin')`, [M.carol]), 'forbidden', 403)
  const [ph] = await db.as(U.carol, `insert into public.trip_members (trip_id, display_name) values ($1, 'Grandma') returning id`, [trip.id])
  await expectApiError(db.as(U.alice, `select public.set_member_role($1, 'admin')`, [ph.id]), 'validation_error', 422)
  await expectPgError(db.as(U.alice, `update public.trip_members set role = 'admin' where id = $1`, [M.carol]), /permission denied/)
})

test('removed members keep history, lose access, and cannot be newly added to To', async () => {
  const removed = (await db.as(U.bob, `select public.remove_member($1) as r`, [M.carol]))[0].r
  assert.ok(removed.removed_at)
  assert.equal((await db.as(U.carol, 'select * from public.trips')).length, 0)
  await expectApiError(
    expense(U.carol, { title: 'x', amount: 1, paid_by: M.carol, occurred_at: `${day(21)}T12:00:00+09:00`, participants: [] }),
    'forbidden',
    403,
  )
  // still shown to remaining members
  const [row] = await db.as(U.bob, 'select removed_at from public.trip_members where id = $1', [M.carol])
  assert.ok(row.removed_at)

  await expectApiError(
    expense(U.bob, { title: 'Snacks', amount: 3000, paid_by: M.bob, occurred_at: `${day(21)}T15:00:00+09:00`, participants: [{ member_id: M.carol }] }),
    'validation_error',
    422,
  )
  // ...but can stay on an existing expense when it is edited
  const [loan] = await db.as(U.bob, `select *, to_json(updated_at)#>>'{}' as ts from public.expenses where id = $1`, [E.loan])
  const edited = await db.rpc(U.bob, 'save_expense', {
    id: E.loan,
    trip_id: trip.id,
    title: 'Cash for Carol (ATM)',
    category: 'Loan',
    amount: 10000,
    currency: 'KRW',
    paid_by: M.bob,
    split_method: 'equal',
    occurred_at: new Date(loan.occurred_at).toISOString(),
    timezone: 'Asia/Seoul',
    expected_updated_at: loan.ts,
    participants: [{ member_id: M.carol }],
  })
  assert.deepEqual(shares(edited), { [M.carol]: 10000 })

  // re-joining gives Carol her old row back (never a second row)
  const back = await join(U.carol, { code: firstInviteCode })
  assert.equal(back.member_id, M.carol)
  const rows = await db.admin(`select count(*)::int as n from public.trip_members where trip_id = $1 and user_id = $2`, [trip.id, U.carol])
  assert.equal(rows[0].n, 1)
})

test('locked trip rejects member writes; only admin unlock gets through', async () => {
  await expectApiError(db.as(U.carol, 'select public.lock_trip($1)', [trip.id]), 'forbidden', 403)
  const locked = (await db.as(U.alice, 'select public.lock_trip($1) as r', [trip.id]))[0].r
  assert.equal(locked.is_locked, true)

  const base = { title: 'x', amount: 100, paid_by: M.bob, occurred_at: `${day(21)}T12:00:00+09:00`, participants: [] }
  await expectApiError(expense(U.bob, base), 'trip_locked', 423)
  await expectApiError(db.as(U.bob, 'select public.restore_expense($1)', [E.hotel]), 'trip_locked', 423)
  await expectApiError(db.as(U.bob, `select public.soft_delete_expense($1, now())`, [E.hotel]), 'trip_locked', 423)
  await expectApiError(
    db.rpc(U.bob, 'record_settlement', {
      trip_id: trip.id, from_member: M.bob, to_member: M.alice, debt_currency: 'HKD', debt_amount: 1,
      paid_currency: 'HKD', paid_amount: 1, idempotency_key: 'locked-trip-01',
    }),
    'trip_locked',
    423,
  )
  await expectPgError(
    db.as(U.bob, `insert into public.trip_members (trip_id, display_name) values ($1, 'Late')`, [trip.id]),
    /row-level security/,
  )
  await expectApiError(db.rpc(U.alice, 'update_trip', { trip_id: trip.id, name: 'x' }), 'trip_locked', 423)
  await expectApiError(db.as(U.alice, `select public.set_member_role($1, 'member')`, [M.bob]), 'trip_locked', 423)
  await expectApiError(db.as(U.alice, 'select public.delete_trip($1)', [trip.id]), 'trip_locked', 423)
  await expectApiError(db.service('select public.regenerate_invite_as($1, $2)', [U.alice, trip.id]), 'trip_locked', 423)
  const renamed = await db.as(U.alice, `update public.trips set name = 'x' where id = $1 returning id`, [trip.id])
  assert.equal(renamed.length, 0)
  const eve = await join(U.eve, { code: firstInviteCode })
  assert.deepEqual([eve.status, eve.code], [403, 'trip_locked'])

  const lockedNotices = await db.admin(`select user_id from public.notifications where type = 'trip_locked'`)
  assert.deepEqual(lockedNotices.map((r) => r.user_id).sort(), [U.bob, U.carol, U.dave].sort())

  const unlocked = (await db.as(U.bob, 'select public.unlock_trip($1) as r', [trip.id]))[0].r
  assert.equal(unlocked.is_locked, false)
  const ok = await expense(U.bob, { ...base, title: 'After unlock', participants: [{ member_id: M.bob }] })
  assert.equal(ok.title, 'After unlock')
})

test('regenerate_invite kills the old code and link immediately; logs carry no secrets', async () => {
  const oldToken = trip.invite.invite_token
  await expectApiError(db.service('select public.regenerate_invite_as($1, $2)', [U.carol, trip.id]), 'forbidden', 403)
  const fresh = (await db.service('select public.regenerate_invite_as($1, $2) as r', [U.alice, trip.id]))[0].r
  assert.notEqual(fresh.invite_code, firstInviteCode)
  assert.notEqual(fresh.invite_token, oldToken)

  const byOldCode = await join(U.eve, { code: firstInviteCode }, { preview: true })
  assert.deepEqual([byOldCode.status, byOldCode.code], [404, 'invite_invalid'])
  const byOldToken = await join(U.eve, { token: oldToken }, { preview: true })
  assert.equal(byOldToken.status, 404)
  const byNew = await join(U.eve, { code: fresh.invite_code }, { preview: true })
  assert.equal(byNew.ok, true)

  const logs = await db.admin(`select before, after from public.activity_log where action = 'invite_regen'`)
  assert.deepEqual(logs, [{ before: null, after: null }])
  const leaks = await db.admin(
    `select count(*)::int as n from public.activity_log
     where coalesce(before::text, '') || coalesce(after::text, '') ~ ($1 || '|' || $2 || '|' || $3 || '|' || $4)`,
    [firstInviteCode, fresh.invite_code, oldToken.replace(/[-]/g, '\\-'), fresh.invite_token.replace(/[-]/g, '\\-')],
  )
  assert.equal(leaks[0].n, 0)
  trip.invite = fresh
})

test('join_trip is rate-limited per user after repeated bad codes', async () => {
  const mallory = await db.createUser('mallory@example.com', { name: 'Mallory' })
  for (let i = 0; i < 10; i++) {
    const r = await join(mallory, { code: 'ZZZZZZ' }, { client: 'mallory-ip' })
    assert.equal(r.status, 404)
  }
  const blocked = await join(mallory, { code: trip.invite.invite_code }, { client: 'mallory-ip' })
  assert.deepEqual([blocked.status, blocked.code], [429, 'rate_limited'])
  // attempts store hashes only
  const leaked = await db.admin(`select count(*)::int as n from private.join_attempts where target_hash in ('ZZZZZZ', $1)`, [trip.invite.invite_code])
  assert.equal(leaked[0].n, 0)
})

test('photos: private bucket, members only, locked trips read-only', async () => {
  const [bucket] = await db.admin(`select public, file_size_limit from storage.buckets where id = 'trip-photos'`)
  assert.deepEqual(bucket, { public: false, file_size_limit: 5242880 })

  const path = `${trip.id}/${E.meal}/${crypto.randomUUID()}.jpg`
  await db.as(U.bob, `insert into storage.objects (bucket_id, name) values ('trip-photos', $1)`, [path])
  assert.equal((await db.as(U.dave, `select name from storage.objects where bucket_id = 'trip-photos'`)).length, 1)
  assert.equal((await db.as(U.eve, `select name from storage.objects where bucket_id = 'trip-photos'`)).length, 0)
  await expectPgError(
    db.as(U.eve, `insert into storage.objects (bucket_id, name) values ('trip-photos', $1)`, [`${trip.id}/x/${crypto.randomUUID()}.jpg`]),
    /row-level security/,
  )
  await expectPgError(
    db.as(U.bob, `insert into storage.objects (bucket_id, name) values ('trip-photos', $1)`, [`${trip.id}/../evil.exe`]),
    /row-level security/,
  )

  // the path can be attached to an expense of the same trip
  const [meal] = await db.as(U.bob, `select *, to_json(updated_at)#>>'{}' as ts from public.expenses where id = $1`, [E.meal])
  const withPhoto = await db.rpc(U.bob, 'save_expense', {
    id: E.meal, trip_id: trip.id, title: meal.title, category: meal.category, amount: meal.amount,
    currency: meal.currency, paid_by: meal.paid_by, split_method: 'exact',
    occurred_at: new Date(meal.occurred_at).toISOString(), timezone: meal.timezone,
    expected_updated_at: meal.ts, photo_path: path,
    participants: [{ member_id: M.dave, share_amount: 8000 }, { member_id: M.bob, share_amount: 4000 }],
  })
  assert.equal(withPhoto.photo_path, path)

  await db.as(U.alice, 'select public.lock_trip($1)', [trip.id])
  await expectPgError(
    db.as(U.bob, `insert into storage.objects (bucket_id, name) values ('trip-photos', $1)`, [`${trip.id}/x/${crypto.randomUUID()}.jpg`]),
    /row-level security/,
  )
  const deleted = await db.as(U.bob, `delete from storage.objects where name = $1 returning id`, [path])
  assert.equal(deleted.length, 0)
  await db.as(U.alice, 'select public.unlock_trip($1)', [trip.id])
})

test('notifications: own rows, read_at only, settings honoured, push hook fires', async () => {
  const mine = await db.as(U.bob, 'select id, user_id, type from public.notifications')
  assert.ok(mine.length > 0 && mine.every((n) => n.user_id === U.bob))
  assert.equal((await db.as(U.bob, `update public.notifications set read_at = now() where user_id <> auth.uid() returning id`)).length, 0)
  await db.as(U.bob, `update public.notifications set read_at = now() where id = $1`, [mine[0].id])
  await expectPgError(db.as(U.bob, `update public.notifications set payload = '{}' where id = $1`, [mine[0].id]), /permission denied/)
  await expectPgError(
    db.as(U.bob, `insert into public.notifications (user_id, trip_id, type) values (auth.uid(), $1, 'trip_locked')`, [trip.id]),
    /permission denied/,
  )

  // Bob mutes expense_added
  await db.as(U.bob, `insert into public.notification_settings (type, enabled) values ('expense_added', false)`)
  const count = async () =>
    (await db.admin(`select count(*)::int as n from public.notifications where user_id = $1 and type = 'expense_added'`, [U.bob]))[0].n
  const beforeMute = await count()
  await expense(U.alice, { title: 'Coffee', currency: 'HKD', amount: 4000, paid_by: M.alice, occurred_at: `${day(21)}T08:00:00+09:00`, participants: [{ member_id: M.alice }, { member_id: M.bob }] })
  assert.equal(await count(), beforeMute)

  // push hook: needs a subscription + Vault secrets
  await db.admin(`insert into vault.secrets values ('project_url', 'https://proj.supabase.co'), ('push_webhook_secret', 'hook-secret')`)
  await db.as(U.dave, `insert into public.push_subscriptions (endpoint, keys) values ('https://push.example/abc', '{"p256dh":"k","auth":"a"}')`)
  await expense(U.alice, { title: 'Tea', currency: 'HKD', amount: 3000, paid_by: M.alice, occurred_at: `${day(21)}T09:00:00+09:00`, participants: [{ member_id: M.dave }] })
  const [req] = await db.admin(`select url, headers, body from net.requests where url like '%send_push' order by id desc limit 1`)
  assert.equal(req.url, 'https://proj.supabase.co/functions/v1/send_push')
  assert.equal(req.headers['x-webhook-secret'], 'hook-secret')
  assert.equal(req.body.record.user_id, U.dave)
  assert.equal(req.body.record.type, 'expense_added')
  await expectPgError(
    db.as(U.bob, `insert into public.push_subscriptions (user_id, endpoint, keys) values ($1, 'https://push.example/x', '{"p256dh":"k","auth":"a"}')`, [U.dave]),
    /row-level security/,
  )
})

test('invariants hold across the whole trip', async () => {
  const badSums = await db.admin(`
    select e.id from public.expenses e
    join public.expense_participants p on p.expense_id = e.id
    group by e.id, e.amount having sum(p.share_amount) <> e.amount`)
  assert.deepEqual(badSums, [])

  const personal = await db.admin(`select count(*)::int as n from public.expense_participants where expense_id = $1`, [E.souvenir])
  assert.equal(personal[0].n, 0)

  const [hotelCount] = await db.admin(`select count(*)::int as n from public.expenses where title like 'Hotel%'`)
  assert.equal(hotelCount.n, 1) // multi-day = one row

  const log = await logActions()
  for (const needed of [
    'trip:create', 'trip_member:join', 'trip_member:create', 'expense:create', 'expense:update',
    'expense:delete', 'expense:restore', 'trip:update', 'trip_member:claim', 'settlement:create',
    'trip_member:role_change', 'trip_member:remove', 'trip:lock', 'trip:unlock', 'trip_invite:invite_regen',
  ]) {
    assert.ok(log.includes(needed), `activity_log is missing ${needed}`)
  }

  await expectApiError(db.service(`update public.activity_log set action = 'x'`), 'forbidden', 403)
  await expectApiError(db.service(`delete from public.activity_log`), 'forbidden', 403)
  await expectPgError(
    db.as(U.alice, `insert into public.activity_log (trip_id, action, entity_type) values ($1, 'x', 'y')`, [trip.id]),
    /permission denied/,
  )

  // Realtime prerequisites: a second member can SELECT the first member's INSERT
  const visible = await db.as(U.dave, 'select id from public.expenses where id = $1', [E.hotel])
  assert.equal(visible.length, 1)
  const pub = await db.admin(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1`)
  assert.deepEqual(pub.map((r) => r.tablename), ['expense_participants', 'expenses', 'notifications', 'settlements', 'trip_days', 'trip_members', 'trips'])
  const [ri] = await db.admin(`select relreplident from pg_class where oid = 'public.expenses'::regclass`)
  assert.equal(ri.relreplident, 'f')
})

test('delete_trip: owner only; cascades everything and queues photo deletion', async () => {
  await expectApiError(db.as(U.bob, 'select public.delete_trip($1)', [trip.id]), 'forbidden', 403)
  await db.admin(`insert into vault.secrets values ('service_role_key', 'service-key')`)
  const res = (await db.as(U.alice, 'select public.delete_trip($1) as r', [trip.id]))[0].r
  assert.deepEqual([res.deleted, res.photos, res.photos_queued_for_deletion], [true, 1, 1])

  for (const table of ['trips', 'trip_days', 'trip_members', 'trip_invites', 'expenses', 'settlements', 'activity_log', 'notifications']) {
    const col = table === 'trips' ? 'id' : 'trip_id'
    const [{ n }] = await db.admin(`select count(*)::int as n from public.${table} where ${col} = $1`, [trip.id])
    assert.equal(n, 0, `${table} still has rows`)
  }
  const [del] = await db.admin(`select url, headers from net.requests where method = 'DELETE'`)
  assert.match(del.url, new RegExp(`^https://proj\\.supabase\\.co/storage/v1/object/trip-photos/${trip.id}/`))
  assert.equal(del.headers.apikey, 'service-key')
})
