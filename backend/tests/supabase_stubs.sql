-- Minimal stand-ins for the Supabase platform objects the migrations touch, so
-- they can run on a bare Postgres (PGlite) in tests. NOT deployed anywhere.
--   roles       anon / authenticated / service_role
--   auth        users table + auth.uid() (same claim lookup as Supabase)
--   storage     buckets / objects (RLS on, as on Supabase)
--   vault       decrypted_secrets view over a plain table
--   net         pg_net http_post / http_delete that just record the request
--   cron        pg_cron schedule() that records the job

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema extensions;
create schema auth;
create schema storage;
create schema vault;
create schema net;
create schema cron;

grant usage on schema public, auth, extensions, storage to anon, authenticated, service_role;

create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at         timestamptz default now()
);

create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

create table storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz default now()
);
create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text not null,
  owner      uuid,
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to authenticated, service_role;
grant select on storage.buckets to authenticated, service_role;

create table vault.secrets (name text primary key, secret text not null);
create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;

create table net.requests (
  id      bigint generated always as identity primary key,
  method  text,
  url     text,
  body    jsonb,
  headers jsonb
);
create function net.http_post(
  url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 2000
) returns bigint
language sql
as $$
  insert into net.requests (method, url, body, headers) values ('POST', url, body, headers) returning id;
$$;
create function net.http_delete(
  url text, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb,
  timeout_milliseconds integer default 2000
) returns bigint
language sql
as $$
  insert into net.requests (method, url, headers) values ('DELETE', url, headers) returning id;
$$;

create table cron.job (jobname text primary key, schedule text, command text);
create function cron.schedule(job_name text, schedule text, command text) returns bigint
language sql
as $$
  insert into cron.job values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning 1::bigint;
$$;
