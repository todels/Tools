-- Font Sync MVP — backend schema
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query -> Run).
-- Safe to re-run: everything is idempotent.

-- ---------------------------------------------------------------------------
-- 1. Metadata table
-- ---------------------------------------------------------------------------
create table if not exists public.fonts (
  id                uuid primary key default gen_random_uuid(),

  -- Human-readable names, exactly as they appear in the font's `name` table.
  -- These are what we show in the UI.
  family            text not null,
  style             text not null,
  postscript_name   text,

  -- Normalised lookup keys (lowercased, whitespace collapsed). Figma hands us
  -- {family, style} strings, so matching happens on these, never on `family`.
  family_key        text not null,
  style_key         text not null,

  file_name         text not null,
  file_hash         text not null,          -- sha256 of the file bytes
  file_size         bigint not null,
  format            text not null,          -- ttf | otf | ttc | otc

  storage_path      text not null,          -- path inside the `fonts` bucket

  uploader          text not null,          -- email, denormalised for display
  uploader_id       uuid not null references auth.users(id) on delete cascade,
  project_tag       text,

  -- Licensing gate. The RLS insert policy below refuses rows where this is
  -- false, so "I confirm I have the rights" is enforced by the database and
  -- not just by the desktop UI.
  license_confirmed boolean not null default false,

  created_at        timestamptz not null default now()
);

-- One row per (family, style, file). A .ttc collection legitimately produces
-- several rows sharing one file_hash, which is why the hash alone is not the
-- key. Re-uploading the identical file is a no-op via ON CONFLICT.
create unique index if not exists fonts_family_style_hash_idx
  on public.fonts (family_key, style_key, file_hash);

create index if not exists fonts_family_key_idx on public.fonts (family_key);
create index if not exists fonts_lookup_idx     on public.fonts (family_key, style_key);
create index if not exists fonts_uploader_idx   on public.fonts (uploader_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Row level security
-- ---------------------------------------------------------------------------
alter table public.fonts enable row level security;

-- Everyone signed in can see the whole team library (that is the point).
drop policy if exists "fonts_select_authenticated" on public.fonts;
create policy "fonts_select_authenticated"
  on public.fonts for select
  to authenticated
  using (true);

-- You may only insert rows attributed to yourself, and only if the rights
-- checkbox was ticked.
drop policy if exists "fonts_insert_own_confirmed" on public.fonts;
create policy "fonts_insert_own_confirmed"
  on public.fonts for insert
  to authenticated
  with check (uploader_id = auth.uid() and license_confirmed = true);

-- Retagging / removing is limited to your own uploads.
drop policy if exists "fonts_update_own" on public.fonts;
create policy "fonts_update_own"
  on public.fonts for update
  to authenticated
  using (uploader_id = auth.uid())
  with check (uploader_id = auth.uid() and license_confirmed = true);

drop policy if exists "fonts_delete_own" on public.fonts;
create policy "fonts_delete_own"
  on public.fonts for delete
  to authenticated
  using (uploader_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. Storage bucket
-- ---------------------------------------------------------------------------
-- Deliberately NOT public. Font binaries are reachable only through short-lived
-- signed URLs minted for a signed-in teammate. A public bucket would put
-- licensed font files on the open internet under a guessable URL.
insert into storage.buckets (id, name, public)
values ('fonts', 'fonts', false)
on conflict (id) do update set public = false;

drop policy if exists "fonts_bucket_read" on storage.objects;
create policy "fonts_bucket_read"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'fonts');

drop policy if exists "fonts_bucket_insert" on storage.objects;
create policy "fonts_bucket_insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'fonts');

-- Allows the watcher's upsert-on-identical-hash path to succeed.
drop policy if exists "fonts_bucket_update" on storage.objects;
create policy "fonts_bucket_update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'fonts')
  with check (bucket_id = 'fonts');
