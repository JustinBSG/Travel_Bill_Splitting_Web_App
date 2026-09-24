-- =============================================================================
-- Travel Bill Split — core schema (docs/backend-requirement.txt §4)
--
--   * Money is integer minor units (integer columns). FX rates are numeric.
--   * Enums are text + CHECK (stable for PostgREST).
--   * Invite secrets live in trip_invites, never on trips.
--   * Every trip_id FK cascades so delete_trip can remove a whole trip; the
--     prevent_hard_delete trigger (next migrations) blocks every other delete
--     on expenses / settlements / activity_log. FKs that point at
--     trip_members are checked at commit (deferred), because a trip delete
--     cascades to members and to their referencing rows in no fixed order.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- Internal helpers live here. Not in the PostgREST `schemas` list, so nothing
-- in it is reachable over REST.
create schema if not exists private;
revoke all on schema private from public;

-- -----------------------------------------------------------------------------
-- 4.14 currencies (reference data, seeded below)
-- -----------------------------------------------------------------------------
create table public.currencies (
  code     text primary key check (code ~ '^[A-Z]{3}$'),
  decimals integer not null check (decimals between 0 and 3),
  symbol   text not null
);

-- -----------------------------------------------------------------------------
-- 4.1 profiles
--   appearance (System/Light/Dark) and colour theme (Washi/Classic) are
--   device-local: deliberately no columns for them.
-- -----------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 60),
  language     text not null default 'en' check (language in ('en', 'zh-Hant')),
  created_at   timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 4.2 trips
-- -----------------------------------------------------------------------------
create table public.trips (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (char_length(btrim(name)) between 1 and 100),
  start_date      date not null,
  end_date        date not null,
  base_currency   text not null default 'HKD' check (base_currency = 'HKD'),
  home_timezone   text not null default 'Asia/Hong_Kong' check (home_timezone = 'Asia/Hong_Kong'),
  joining_enabled boolean not null default true,
  is_locked       boolean not null default false,
  created_by      uuid not null references public.profiles (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (end_date >= start_date)
);

-- -----------------------------------------------------------------------------
-- 4.3 trip_invites — secrets. SELECT is admin-only (RLS); rotated only by
-- regenerate_invite.
-- -----------------------------------------------------------------------------
create table public.trip_invites (
  trip_id      uuid primary key references public.trips (id) on delete cascade,
  invite_token text not null unique check (char_length(invite_token) >= 32),
  -- 6 chars, alphabet without 0 O 1 I
  invite_code  text not null unique check (invite_code ~ '^[2-9A-HJ-NP-Z]{6}$'),
  created_at   timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 4.4 trip_days — exactly one row per date in [start_date, end_date]
-- -----------------------------------------------------------------------------
create table public.trip_days (
  trip_id       uuid not null references public.trips (id) on delete cascade,
  date          date not null,
  location_name text not null check (char_length(btrim(location_name)) between 1 and 200),
  country_code  text not null check (country_code ~ '^[A-Z]{2}$'),
  latitude      double precision not null check (latitude between -90 and 90),
  longitude     double precision not null check (longitude between -180 and 180),
  timezone      text not null,                                   -- IANA, e.g. Asia/Tokyo
  currency      text not null references public.currencies (code), -- ISO 4217
  primary key (trip_id, date)
);

-- -----------------------------------------------------------------------------
-- 4.5 trip_members — user_id NULL = placeholder
-- -----------------------------------------------------------------------------
create table public.trip_members (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references public.trips (id) on delete cascade,
  user_id      uuid references public.profiles (id),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  role         text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at    timestamptz not null default now(),
  removed_at   timestamptz,
  -- a placeholder has no account, so it can only be a plain member
  check (user_id is not null or role = 'member'),
  -- target for the composite FKs below (paid_by / settlement members stay in-trip)
  unique (trip_id, id)
);

create unique index trip_members_one_active_membership
  on public.trip_members (trip_id, user_id)
  where user_id is not null and removed_at is null;

create unique index trip_members_one_owner
  on public.trip_members (trip_id)
  where role = 'owner';

-- -----------------------------------------------------------------------------
-- 4.6 expenses
-- -----------------------------------------------------------------------------
create table public.expenses (
  id                    uuid primary key default gen_random_uuid(),
  trip_id               uuid not null references public.trips (id) on delete cascade,
  title                 text not null check (char_length(btrim(title)) between 1 and 200),
  category              text not null check (category in (
                          'Food & Drink', 'Transport', 'Accommodation',
                          'Activities & Tickets', 'Shopping', 'Groceries',
                          'Loan', 'Other')),
  amount                integer not null check (amount > 0),
  currency              text not null references public.currencies (code),
  paid_by               uuid not null,
  occurred_at           timestamptz not null,
  timezone              text not null,
  local_date            date not null,                 -- server-computed
  end_date              date,                          -- multi-day, inclusive
  location_text         text check (char_length(location_text) <= 300),
  latitude              double precision check (latitude between -90 and 90),
  longitude             double precision check (longitude between -180 and 180),
  photo_path            text,
  note                  text check (char_length(note) <= 2000),
  fx_rate_to_hkd        numeric not null check (fx_rate_to_hkd > 0), -- server-locked
  fx_rate_date          date not null,
  amount_hkd            integer not null check (amount_hkd >= 0),   -- HKD cents
  currency_manually_set boolean not null default false,
  split_method          text not null default 'equal' check (split_method in ('equal', 'exact')),
  created_by            uuid not null references public.profiles (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),         -- optimistic lock
  deleted_at            timestamptz,
  check (end_date is null or end_date >= local_date),
  check ((latitude is null) = (longitude is null)),
  foreign key (trip_id, paid_by) references public.trip_members (trip_id, id) deferrable initially deferred
);

-- -----------------------------------------------------------------------------
-- 4.7 expense_participants — zero rows on an expense = personal expense
-- -----------------------------------------------------------------------------
create table public.expense_participants (
  expense_id   uuid not null references public.expenses (id) on delete cascade,
  member_id    uuid not null references public.trip_members (id) deferrable initially deferred,
  share_amount integer not null check (share_amount >= 0),
  primary key (expense_id, member_id)
);

-- -----------------------------------------------------------------------------
-- 4.8 settlements — the only repayment facts. No UPDATE / DELETE in v1.
--   fx_rate = paid_currency per 1 major unit of debt_currency.
-- -----------------------------------------------------------------------------
create table public.settlements (
  id              uuid primary key default gen_random_uuid(),
  trip_id         uuid not null references public.trips (id) on delete cascade,
  from_member     uuid not null,
  to_member       uuid not null,
  debt_currency   text not null references public.currencies (code),
  debt_amount     integer not null check (debt_amount > 0),
  paid_currency   text not null references public.currencies (code),
  paid_amount     integer not null check (paid_amount > 0),
  fx_rate         numeric check (fx_rate > 0),
  paid_at         timestamptz not null,
  created_by      uuid not null references public.profiles (id),
  created_at      timestamptz not null default now(),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  unique (trip_id, idempotency_key),
  check (from_member <> to_member),
  -- fx_rate is required when the currencies differ ...
  check (paid_currency = debt_currency or fx_rate is not null),
  -- ... and a same-currency repayment pays exactly what it clears
  check (paid_currency <> debt_currency or (paid_amount = debt_amount and (fx_rate is null or fx_rate = 1))),
  foreign key (trip_id, from_member) references public.trip_members (trip_id, id) deferrable initially deferred,
  foreign key (trip_id, to_member) references public.trip_members (trip_id, id) deferrable initially deferred
);

-- -----------------------------------------------------------------------------
-- 4.9 activity_log — append-only, written by triggers / RPCs only
-- -----------------------------------------------------------------------------
create table public.activity_log (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references public.trips (id) on delete cascade,
  actor_member uuid references public.trip_members (id) deferrable initially deferred,
  action       text not null,   -- create|update|delete|restore|join|claim|leave|remove|
                                -- lock|unlock|invite_regen|role_change
  entity_type  text not null,   -- trip|trip_day|trip_member|trip_invite|expense|settlement
  entity_id    uuid,
  before       jsonb,
  after        jsonb,
  -- clock time so several rows written by one transaction keep their order
  created_at   timestamptz not null default clock_timestamp()
);

-- -----------------------------------------------------------------------------
-- 4.10 notifications / 4.11 notification_settings / 4.12 push_subscriptions
-- -----------------------------------------------------------------------------
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  trip_id    uuid not null references public.trips (id) on delete cascade,
  type       text not null check (type in (
               'expense_added', 'expense_updated', 'expense_deleted',
               'settlement_received', 'member_joined', 'placeholder_claimed',
               'trip_locked')),
  payload    jsonb not null default '{}',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create table public.notification_settings (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  type    text not null check (type in (
            'expense_added', 'expense_updated', 'expense_deleted',
            'settlement_received', 'member_joined', 'placeholder_claimed',
            'trip_locked')),
  enabled boolean not null default true,
  primary key (user_id, type)
);

create table public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  endpoint   text not null check (endpoint ~ '^https://' and char_length(endpoint) <= 2048),
  keys       jsonb not null check (
               jsonb_typeof(keys -> 'p256dh') = 'string' and jsonb_typeof(keys -> 'auth') = 'string'),
  created_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

-- -----------------------------------------------------------------------------
-- 4.13 fx_rates — 1 base_currency = rate quote_currency (mid-market)
-- -----------------------------------------------------------------------------
create table public.fx_rates (
  rate_date      date not null,
  base_currency  text not null check (base_currency ~ '^[A-Z]{3}$'),
  quote_currency text not null check (quote_currency ~ '^[A-Z]{3}$'),
  rate           numeric not null check (rate > 0),
  source         text not null,
  primary key (rate_date, base_currency, quote_currency)
);

-- -----------------------------------------------------------------------------
-- join_trip rate limiting (private; written by join_trip_as only).
-- Stores hashes, never the attempted code/token or the raw IP.
-- -----------------------------------------------------------------------------
create table private.join_attempts (
  id          bigint generated always as identity primary key,
  user_id     uuid not null,
  client_hash text,
  target_hash text,
  outcome     text not null check (outcome in ('invalid', 'valid', 'blocked')),
  created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Indexes (requirement §4 "Required indexes" + FK / RLS lookups)
-- -----------------------------------------------------------------------------
create index expenses_trip_deleted_date   on public.expenses (trip_id, deleted_at, local_date);
create index expenses_trip_updated        on public.expenses (trip_id, updated_at);
create index expense_participants_member  on public.expense_participants (member_id);
create index settlements_trip             on public.settlements (trip_id);
create index trip_members_active_by_trip  on public.trip_members (trip_id) where removed_at is null;
create index trip_members_active_by_user  on public.trip_members (user_id) where removed_at is null;
create index activity_log_trip_created    on public.activity_log (trip_id, created_at desc);
create index notifications_user_created   on public.notifications (user_id, created_at desc);
create index fx_rates_pair_date           on public.fx_rates (base_currency, quote_currency, rate_date desc);
create index join_attempts_user_created   on private.join_attempts (user_id, created_at);
create index join_attempts_client_created on private.join_attempts (client_hash, created_at);

-- Realtime payloads for UPDATE (soft delete) / DELETE carry the old row.
alter table public.expenses             replica identity full;
alter table public.expense_participants replica identity full;

-- -----------------------------------------------------------------------------
-- Seed: currencies. ISO 4217 minor units, except TWD = 0 (required seed: NT$
-- has no cents in practice). Covers every currency the web app's
-- country -> currency table can produce, so any picked city can be a trip day.
-- NEVER change `decimals` for a code once expenses exist in it.
-- -----------------------------------------------------------------------------
insert into public.currencies (code, decimals, symbol) values
  ('HKD', 2, 'HK$'), ('JPY', 0, '¥'),   ('KRW', 0, '₩'),   ('TWD', 0, 'NT$'),
  ('CNY', 2, '¥'),   ('USD', 2, 'US$'), ('EUR', 2, '€'),   ('GBP', 2, '£'),
  ('SGD', 2, 'S$'),  ('THB', 2, '฿'),   ('VND', 0, '₫'),   ('MYR', 2, 'RM'),
  ('AUD', 2, 'A$'),  ('MOP', 2, 'MOP$'),('PHP', 2, '₱'),   ('IDR', 2, 'Rp'),
  ('NZD', 2, 'NZ$'), ('CAD', 2, 'C$'),  ('CHF', 2, 'CHF'), ('INR', 2, '₹'),
  ('AED', 2, 'AED'), ('AFN', 2, 'AFN'), ('ALL', 2, 'ALL'), ('AMD', 2, 'AMD'),
  ('ANG', 2, 'ANG'), ('AOA', 2, 'AOA'), ('ARS', 2, 'ARS'), ('AWG', 2, 'AWG'),
  ('AZN', 2, 'AZN'), ('BAM', 2, 'BAM'), ('BBD', 2, 'BBD'), ('BDT', 2, '৳'),
  ('BGN', 2, 'BGN'), ('BHD', 3, 'BHD'), ('BIF', 0, 'BIF'), ('BMD', 2, 'BMD'),
  ('BND', 2, 'B$'),  ('BOB', 2, 'BOB'), ('BRL', 2, 'R$'),  ('BSD', 2, 'BSD'),
  ('BTN', 2, 'BTN'), ('BWP', 2, 'BWP'), ('BYN', 2, 'BYN'), ('BZD', 2, 'BZD'),
  ('CDF', 2, 'CDF'), ('CLP', 0, 'CLP'), ('COP', 2, 'COP'), ('CRC', 2, '₡'),
  ('CUP', 2, 'CUP'), ('CVE', 2, 'CVE'), ('CZK', 2, 'Kč'),  ('DJF', 0, 'DJF'),
  ('DKK', 2, 'kr'),  ('DOP', 2, 'DOP'), ('DZD', 2, 'DZD'), ('EGP', 2, 'E£'),
  ('ERN', 2, 'ERN'), ('ETB', 2, 'ETB'), ('FJD', 2, 'FJ$'), ('FKP', 2, 'FKP'),
  ('GEL', 2, '₾'),   ('GHS', 2, 'GH₵'), ('GIP', 2, 'GIP'), ('GMD', 2, 'GMD'),
  ('GNF', 0, 'GNF'), ('GTQ', 2, 'GTQ'), ('GYD', 2, 'GYD'), ('HNL', 2, 'HNL'),
  ('HTG', 2, 'HTG'), ('HUF', 2, 'Ft'),  ('ILS', 2, '₪'),   ('IQD', 3, 'IQD'),
  ('IRR', 2, 'IRR'), ('ISK', 0, 'kr'),  ('JMD', 2, 'J$'),  ('JOD', 3, 'JOD'),
  ('KES', 2, 'KSh'), ('KGS', 2, 'KGS'), ('KHR', 2, '៛'),   ('KMF', 0, 'KMF'),
  ('KPW', 2, 'KPW'), ('KWD', 3, 'KWD'), ('KYD', 2, 'KYD'), ('KZT', 2, '₸'),
  ('LAK', 2, '₭'),   ('LBP', 2, 'LBP'), ('LKR', 2, 'Rs'),  ('LRD', 2, 'LRD'),
  ('LSL', 2, 'LSL'), ('LYD', 3, 'LYD'), ('MAD', 2, 'MAD'), ('MDL', 2, 'MDL'),
  ('MGA', 2, 'MGA'), ('MKD', 2, 'MKD'), ('MMK', 2, 'K'),   ('MNT', 2, '₮'),
  ('MRU', 2, 'MRU'), ('MUR', 2, 'MUR'), ('MVR', 2, 'MVR'), ('MWK', 2, 'MWK'),
  ('MXN', 2, 'MX$'), ('MZN', 2, 'MZN'), ('NAD', 2, 'NAD'), ('NGN', 2, '₦'),
  ('NIO', 2, 'NIO'), ('NOK', 2, 'kr'),  ('NPR', 2, 'Rs'),  ('OMR', 3, 'OMR'),
  ('PAB', 2, 'PAB'), ('PEN', 2, 'S/'),  ('PGK', 2, 'PGK'), ('PKR', 2, 'Rs'),
  ('PLN', 2, 'zł'),  ('PYG', 0, 'PYG'), ('QAR', 2, 'QAR'), ('RON', 2, 'lei'),
  ('RSD', 2, 'RSD'), ('RUB', 2, '₽'),   ('RWF', 0, 'RWF'), ('SAR', 2, 'SAR'),
  ('SBD', 2, 'SBD'), ('SCR', 2, 'SCR'), ('SDG', 2, 'SDG'), ('SEK', 2, 'kr'),
  ('SHP', 2, 'SHP'), ('SLE', 2, 'SLE'), ('SOS', 2, 'SOS'), ('SRD', 2, 'SRD'),
  ('SSP', 2, 'SSP'), ('STN', 2, 'STN'), ('SYP', 2, 'SYP'), ('SZL', 2, 'SZL'),
  ('TJS', 2, 'TJS'), ('TMT', 2, 'TMT'), ('TND', 3, 'TND'), ('TOP', 2, 'T$'),
  ('TRY', 2, '₺'),   ('TTD', 2, 'TT$'), ('TZS', 2, 'TSh'), ('UAH', 2, '₴'),
  ('UGX', 0, 'USh'), ('UYU', 2, '$U'),  ('UZS', 2, 'UZS'), ('VES', 2, 'Bs'),
  ('VUV', 0, 'VT'),  ('WST', 2, 'WS$'), ('XAF', 0, 'FCFA'),('XCD', 2, 'EC$'),
  ('XOF', 0, 'CFA'), ('XPF', 0, 'XPF'), ('YER', 2, 'YER'), ('ZAR', 2, 'R'),
  ('ZMW', 2, 'ZMW'), ('ZWL', 2, 'ZWL');
