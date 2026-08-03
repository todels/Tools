// The watcher writes family_key/style_key and the Figma plugin queries on
// them. They are separate codebases with separate copies of normalizeKey, so
// any drift shows up as fonts silently "not in the library" rather than as an
// error. This test pins the two implementations together.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeKey } from '../src/fontmeta.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_UI = join(HERE, '..', '..', 'figma-plugin', 'ui.html');

const SAMPLES = [
  'Acme Grotesk',
  '  Acme   Grotesk  ',
  'ACME GROTESK',
  'SemiBold',
  'Bold Italic',
  'Söhne Breit',
  'IBM Plex Sans',
  '',
  null,
];

test('the plugin normalises font keys exactly like the watcher does', async () => {
  const html = await readFile(PLUGIN_UI, 'utf8');

  const match = html.match(/const normalizeKey = ([^;]+);/);
  assert.ok(match, 'could not find normalizeKey in the plugin UI — did it get renamed?');

  // eslint-disable-next-line no-new-func
  const pluginNormalizeKey = new Function(`return ${match[1]}`)();

  for (const sample of SAMPLES) {
    assert.equal(
      pluginNormalizeKey(sample),
      normalizeKey(sample),
      `mismatch for ${JSON.stringify(sample)}`,
    );
  }
});
