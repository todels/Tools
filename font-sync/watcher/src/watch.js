import { watch } from 'node:fs';

import { isFontFile } from './fontmeta.js';

/**
 * Watches the configured font directories with node's built-in fs.watch
 * (recursive is supported natively on macOS and Windows, and on Linux since
 * node 20 — so no chokidar dependency).
 *
 * Font installers touch a directory several times per install, so events are
 * coalesced into one scan per quiet period.
 */
export function startWatching({ dirs, onChange, debounceMs = 1500, log = () => {} }) {
  const watchers = [];
  let timer = null;

  const trigger = (reason) => {
    clearTimeout(timer);
    timer = setTimeout(() => onChange(reason), debounceMs);
  };

  for (const dir of dirs) {
    try {
      const watcher = watch(dir, { recursive: true, persistent: true }, (_event, filename) => {
        // Directory-level events arrive with a null filename; scan anyway
        // since that is how some installers show up.
        if (filename && !isFontFile(filename)) return;
        trigger(`change in ${dir}`);
      });
      watcher.on('error', (err) => log(`watch error on ${dir}: ${err.message}`));
      watchers.push(watcher);
      log(`watching ${dir}`);
    } catch (err) {
      log(`could not watch ${dir}: ${err.message}`);
    }
  }

  // fs.watch misses some cases (network volumes, fonts installed while the app
  // was closed), so a slow poll backs it up.
  const poll = setInterval(() => onChange('periodic'), 5 * 60 * 1000);
  poll.unref();

  return () => {
    clearTimeout(timer);
    clearInterval(poll);
    for (const watcher of watchers) watcher.close();
  };
}
