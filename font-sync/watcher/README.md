# Font Watcher — background app

Watches your font folders, and when a font appears that wasn't there before,
uploads it to the team library with its family, style, uploader and project tag.

**No dependencies and no build step** — it is plain Node ≥ 20. `fs.watch` handles
recursive directory watching natively on macOS, Windows and Linux, and `fetch`
talks to Supabase, so there is nothing to `npm install`.

> **Why not Electron?** Electron would add ~150 MB and a packaging step to what
> is a file watcher plus a settings form. This runs as a normal background
> process and serves its settings UI at `http://localhost:7331`. If you later
> want a menubar icon, the engine in `src/` is UI-agnostic — wrapping it in
> Electron or Tauri means writing a tray shell around the same modules.

## Run it

Easiest path is `../setup.sh`, which configures everything and starts this for
you. To run it directly:

```bash
cd font-sync/watcher
node bin/fontsync.js
```

It opens the settings UI in your browser. Flags: `--port 7331`, `--no-open`.

To sign in from the terminal instead of the UI (setup.sh uses this):

```bash
node bin/signin.js you@agency.com
```

## First-run behaviour

On first launch every font already installed is recorded as **baseline** and
never uploaded. Only fonts that appear *after* that point are treated as newly
installed. Without this the first launch would try to push a designer's entire
existing library — including the OS-bundled fonts everyone already has.

Watched folders (system font directories like `/System/Library/Fonts` are
deliberately excluded — everyone already has those, and many are not
redistributable):

| OS | Folders |
| --- | --- |
| macOS | `~/Library/Fonts`, `/Library/Fonts` |
| Windows | `%LOCALAPPDATA%\Microsoft\Windows\Fonts`, `%WINDIR%\Fonts` |
| Linux | `~/.local/share/fonts`, `~/.fonts`, `/usr/local/share/fonts` |

Override with `watchDirs` in `~/.fontsync/config.json`.

## The licensing step

Detected fonts land in a **Waiting for confirmation** queue. Nothing uploads
until you tick the rights confirmation — and `license_confirmed = true` is
enforced by an RLS policy, so a bug in this app cannot bypass it.

There is an opt-in **"upload new fonts automatically"** toggle for teams whose
licences already cover everyone. It shows a warning before it turns on, and
each upload it makes still records that you confirmed the rights. It is off by
default, which is the one intentional friction point against the "no manual
action required" goal: silently redistributing a colleague's licensed font is
the failure mode worth one click to avoid.

Fonts you can't share: press **Skip**. They won't be offered again.

## Supported formats

`.ttf`, `.otf`, `.ttc`, `.otc` are parsed for family/style straight from the
OpenType `name` table. `.woff`, `.woff2` and `.dfont` are listed under
**Skipped** with a reason rather than being uploaded with a guessed name —
these rarely appear in system font folders anyway.

Family and style come from name IDs 16/17 (typographic) when present, falling
back to 1/2. That's what makes `Acme` + `SemiBold` match what Figma reports,
rather than `Acme SemiBold` + `Regular`.

## Test it locally

Unit tests for the parser, plus an integration test that boots the real process
against a throwaway font directory:

```bash
cd font-sync/watcher
npm test
```

To drive it by hand without installing anything into your real font folder:

```bash
# 1. throwaway config pointing at a test directory
mkdir -p /tmp/fs-home /tmp/fs-fonts
cat > /tmp/fs-home/config.json <<'JSON'
{ "supabaseUrl": "https://YOURPROJECT.supabase.co",
  "supabaseAnonKey": "eyJhbGci...",
  "watchDirs": ["/tmp/fs-fonts"], "port": 7331 }
JSON

# 2. start it
FONTSYNC_HOME=/tmp/fs-home node bin/fontsync.js

# 3. sign in at http://localhost:7331, then in another terminal
#    drop a font in and watch it appear in the queue
node ../tools/fake-font.mjs "Acme Grotesk" "Bold" /tmp/fs-fonts/AcmeGrotesk-Bold.ttf
```

Confirm the rights checkbox, hit **Confirm & upload**, and the font appears
under Recent uploads — and in the Supabase table.

`fake-font.mjs` writes a structurally valid font containing only a `name`
table. It exercises the whole pipeline, but has no glyphs, so the OS will not
install it. For a real end-to-end test, install an actual font file into
`~/Library/Fonts` with the watcher running.

## Run it in the background (macOS)

```bash
cp com.fontsync.watcher.plist ~/Library/LaunchAgents/
# edit the paths inside first
launchctl load ~/Library/LaunchAgents/com.fontsync.watcher.plist
```

It then starts at login and restarts if it exits. Logs go to
`~/.fontsync/watcher.log`. To stop:

```bash
launchctl unload ~/Library/LaunchAgents/com.fontsync.watcher.plist
```

## Files

```
bin/fontsync.js   entry point: wires config, engine, watcher and server together
src/config.js     config + state persistence, per-OS font folder locations
src/fontmeta.js   OpenType `name` table parser, hashing, storage paths
src/api.js        Supabase REST client (auth, PostgREST, storage)
src/engine.js     detect -> baseline -> queue -> confirm -> upload
src/watch.js      fs.watch wrapper with debounce and a periodic backstop
src/server.js     loopback-only HTTP API for the settings UI
src/ui.html       the settings UI
```

`~/.fontsync/config.json` holds your Supabase session token — it is written
`0600` and the server only accepts loopback requests with a local `Origin`.
