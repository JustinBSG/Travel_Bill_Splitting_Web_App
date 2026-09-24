-- =============================================================================
-- Storage: private photo-proof bucket (requirement §5.L)
--
--   Bucket  trip-photos  PRIVATE, 5 MB max, images only
--   Path    {trip_id}/{expense_id}/{uuid}.jpg
--   Access  signed URLs only; members of the trip in the first path segment
--           may read, and may upload/delete while the trip is unlocked.
--           No public access, no listing outside your own trips.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('trip-photos', 'trip-photos', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "trip-photos: members read" on storage.objects;
create policy "trip-photos: members read" on storage.objects
  for select to authenticated
  using (bucket_id = 'trip-photos' and private.is_trip_member(private.path_trip_id(name)));

drop policy if exists "trip-photos: members upload while unlocked" on storage.objects;
create policy "trip-photos: members upload while unlocked" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'trip-photos'
    and private.photo_path_ok(name)
    and private.is_trip_member(private.path_trip_id(name))
    and not private.trip_is_locked(private.path_trip_id(name))
  );

drop policy if exists "trip-photos: members delete while unlocked" on storage.objects;
create policy "trip-photos: members delete while unlocked" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'trip-photos'
    and private.is_trip_member(private.path_trip_id(name))
    and not private.trip_is_locked(private.path_trip_id(name))
  );

-- -----------------------------------------------------------------------------
-- delete_trip support. Deleting storage.objects rows in SQL would orphan the
-- files, so each object is removed through the Storage API instead:
-- DELETE /storage/v1/object/trip-photos/{name} via pg_net, sent after commit.
-- Needs Vault secrets `project_url` and `service_role_key`.
-- -----------------------------------------------------------------------------
create or replace function private.trip_photo_names(tid uuid) returns text[]
language sql stable security definer
set search_path = ''
as $$
  select coalesce(array_agg(o.name order by o.name), '{}')
  from storage.objects o
  where o.bucket_id = 'trip-photos' and o.name like tid::text || '/%';
$$;

create or replace function private.queue_photo_deletes(names text[]) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_url  text := private.vault_secret('project_url');
  v_key  text := private.vault_secret('service_role_key');
  v_name text;
  v_n    integer := 0;
begin
  if coalesce(cardinality(names), 0) = 0 then
    return 0;
  end if;
  if v_url is null or v_key is null then
    raise warning 'trip photos not deleted: Vault secret project_url or service_role_key is missing (% objects)',
      cardinality(names);
    return 0;
  end if;
  foreach v_name in array names loop
    perform net.http_delete(
      url := rtrim(v_url, '/') || '/storage/v1/object/trip-photos/' || v_name,
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'apikey', v_key),
      timeout_milliseconds := 10000);
    v_n := v_n + 1;
  end loop;
  return v_n;
exception when others then
  raise warning 'trip photos not deleted: %', sqlerrm;
  return 0;
end;
$$;
