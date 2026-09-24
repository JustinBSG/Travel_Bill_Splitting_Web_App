-- =============================================================================
-- Triggers and shared server logic (requirement §7)
--
--   profiles_on_signup     auth.users INSERT -> profiles row
--   touch_updated_at       trips, expenses
--   prevent_hard_delete    expenses, settlements, activity_log (delete_trip
--                          cascade excepted); settlements + activity_log are
--                          also append-only
--   activity_log_writer    trips, trip_members, trip_days, trip_invites,
--                          settlements (expense rows are logged by the expense
--                          RPCs, which see participants before and after)
--   notification_writer    settlements, member join/claim, trip lock (expense
--                          notifications come from the expense RPCs)
--   send_push_hook         notifications INSERT -> send_push Edge Function
--
-- Trigger functions are SECURITY DEFINER because they write activity_log /
-- notifications, which clients can never write directly.
-- =============================================================================

-- create_trip / update_trip write one consolidated log entry and set this
-- transaction-local flag so the per-row trip / trip_days triggers stay quiet.
create or replace function private.rpc_logging() returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(current_setting('tbs.rpc_logging', true), '') = 'on';
$$;

-- True while delete_trip is removing this trip (lets cascades through the
-- hard-delete guard and keeps per-row triggers from logging into a dying trip).
create or replace function private.deleting_trip(tid uuid) returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(current_setting('tbs.deleting_trip', true), '') = tid::text;
$$;

-- -----------------------------------------------------------------------------
-- Snapshots and formatting
-- -----------------------------------------------------------------------------
create or replace function private.trip_snapshot(t public.trips) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'name', t.name, 'start_date', t.start_date, 'end_date', t.end_date,
    'joining_enabled', t.joining_enabled, 'is_locked', t.is_locked);
$$;

create or replace function private.expense_json(e public.expenses) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select to_jsonb(e) || jsonb_build_object(
    'expense_participants',
    coalesce((
      select jsonb_agg(jsonb_build_object('member_id', p.member_id, 'share_amount', p.share_amount)
                       order by p.member_id)
      from public.expense_participants p
      where p.expense_id = e.id
    ), '[]'::jsonb));
$$;

-- "3,000 JPY", "157.80 HKD" — plain, locale-neutral text for notification payloads.
create or replace function private.format_minor(amount bigint, currency text) returns text
language sql stable
set search_path = ''
as $$
  select case
    when c.decimals = 0 then to_char(amount, 'FM999,999,999,999,990')
    else to_char(amount::numeric / (10::numeric ^ c.decimals),
                 'FM999,999,999,999,990.' || repeat('0', c.decimals))
  end || ' ' || c.code
  from public.currencies c
  where c.code = currency;
$$;

-- -----------------------------------------------------------------------------
-- Activity log writer
-- -----------------------------------------------------------------------------
create or replace function private.write_log(
  p_trip_id uuid, p_action text, p_entity_type text, p_entity_id uuid,
  p_before jsonb, p_after jsonb
) returns void
language sql security definer
set search_path = ''
as $$
  insert into public.activity_log (trip_id, actor_member, action, entity_type, entity_id, before, after)
  values (p_trip_id, private.actor_member_id(p_trip_id), p_action, p_entity_type, p_entity_id,
          p_before, p_after);
$$;

-- -----------------------------------------------------------------------------
-- Notification writer. Recipients: current members with an account, never the
-- actor, and only where the user has not switched that type off.
-- -----------------------------------------------------------------------------
create or replace function private.member_user_ids(p_member_ids uuid[]) returns uuid[]
language sql stable security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct m.user_id), '{}')
  from public.trip_members m
  where m.id = any (p_member_ids) and m.user_id is not null and m.removed_at is null;
$$;

create or replace function private.trip_user_ids(p_trip_id uuid) returns uuid[]
language sql stable security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.user_id), '{}')
  from public.trip_members m
  where m.trip_id = p_trip_id and m.user_id is not null and m.removed_at is null;
$$;

create or replace function private.notify(
  p_trip_id uuid, p_type text, p_user_ids uuid[], p_extra jsonb default '{}'
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  select jsonb_build_object(
           'trip_id', t.id,
           'trip_name', t.name,
           'actor_member', private.actor_member_id(t.id),
           'actor_name', coalesce(
             (select m.display_name from public.trip_members m
              where m.trip_id = t.id and m.user_id = auth.uid()
              order by (m.removed_at is null) desc limit 1),
             (select nullif(p.display_name, '') from public.profiles p where p.id = auth.uid()))
         ) || coalesce(p_extra, '{}')
    into v_payload
  from public.trips t
  where t.id = p_trip_id;

  insert into public.notifications (user_id, trip_id, type, payload)
  select u.user_id, p_trip_id, p_type, v_payload
  from (select distinct x as user_id from unnest(p_user_ids) as x) u
  where u.user_id is not null
    and u.user_id is distinct from auth.uid()
    and exists (
      select 1 from public.trip_members m
      where m.trip_id = p_trip_id and m.user_id = u.user_id and m.removed_at is null)
    and not exists (
      select 1 from public.notification_settings s
      where s.user_id = u.user_id and s.type = p_type and not s.enabled);
end;
$$;

-- -----------------------------------------------------------------------------
-- profiles_on_signup: display_name from OAuth metadata when present, else ''
-- (the PWA asks for a name before trips can be created); language 'en' unless
-- the client passed a supported one in signup metadata.
-- -----------------------------------------------------------------------------
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  insert into public.profiles (id, display_name, language)
  values (
    new.id,
    left(btrim(coalesce(v_meta ->> 'display_name', v_meta ->> 'full_name', v_meta ->> 'name', '')), 60),
    case when v_meta ->> 'language' in ('en', 'zh-Hant') then v_meta ->> 'language' else 'en' end)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger profiles_on_signup
  after insert on auth.users
  for each row execute function private.handle_new_user();

create or replace function private.profiles_normalize() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.display_name := btrim(coalesce(new.display_name, ''));
  return new;
end;
$$;

create trigger profiles_normalize
  before insert or update on public.profiles
  for each row execute function private.profiles_normalize();

-- -----------------------------------------------------------------------------
-- touch_updated_at (expenses.updated_at is the optimistic-lock token, so it
-- uses clock time: two saves can never produce the same value)
-- -----------------------------------------------------------------------------
create or replace function private.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger trips_touch_updated_at
  before update on public.trips
  for each row execute function private.touch_updated_at();

create trigger expenses_touch_updated_at
  before update on public.expenses
  for each row execute function private.touch_updated_at();

-- -----------------------------------------------------------------------------
-- prevent_hard_delete / append-only
-- -----------------------------------------------------------------------------
create or replace function private.prevent_hard_delete() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if private.deleting_trip(old.trip_id) then
    return old;
  end if;
  perform private.api_error(
    'forbidden',
    case tg_table_name
      when 'expenses' then 'Expenses cannot be deleted; use soft_delete_expense'
      else initcap(replace(tg_table_name, '_', ' ')) || ' rows cannot be deleted'
    end,
    403);
  return null;
end;
$$;

create trigger expenses_prevent_hard_delete
  before delete on public.expenses
  for each row execute function private.prevent_hard_delete();
create trigger settlements_prevent_hard_delete
  before delete on public.settlements
  for each row execute function private.prevent_hard_delete();
create trigger activity_log_prevent_hard_delete
  before delete on public.activity_log
  for each row execute function private.prevent_hard_delete();

create or replace function private.prevent_update() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform private.api_error('forbidden',
    initcap(replace(tg_table_name, '_', ' ')) || ' rows cannot be changed', 403);
  return null;
end;
$$;

create trigger activity_log_append_only
  before update on public.activity_log
  for each row execute function private.prevent_update();
create trigger settlements_append_only
  before update on public.settlements
  for each row execute function private.prevent_update();

-- -----------------------------------------------------------------------------
-- trips: log lock / unlock / settings changes, notify on lock
-- -----------------------------------------------------------------------------
create or replace function private.trips_after_update() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.is_locked is distinct from old.is_locked then
    perform private.write_log(new.id, case when new.is_locked then 'lock' else 'unlock' end, 'trip', new.id,
                              jsonb_build_object('is_locked', old.is_locked),
                              jsonb_build_object('is_locked', new.is_locked));
    if new.is_locked then
      perform private.notify(new.id, 'trip_locked', private.trip_user_ids(new.id));
    end if;
  end if;

  if not private.rpc_logging()
     and (new.name, new.start_date, new.end_date, new.joining_enabled)
         is distinct from (old.name, old.start_date, old.end_date, old.joining_enabled) then
    perform private.write_log(new.id, 'update', 'trip', new.id,
                              private.trip_snapshot(old), private.trip_snapshot(new));
  end if;
  return null;
end;
$$;

create trigger trips_activity_log
  after update on public.trips
  for each row execute function private.trips_after_update();

-- -----------------------------------------------------------------------------
-- trip_members: normalise, then log + notify joins / claims / removals / roles
-- -----------------------------------------------------------------------------
create or replace function private.trip_members_normalize() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  new.display_name := btrim(new.display_name);
  if tg_op = 'UPDATE' and (new.trip_id <> old.trip_id or new.id <> old.id) then
    perform private.api_error('validation_error', 'A member cannot move between trips', 422);
  end if;
  return new;
end;
$$;

create trigger trip_members_normalize
  before insert or update on public.trip_members
  for each row execute function private.trip_members_normalize();

create or replace function private.trip_members_after_write() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_extra jsonb := jsonb_build_object('member_id', new.id, 'member_name', new.display_name);
begin
  if tg_op = 'INSERT' then
    if new.role = 'owner' then
      return null;  -- the creator; covered by create_trip's 'create' entry
    elsif new.user_id is null then
      perform private.write_log(new.trip_id, 'create', 'trip_member', new.id, null, to_jsonb(new));
    else
      perform private.write_log(new.trip_id, 'join', 'trip_member', new.id, null, to_jsonb(new));
      perform private.notify(new.trip_id, 'member_joined', private.trip_user_ids(new.trip_id), v_extra);
    end if;
    return null;
  end if;

  if old.user_id is null and new.user_id is not null then
    perform private.write_log(new.trip_id, 'claim', 'trip_member', new.id, to_jsonb(old), to_jsonb(new));
    perform private.notify(new.trip_id, 'placeholder_claimed', private.trip_user_ids(new.trip_id),
                           v_extra || jsonb_build_object('placeholder_name', old.display_name));
  elsif old.removed_at is null and new.removed_at is not null then
    perform private.write_log(new.trip_id,
                              case when new.user_id = auth.uid() then 'leave' else 'remove' end,
                              'trip_member', new.id, to_jsonb(old), to_jsonb(new));
  elsif old.removed_at is not null and new.removed_at is null then
    perform private.write_log(new.trip_id, 'join', 'trip_member', new.id, to_jsonb(old), to_jsonb(new));
    perform private.notify(new.trip_id, 'member_joined', private.trip_user_ids(new.trip_id), v_extra);
  elsif old.role is distinct from new.role then
    perform private.write_log(new.trip_id, 'role_change', 'trip_member', new.id, to_jsonb(old), to_jsonb(new));
  elsif to_jsonb(old) is distinct from to_jsonb(new) then
    perform private.write_log(new.trip_id, 'update', 'trip_member', new.id, to_jsonb(old), to_jsonb(new));
  end if;
  return null;
end;
$$;

create trigger trip_members_activity_log
  after insert or update on public.trip_members
  for each row execute function private.trip_members_after_write();

-- -----------------------------------------------------------------------------
-- trip_days: exactly one row per trip date. Direct admin edits may change a
-- date's location; changing the range is update_trip's job.
-- -----------------------------------------------------------------------------
create or replace function private.trip_days_before_write() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_trip public.trips;
begin
  select t.* into v_trip from public.trips t where t.id = coalesce(new.trip_id, old.trip_id);

  if tg_op = 'DELETE' then
    if v_trip.id is not null and not private.deleting_trip(old.trip_id)
       and old.date between v_trip.start_date and v_trip.end_date then
      perform private.api_error('validation_error',
        'Every trip date needs a location; change the trip dates with update_trip instead', 422);
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and (new.trip_id <> old.trip_id or new.date <> old.date) then
    perform private.api_error('validation_error', 'trip_id and date of a trip day cannot change', 422);
  end if;
  if v_trip.id is null or new.date not between v_trip.start_date and v_trip.end_date then
    perform private.api_error('validation_error', 'date ' || new.date || ' is outside the trip dates', 422);
  end if;

  new.location_name := btrim(new.location_name);
  new.country_code  := upper(btrim(new.country_code));
  new.currency      := upper(btrim(new.currency));
  new.timezone      := btrim(new.timezone);
  if not private.is_valid_timezone(new.timezone) then
    perform private.api_error('validation_error', 'timezone must be an IANA name such as Asia/Tokyo', 422);
  end if;
  if not exists (select 1 from public.currencies c where c.code = new.currency) then
    perform private.api_error('validation_error', 'Unknown currency ' || new.currency, 422);
  end if;
  return new;
end;
$$;

create trigger trip_days_validate
  before insert or update or delete on public.trip_days
  for each row execute function private.trip_days_before_write();

create or replace function private.trip_days_after_write() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if private.rpc_logging() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform private.write_log(new.trip_id, 'create', 'trip_day', null, null, to_jsonb(new));
  elsif tg_op = 'UPDATE' then
    if to_jsonb(old) is distinct from to_jsonb(new) then
      perform private.write_log(new.trip_id, 'update', 'trip_day', null, to_jsonb(old), to_jsonb(new));
    end if;
  elsif not private.deleting_trip(old.trip_id)
        and exists (select 1 from public.trips t where t.id = old.trip_id) then
    perform private.write_log(old.trip_id, 'delete', 'trip_day', null, to_jsonb(old), null);
  end if;
  return null;
end;
$$;

create trigger trip_days_activity_log
  after insert or update or delete on public.trip_days
  for each row execute function private.trip_days_after_write();

-- -----------------------------------------------------------------------------
-- trip_invites: log rotation WITHOUT the secrets
-- -----------------------------------------------------------------------------
create or replace function private.trip_invites_after_update() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if (new.invite_token, new.invite_code) is distinct from (old.invite_token, old.invite_code) then
    perform private.write_log(new.trip_id, 'invite_regen', 'trip_invite', new.trip_id, null, null);
  end if;
  return null;
end;
$$;

create trigger trip_invites_activity_log
  after update on public.trip_invites
  for each row execute function private.trip_invites_after_update();

-- -----------------------------------------------------------------------------
-- settlements: validate (direct POST and record_settlement share this), then
-- log + notify the receiver
-- -----------------------------------------------------------------------------
create or replace function private.settlements_before_insert() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  new.debt_currency   := upper(btrim(new.debt_currency));
  new.paid_currency   := upper(btrim(new.paid_currency));
  new.idempotency_key := btrim(new.idempotency_key);
  new.paid_at         := coalesce(new.paid_at, now());

  if v_uid is not null then
    new.created_by := v_uid;
    if not private.is_trip_member(new.trip_id) then
      perform private.api_error('forbidden', 'You are not a member of this trip', 403);
    end if;
    if private.trip_is_locked(new.trip_id) then
      perform private.api_error('trip_locked', 'This trip is locked', 423);
    end if;
  elsif new.created_by is null then
    perform private.api_error('unauthenticated', 'Sign in first', 401);
  end if;

  if (select count(*) from public.trip_members m
      where m.trip_id = new.trip_id and m.id in (new.from_member, new.to_member)) <> 2 then
    perform private.api_error('validation_error',
      'from_member and to_member must be two different members of this trip', 422);
  end if;
  if not exists (select 1 from public.currencies c where c.code = new.debt_currency)
     or not exists (select 1 from public.currencies c where c.code = new.paid_currency) then
    perform private.api_error('validation_error', 'Unknown currency', 422);
  end if;
  if new.paid_currency <> new.debt_currency and new.fx_rate is null then
    perform private.api_error('validation_error',
      'fx_rate is required when paid_currency differs from debt_currency', 422);
  end if;
  if new.paid_currency = new.debt_currency
     and (new.paid_amount <> new.debt_amount or coalesce(new.fx_rate, 1) <> 1) then
    perform private.api_error('validation_error',
      'A same-currency repayment must pay exactly debt_amount (fx_rate 1 or null)', 422);
  end if;
  return new;
end;
$$;

create trigger settlements_validate
  before insert on public.settlements
  for each row execute function private.settlements_before_insert();

create or replace function private.settlements_after_insert() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform private.write_log(new.trip_id, 'create', 'settlement', new.id, null, to_jsonb(new));
  perform private.notify(new.trip_id, 'settlement_received', private.member_user_ids(array[new.to_member]),
    jsonb_build_object(
      'settlement_id', new.id, 'from_member', new.from_member, 'to_member', new.to_member,
      'debt_amount', new.debt_amount, 'debt_currency', new.debt_currency,
      'paid_amount', new.paid_amount, 'paid_currency', new.paid_currency,
      'amount_display', private.format_minor(new.paid_amount, new.paid_currency)));
  return null;
end;
$$;

create trigger settlements_activity_log
  after insert on public.settlements
  for each row execute function private.settlements_after_insert();

-- -----------------------------------------------------------------------------
-- send_push_hook: notifications INSERT -> POST /functions/v1/send_push via
-- pg_net (async, sent after commit). Needs Vault secrets `project_url` and
-- `push_webhook_secret` (see backend/README.md). A missing secret or pg_net
-- never blocks the business write.
-- -----------------------------------------------------------------------------
create or replace function private.vault_secret(secret_name text) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v text;
begin
  select ds.decrypted_secret into v from vault.decrypted_secrets ds where ds.name = secret_name limit 1;
  return v;
exception when others then
  return null;  -- Vault not installed (e.g. the local test harness)
end;
$$;

create or replace function private.call_edge_function(
  fn text, body jsonb, secret_name text, secret_header text
) returns bigint
language plpgsql security definer
set search_path = ''
as $$
declare
  v_url    text := private.vault_secret('project_url');
  v_secret text := private.vault_secret(secret_name);
begin
  if v_url is null or v_secret is null then
    raise warning 'Edge Function % not called: Vault secret project_url or % is missing', fn, secret_name;
    return null;
  end if;
  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/' || fn,
    body := body,
    headers := jsonb_build_object('Content-Type', 'application/json', secret_header, v_secret),
    timeout_milliseconds := 10000);
exception when others then
  raise warning 'Edge Function % not called: %', fn, sqlerrm;
  return null;
end;
$$;

create or replace function private.notifications_send_push() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.push_subscriptions s where s.user_id = new.user_id) then
    perform private.call_edge_function(
      'send_push',
      jsonb_build_object('type', 'INSERT', 'schema', 'public', 'table', 'notifications',
                         'record', to_jsonb(new)),
      'push_webhook_secret', 'x-webhook-secret');
  end if;
  return null;
end;
$$;

create trigger notifications_send_push
  after insert on public.notifications
  for each row execute function private.notifications_send_push();
