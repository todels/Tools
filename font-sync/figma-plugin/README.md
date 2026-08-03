# Font Finder — Figma plugin

Finds the fonts a file uses, works out which ones *you* don't have installed,
and checks whether a teammate has already shared them.

No build step — plain JS, so `manifest.json` / `code.js` / `ui.html` are what
Figma runs.

## Install it locally

1. Figma desktop app → menu → **Plugins → Development → Import plugin from
   manifest…**
2. Pick `font-sync/figma-plugin/manifest.json`
3. Run it from **Plugins → Development → Font Finder**

First run asks for the Supabase project URL and anon key (same pair the
watcher uses), then for your login. Both are cached in `figma.clientStorage`,
so it's once per machine.

`manifest.json` allows `https://*.supabase.co`. If you host Supabase on a
custom domain, put that exact domain in `networkAccess.allowedDomains`.

## How detection works

- `getRangeAllFontNames(0, length)` on every text node — not `node.fontName`,
  because a single text node can mix several fonts and only the range API sees
  all of them.
- `listAvailableFontsAsync()` is the authority on what *you* have installed.
  A font used in the file but absent from that list is missing for you.
- `hasMissingFont` is read too, but only as a counter: it flags the *node*, not
  which of its fonts is at fault, so it can't drive the list on its own.

Scope defaults to the whole file (`loadAllPagesAsync()` first, as
`documentAccess: "dynamic-page"` requires). Toggle to **This page** for large
files.

## What happens on Download

**Figma plugins are sandboxed and cannot install fonts system-wide.** Nothing
here pretends otherwise. The flow is as short as the sandbox permits:

1. The plugin mints a 1-hour signed URL for the font in the private bucket.
2. `figma.openExternal()` hands it to your browser, which downloads the file
   (`?download=` forces a save rather than a preview).
3. The card expands with the two-step OS install (macOS: open → *Install
   Font*; Windows: right-click → *Install*).
4. **Rescan** — the font moves off the missing list. Figma occasionally needs a
   restart to notice newly installed fonts.

Fonts *not* in the library are named plainly so you know who to ask, with
**Copy name** for pasting into Slack. If other styles of the same family are
present, it says so — "we have Acme Regular and Bold, but not the Black you
need" is more useful than "not found".

**Show layers** selects the text layers using that font, switching pages if
needed.

## Test it locally

Prerequisite: the backend test passes and the watcher has uploaded at least one
font (see the other two READMEs).

1. **Make a file that needs a font you don't have.** Easiest honest test with
   two machines: designer A installs a font, lets Font Watcher upload it, and
   uses it in a Figma file; designer B opens that file.

   On one machine, simulate it: install a font, use it in a file, let the
   watcher upload it, then *uninstall* the font (macOS: Font Book → right-click
   → Remove). Figma now reports it missing while the library still has it.

2. **Run the plugin.** It should list the font under its family and style, with
   the uploader's name and **Download**.

3. **Press Download.** Your browser saves the file. Install it, hit **Rescan** —
   it disappears from the list.

4. **Check the not-found path.** Use any font the library doesn't have (or
   sign in as someone whose team has uploaded nothing). It should be listed
   with the ask-a-teammate note and no download button.

Quick check that the query layer works before wiring up a real file:

```bash
cd font-sync
SUPABASE_URL=... SUPABASE_ANON_KEY=... FONTSYNC_EMAIL=... FONTSYNC_PASSWORD=... \
  node backend/test-backend.mjs
```

That runs the same lookup and signed-URL calls the plugin makes. If it passes
and the plugin fails, the problem is in the plugin, not the backend.

## Files

```
manifest.json   plugin metadata, allowed domains, dynamic-page access
code.js         sandbox half: document scan, font availability, openExternal
ui.html         iframe half: all network calls, auth, results UI
```

The split is forced by Figma: only the iframe can make network requests, and
only the sandbox can read the document.
