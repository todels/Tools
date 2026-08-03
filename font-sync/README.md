# Font Sync — MVP

When a designer picks a custom font in Figma, teammates who open the file don't
have it installed and have no way to get the exact file. This closes that loop:
fonts a designer installs are captured automatically, and teammates who are
missing them get a one-click download from inside Figma.

```
 designer A                    Supabase                     designer B
┌──────────────┐          ┌──────────────────┐          ┌──────────────────┐
│ installs a   │          │ fonts table      │          │ opens the file   │
│ font         │          │  family, style,  │          │ in Figma         │
│      ↓       │  upload  │  uploader, tag   │  query   │      ↓           │
│ Font Watcher │ ───────► │                  │ ◄─────── │ Font Finder      │
│ (background) │          │ fonts bucket     │  signed  │ (Figma plugin)   │
│              │          │  (private)       │   URL    │      ↓           │
└──────────────┘          └──────────────────┘          │ download+install │
                                                        └──────────────────┘
```

| Part | What it is | Docs |
| --- | --- | --- |
| **Backend** | Supabase: Postgres table + private storage bucket + email auth. Nothing to host. | [backend/README.md](backend/README.md) |
| **Font Watcher** | Dependency-free Node background app. Watches font folders, uploads new fonts. | [watcher/README.md](watcher/README.md) |
| **Font Finder** | Figma plugin. Detects missing fonts, finds them in the library, downloads them. | [figma-plugin/README.md](figma-plugin/README.md) |

## Set it up in order

Each step is testable on its own before you move to the next.

**1. Backend** — paste [`backend/schema.sql`](backend/schema.sql) into the
Supabase SQL editor, add a user per designer, then:

```bash
cd font-sync
SUPABASE_URL=https://YOURPROJECT.supabase.co SUPABASE_ANON_KEY=eyJ... \
FONTSYNC_EMAIL=you@agency.com FONTSYNC_PASSWORD=... \
  node backend/test-backend.mjs        # 10/10 checks passed
```

**2. Font Watcher** — `node watcher/bin/fontsync.js`, sign in at
`http://localhost:7331`, then install a font and watch it appear in the queue.
`cd watcher && npm test` runs the parser tests plus an integration test that
boots the real process against a throwaway font folder.

**3. Font Finder** — Figma → *Plugins → Development → Import plugin from
manifest…* → `figma-plugin/manifest.json`.

## Decisions worth knowing about

**Supabase, not a custom API.** The repo already runs on Supabase, and it gives
Postgres, S3-backed storage and auth in one place with no server to deploy. The
watcher and plugin call its REST API directly. Swapping in S3 + an Express API
later means replacing `watcher/src/api.js` and the fetch helper in the plugin's
`ui.html` — the schema carries over.

**No Electron.** The watcher is a plain Node process with a settings UI served
on `localhost:7331`. Electron would add ~150 MB and a packaging step to a file
watcher plus a settings form. There are **zero dependencies**: `fs.watch` does
recursive watching natively, `fetch` is built in, and the OpenType parser is
~120 lines. `git clone && node bin/fontsync.js` and it runs. The engine in
`src/` is UI-agnostic, so a menubar shell (Electron or Tauri) can wrap it later
without touching the sync logic.

**Email/password, not a shared team key.** Barely more setup, and it makes
`uploader` a real person — which matters when a teammate needs to ask where a
font came from, and when you need to know who confirmed a licence.

## The constraints you flagged

**Font licensing.** This is deliberately not a redistribution free-for-all:

- Detected fonts sit in a **Waiting for confirmation** queue and upload only
  after the designer confirms they hold the rights to share them.
- `license_confirmed = true` is enforced by an **RLS policy**, not just the UI,
  so no client bug can write a row without it. The backend test asserts this by
  trying to insert an unconfirmed row and expecting a rejection.
- The storage bucket is **private**. Downloads use 1-hour signed URLs, so font
  binaries are never sitting on a public URL. The backend test fails if the
  bucket is ever flipped to public.
- Every upload records who confirmed it, so there's an audit trail.
- The plugin warns before download that fonts are often licensed per seat.
- There is an opt-in "upload automatically" toggle for teams whose licences
  already cover everyone. It's off by default and warns before enabling. This
  is the one place the MVP trades away "no manual action required" — silently
  redistributing a colleague's licensed font is worth one click to avoid.
- OS-bundled font directories (`/System/Library/Fonts`, `/usr/share/fonts`) are
  never watched. Everyone already has those and many aren't redistributable.

What this does *not* do is detect licence terms automatically — that needs
per-foundry EULA parsing and is well beyond an MVP. It records a human's
confirmation instead.

**Figma sandboxing.** Plugins cannot install fonts system-wide, and nothing
here pretends otherwise. The flow is: signed URL → `figma.openExternal()` →
browser downloads the file → the card shows the two-step OS install → Rescan.
That is the shortest path the sandbox allows.

## Scope

In: detect, upload, detect missing, download. Out (as agreed): font previews,
version diffing, multi-team support.

Known limits of this MVP:

- **`.woff`, `.woff2`, `.dfont` aren't parsed.** They're listed under *Skipped*
  with a reason rather than uploaded with a guessed name. They rarely appear in
  system font folders. Supporting `.woff2` means a Brotli decompressor.
- **Uninstalling a font doesn't remove it from the library.** Deletion is
  manual for now (in the Supabase dashboard).
- **Family/style matching is exact** after normalising case and whitespace. A
  font whose internal name differs from what Figma displays won't match; the
  plugin shows other styles of the same family so the near miss is visible
  rather than silent.
- **No conflict handling for same-name-different-file.** Two designers with
  different cuts of one family produce two rows; the plugin offers the newest.
