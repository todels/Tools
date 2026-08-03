# Backend — setup and local test

Supabase provides all three pieces the MVP needs (Postgres, an S3-backed
storage bucket, and email/password auth), so there is no server to deploy or
host. The watcher and the Figma plugin talk to it directly over its REST API.

## 1. Run the schema

Supabase dashboard → **SQL Editor** → **New query** → paste
[`schema.sql`](./schema.sql) → **Run**.

It creates:

| Object | Purpose |
| --- | --- |
| `public.fonts` | one row per font *face* (family, style, uploader, project tag, storage path, hash, date) |
| `fonts` storage bucket | the font binaries, **private** |
| RLS policies | any signed-in teammate can read; you can only insert rows attributed to yourself, and only with `license_confirmed = true` |

The script is idempotent — re-running it is safe.

### Why the bucket is private

A public bucket would put licensed font binaries on the open internet behind a
guessable URL. Instead the plugin mints a signed URL (default 1 hour) for a
signed-in user at download time. `test-backend.mjs` asserts the bucket is
private, so an accidental flip to public fails the test.

## 2. Create team accounts

Dashboard → **Authentication** → **Users** → **Add user** for each designer.
Tick *Auto Confirm User* so nobody has to click a verification email.

Email/password is used rather than a shared API key so the `uploader` column
actually names a person — which matters when a teammate needs to ask where a
font came from, and when you need to know who confirmed the licence.

## 3. Test it

```bash
cd font-sync
SUPABASE_URL=https://YOURPROJECT.supabase.co \
SUPABASE_ANON_KEY=eyJhbGci... \
FONTSYNC_EMAIL=you@agency.com \
FONTSYNC_PASSWORD=yourpassword \
node backend/test-backend.mjs
```

Expected output:

```
• sign in ... ok
  signed in as you@agency.com
• parse the generated font ... ok
• upload the file to the fonts bucket ... ok
• insert the metadata row ... ok
• licensing gate rejects an unconfirmed row ... ok
• look the font up the way the plugin will ... ok
• mint a signed download URL ... ok
• download through the signed URL ... ok
• bucket is private (unsigned URL is refused) ... ok
• clean up test row and file ... ok

10/10 checks passed
```

The script generates a synthetic font with a unique family name, pushes it
through the exact path the watcher uses, reads it back the way the plugin
will, then deletes both the row and the file. It leaves nothing behind, so it
is safe to run against the real project repeatedly.

Find the URL and anon key under **Settings → API**. The anon key is meant to be
distributed to clients — RLS is what protects the data, which is why the
policies above are the security boundary.

## Schema reference

```
fonts
  id                uuid pk
  family            text     "Acme Grotesk"        as shown in Figma
  style             text     "SemiBold"
  postscript_name   text     "AcmeGrotesk-SemiBold"
  family_key        text     "acme grotesk"        normalised lookup key
  style_key         text     "semibold"
  file_name         text     original filename
  file_hash         text     sha256 of the bytes
  file_size         bigint
  format            text     ttf | otf | ttc | otc
  storage_path      text     path inside the fonts bucket
  uploader          text     email
  uploader_id       uuid     -> auth.users
  project_tag       text     nullable, e.g. "Acme rebrand"
  license_confirmed boolean  must be true (enforced by RLS)
  created_at        timestamptz
```

A `.ttc` collection produces one row per face sharing a single `file_hash` and
`storage_path`, so a four-style collection can satisfy four separate
missing-font lookups while only being stored once. The unique index is on
`(family_key, style_key, file_hash)`, which makes re-detecting the same file —
a reinstall, or a second machine — a no-op rather than a duplicate.
