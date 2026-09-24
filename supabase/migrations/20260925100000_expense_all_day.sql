-- =============================================================================
-- All-day expenses: an expense can be "all day" instead of at a set time.
--
--   * expenses.all_day (default false, so existing rows keep their time).
--   * An all-day expense keeps the page its occurred_at + timezone give it,
--     and occurred_at is stored as the start of that local day (00:00, or the
--     first minute that exists on a day that skips midnight for daylight
--     saving), so the time part never means anything.
--   * save_expense takes an optional all_day. Omitted on create = false;
--     omitted on update = unchanged, so an installed app from before this
--     change can still edit an all-day expense without making it timed.
-- =============================================================================

alter table public.expenses add column all_day boolean not null default false;

-- POST /rest/v1/rpc/save_expense
--   { id: null|uuid, trip_id, title, category, amount, currency, paid_by,
--     split_method: 'equal'|'exact', occurred_at, timezone, all_day?, end_date,
--     location_text, latitude, longitude, photo_path, note,
--     currency_manually_set, expected_updated_at,
--     participants: [{ member_id, share_amount }] }
-- Returns the expense with expense_participants [{ member_id, share_amount }].
create or replace function public.save_expense(jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  p            jsonb := coalesce($1, '{}'::jsonb);
  v_uid        uuid := private.require_user();
  v_today      date := (now() at time zone 'Asia/Hong_Kong')::date;
  v_id         uuid;
  v_trip_id    uuid;
  v_trip       public.trips;
  v_old        public.expenses;
  v_new        public.expenses;
  v_payer      public.trip_members;
  v_expected   timestamptz;
  v_before     jsonb;
  v_after      jsonb;
  v_decimals   integer;
  v_hkd        numeric;
  v_parts      jsonb;
  v_el         jsonb;
  v_mid        uuid;
  v_ids        uuid[] := '{}';
  v_shares     integer[] := '{}';
  v_old_ids    uuid[] := '{}';
  v_sum        bigint;
  v_n          integer;
  v_q          integer;
  v_r          integer;
begin
  v_id      := private.j_uuid(p, 'id');
  v_trip_id := private.j_uuid(p, 'trip_id', true);

  -- 1. current member, trip not locked (FOR SHARE: serialises with lock_trip)
  select t.* into v_trip from public.trips t where t.id = v_trip_id for share;
  if not found or not private.is_trip_member(v_trip_id) then
    perform private.api_error('forbidden', 'You are not a member of this trip', 403);
  end if;
  if v_trip.is_locked then
    perform private.api_error('trip_locked', 'This trip is locked', 423);
  end if;

  -- 3. update: optimistic lock on updated_at (lost-update protection)
  if v_id is not null then
    select e.* into v_old from public.expenses e where e.id = v_id and e.trip_id = v_trip_id for update;
    if not found then
      perform private.api_error('not_found', 'Expense not found', 404);
    end if;
    v_expected := private.j_timestamptz(p, 'expected_updated_at', true);
    v_before := private.expense_json(v_old);
    if v_old.deleted_at is not null or v_old.updated_at <> v_expected then
      perform private.api_error('conflict_updated_at',
        case when v_old.deleted_at is not null then 'This expense was deleted by someone else'
             else 'This expense was changed by someone else' end,
        409, v_before::text);
    end if;
    select coalesce(array_agg(ep.member_id), '{}') into v_old_ids
    from public.expense_participants ep where ep.expense_id = v_id;
  end if;

  -- fields
  v_new.id       := coalesce(v_id, gen_random_uuid());
  v_new.trip_id  := v_trip_id;
  v_new.title    := private.j_text(p, 'title', true, 200);
  v_new.category := private.j_text(p, 'category', true);
  if v_new.category not in ('Food & Drink', 'Transport', 'Accommodation', 'Activities & Tickets',
                            'Shopping', 'Groceries', 'Loan', 'Other') then
    perform private.api_error('validation_error', 'Unknown category ' || v_new.category, 422);
  end if;
  v_new.amount   := private.j_minor(p, 'amount', true, 1);
  v_new.currency := upper(private.j_text(p, 'currency', true, 3));
  select c.decimals into v_decimals from public.currencies c where c.code = v_new.currency;
  if not found then
    perform private.api_error('validation_error', 'Unknown currency ' || v_new.currency, 422);
  end if;
  v_new.split_method := coalesce(private.j_text(p, 'split_method'), 'equal');
  if v_new.split_method not in ('equal', 'exact') then
    perform private.api_error('validation_error', 'split_method must be equal or exact', 422);
  end if;
  v_new.occurred_at := private.j_timestamptz(p, 'occurred_at', true);
  v_new.timezone    := private.j_text(p, 'timezone', true, 64);
  if not private.is_valid_timezone(v_new.timezone) then
    perform private.api_error('validation_error', 'timezone must be an IANA name such as Asia/Tokyo', 422);
  end if;
  -- omitted: false on create, unchanged on update (apps from before all_day)
  v_new.all_day := private.j_bool(p, 'all_day', coalesce(v_old.all_day, false));
  -- 4. page assignment comes from the stored instant + zone, never a phone clock
  v_new.local_date := (v_new.occurred_at at time zone v_new.timezone)::date;
  if v_new.all_day then
    -- no time of day: store the start of that local day. A midnight skipped by
    -- daylight saving resolves to the first minute after the gap, same date.
    v_new.occurred_at := v_new.local_date::timestamp at time zone v_new.timezone;
  end if;
  v_new.end_date   := private.j_date(p, 'end_date');
  if v_new.end_date = v_new.local_date then
    v_new.end_date := null;  -- a one-day "range" is an ordinary expense
  elsif v_new.end_date < v_new.local_date then
    perform private.api_error('validation_error', 'end_date must be on or after the expense date', 422);
  elsif v_new.end_date - v_new.local_date >= 366 then
    perform private.api_error('validation_error', 'A multi-day expense can cover at most 366 days', 422);
  end if;
  v_new.location_text := private.j_text(p, 'location_text', false, 300);
  v_new.latitude      := private.j_float(p, 'latitude', -90, 90);
  v_new.longitude     := private.j_float(p, 'longitude', -180, 180);
  if (v_new.latitude is null) <> (v_new.longitude is null) then
    perform private.api_error('validation_error', 'latitude and longitude must be sent together', 422);
  end if;
  v_new.photo_path := private.j_text(p, 'photo_path', false, 300);
  if v_new.photo_path is not null
     and (private.path_trip_id(v_new.photo_path) is distinct from v_trip_id
          or not private.photo_path_ok(v_new.photo_path)) then
    perform private.api_error('validation_error',
      'photo_path must be a trip-photos object of this trip: {trip_id}/{expense_id}/{uuid}.jpg', 422);
  end if;
  v_new.note := private.j_text(p, 'note', false, 2000);
  v_new.currency_manually_set := private.j_bool(p, 'currency_manually_set', false);

  -- 2. paid_by belongs to the trip; a removed member only if already the payer
  v_new.paid_by := private.j_uuid(p, 'paid_by', true);
  select m.* into v_payer from public.trip_members m where m.id = v_new.paid_by and m.trip_id = v_trip_id;
  if not found then
    perform private.api_error('validation_error', 'paid_by must be a member of this trip', 422);
  end if;
  if v_payer.removed_at is not null and v_old.paid_by is distinct from v_new.paid_by then
    perform private.api_error('validation_error', v_payer.display_name || ' has left the trip', 422);
  end if;

  -- 6. participants ("To"); a removed member may stay but never be newly added
  v_parts := p -> 'participants';
  if v_parts is null or jsonb_typeof(v_parts) <> 'array' then
    perform private.api_error('validation_error',
      'participants is required (an empty array makes a personal expense)', 422);
  end if;
  for v_el in select value from jsonb_array_elements(v_parts) loop
    if jsonb_typeof(v_el) <> 'object' then
      perform private.api_error('validation_error', 'each participant must be an object', 422);
    end if;
    v_mid := private.j_uuid(v_el, 'member_id', true);
    if v_mid = any (v_ids) then
      perform private.api_error('validation_error', 'participant ' || v_mid || ' is listed twice', 422);
    end if;
    perform 1 from public.trip_members m
     where m.id = v_mid and m.trip_id = v_trip_id and (m.removed_at is null or v_mid = any (v_old_ids));
    if not found then
      perform private.api_error('validation_error', 'participant ' || v_mid || ' is not a current member of this trip', 422);
    end if;
    v_ids := v_ids || v_mid;
    if v_new.split_method = 'exact' then
      v_shares := v_shares || private.j_minor(v_el, 'share_amount', true, 0);
    end if;
  end loop;

  v_n := cardinality(v_ids);
  if v_n > 0 and v_new.split_method = 'equal' then
    -- AA: server computes; remainder units to members in ascending trip_members.id order
    select array_agg(x order by x) into v_ids from unnest(v_ids) as x;
    v_q := v_new.amount / v_n;
    v_r := v_new.amount % v_n;
    v_shares := '{}';
    for i in 1..v_n loop
      v_shares := v_shares || (v_q + case when i <= v_r then 1 else 0 end);
    end loop;
  elsif v_n > 0 then
    -- AB: typed shares must add up exactly
    select sum(s) into v_sum from unnest(v_shares) as s;
    if v_sum <> v_new.amount then
      perform private.api_error('share_sum_mismatch',
        format('Shares add up to %s but the amount is %s', v_sum, v_new.amount), 422);
    end if;
  end if;

  -- 5. lock FX: past date -> that date's rate (nearest earlier stored day if the
  -- exact day is missing; earliest stored rate if the date predates the
  -- history); today / future -> latest rate. Only on create or when amount,
  -- currency or local_date changed.
  if v_id is null or (v_old.amount, v_old.currency, v_old.local_date)
                     is distinct from (v_new.amount, v_new.currency, v_new.local_date) then
    if v_new.currency = 'HKD' then
      v_new.fx_rate_to_hkd := 1;
      v_new.fx_rate_date   := least(v_new.local_date, v_today);
    else
      select r.rate, r.rate_date into v_new.fx_rate_to_hkd, v_new.fx_rate_date
      from public.fx_rates r
      where r.base_currency = v_new.currency and r.quote_currency = 'HKD'
        and (v_new.local_date >= v_today or r.rate_date <= v_new.local_date)
      order by r.rate_date desc
      limit 1;
      if v_new.fx_rate_to_hkd is null and v_new.local_date < v_today then
        select r.rate, r.rate_date into v_new.fx_rate_to_hkd, v_new.fx_rate_date
        from public.fx_rates r
        where r.base_currency = v_new.currency and r.quote_currency = 'HKD'
        order by r.rate_date asc
        limit 1;
      end if;
      if v_new.fx_rate_to_hkd is null then
        perform private.api_error('fx_rate_missing', 'No exchange rate to HKD is available for ' || v_new.currency, 422);
      end if;
    end if;
    -- exact numeric: amount * 10^-decimals * rate * 100, rounded to HKD cents
    v_hkd := round(v_new.amount::numeric * v_new.fx_rate_to_hkd * 100 / (10::numeric ^ v_decimals));
    if v_hkd > 2147483647 then
      perform private.api_error('validation_error', 'amount is too large', 422);
    end if;
    v_new.amount_hkd := v_hkd::integer;
  else
    v_new.fx_rate_to_hkd := v_old.fx_rate_to_hkd;
    v_new.fx_rate_date   := v_old.fx_rate_date;
    v_new.amount_hkd     := v_old.amount_hkd;
  end if;

  -- write the row (8. updated_at is touched by trigger on update)
  if v_id is null then
    insert into public.expenses (
      id, trip_id, title, category, amount, currency, paid_by, occurred_at, timezone, all_day, local_date,
      end_date, location_text, latitude, longitude, photo_path, note, fx_rate_to_hkd, fx_rate_date,
      amount_hkd, currency_manually_set, split_method, created_by)
    values (
      v_new.id, v_new.trip_id, v_new.title, v_new.category, v_new.amount, v_new.currency, v_new.paid_by,
      v_new.occurred_at, v_new.timezone, v_new.all_day, v_new.local_date, v_new.end_date, v_new.location_text,
      v_new.latitude, v_new.longitude, v_new.photo_path, v_new.note, v_new.fx_rate_to_hkd,
      v_new.fx_rate_date, v_new.amount_hkd, v_new.currency_manually_set, v_new.split_method, v_uid)
    returning * into v_new;
  else
    update public.expenses e
       set title = v_new.title, category = v_new.category, amount = v_new.amount,
           currency = v_new.currency, paid_by = v_new.paid_by, occurred_at = v_new.occurred_at,
           timezone = v_new.timezone, all_day = v_new.all_day, local_date = v_new.local_date,
           end_date = v_new.end_date,
           location_text = v_new.location_text, latitude = v_new.latitude, longitude = v_new.longitude,
           photo_path = v_new.photo_path, note = v_new.note, fx_rate_to_hkd = v_new.fx_rate_to_hkd,
           fx_rate_date = v_new.fx_rate_date, amount_hkd = v_new.amount_hkd,
           currency_manually_set = v_new.currency_manually_set, split_method = v_new.split_method
     where e.id = v_id
    returning e.* into v_new;
  end if;

  -- 6/7. replace the participant set (equal <-> exact switches land here too)
  delete from public.expense_participants ep
   where ep.expense_id = v_new.id and not (ep.member_id = any (v_ids));
  insert into public.expense_participants as ep (expense_id, member_id, share_amount)
  select v_new.id, x.member_id, x.share_amount
  from unnest(v_ids, v_shares) as x (member_id, share_amount)
  on conflict (expense_id, member_id) do update
     set share_amount = excluded.share_amount
   where ep.share_amount is distinct from excluded.share_amount;

  -- 9/10. activity log + notifications (payer and To, old and new, not the actor)
  v_after := private.expense_json(v_new);
  if v_id is null then
    perform private.write_log(v_trip_id, 'create', 'expense', v_new.id, null, v_after);
    perform private.notify(v_trip_id, 'expense_added',
                           private.member_user_ids(v_ids || v_new.paid_by), private.expense_notice(v_new));
  elsif (v_before - 'updated_at') is distinct from (v_after - 'updated_at') then
    perform private.write_log(v_trip_id, 'update', 'expense', v_new.id, v_before, v_after);
    perform private.notify(v_trip_id, 'expense_updated',
                           private.member_user_ids(v_ids || v_old_ids || v_new.paid_by || v_old.paid_by),
                           private.expense_notice(v_new));
  end if;

  return v_after;
end;
$$;
