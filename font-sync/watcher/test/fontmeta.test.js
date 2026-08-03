import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFont,
  normalizeKey,
  storagePathFor,
  hashBuffer,
  isFontFile,
  isSupportedFontFile,
} from '../src/fontmeta.js';

import { buildNameTable, buildSfnt, buildTtc } from '../../tools/fake-font.mjs';

// --- tests ------------------------------------------------------------------

test('reads family and style from a TrueType name table', () => {
  const font = buildSfnt(buildNameTable([[1, 'Acme Grotesk'], [2, 'Bold'], [6, 'AcmeGrotesk-Bold']]));
  const parsed = parseFont(font);

  assert.equal(parsed.format, 'ttf');
  assert.equal(parsed.faces.length, 1);
  assert.deepEqual(parsed.faces[0], {
    family: 'Acme Grotesk',
    style: 'Bold',
    postscriptName: 'AcmeGrotesk-Bold',
  });
});

test('prefers typographic family/subfamily, which is what Figma reports', () => {
  // A SemiBold cut names itself "Acme SemiBold"/"Regular" in the legacy IDs and
  // "Acme"/"SemiBold" in the typographic ones. Figma shows the latter.
  const font = buildSfnt(buildNameTable([
    [1, 'Acme SemiBold'],
    [2, 'Regular'],
    [16, 'Acme'],
    [17, 'SemiBold'],
  ]));
  const parsed = parseFont(font);

  assert.equal(parsed.faces[0].family, 'Acme');
  assert.equal(parsed.faces[0].style, 'SemiBold');
});

test('detects OTF (CFF) containers', () => {
  const font = buildSfnt(buildNameTable([[1, 'Acme Serif'], [2, 'Italic']]), 0x4f54544f);
  assert.equal(parseFont(font).format, 'otf');
});

test('defaults style to Regular when the subfamily is absent', () => {
  const font = buildSfnt(buildNameTable([[1, 'Acme Mono']]));
  assert.equal(parseFont(font).faces[0].style, 'Regular');
});

test('decodes Macintosh-platform (latin1) name records', () => {
  const font = buildSfnt(buildNameTable(
    [[1, 'Acme Text'], [2, 'Light']],
    { platformID: 1, languageID: 0 },
  ));
  const parsed = parseFont(font);
  assert.equal(parsed.faces[0].family, 'Acme Text');
  assert.equal(parsed.faces[0].style, 'Light');
});

test('a .ttc yields one face per font in the collection', () => {
  const ttc = buildTtc([
    buildNameTable([[1, 'Acme Grotesk'], [2, 'Regular']]),
    buildNameTable([[1, 'Acme Grotesk'], [2, 'Bold']]),
    buildNameTable([[1, 'Acme Grotesk'], [2, 'Black']]),
  ]);
  const parsed = parseFont(ttc);

  assert.equal(parsed.format, 'ttc');
  assert.deepEqual(parsed.faces.map((f) => f.style), ['Regular', 'Bold', 'Black']);
});

test('rejects non-sfnt data instead of guessing', () => {
  assert.equal(parseFont(Buffer.from('wOF2 this is a woff2 file')), null);
  assert.equal(parseFont(Buffer.alloc(4)), null);
  assert.equal(parseFont(null), null);
});

test('rejects an sfnt with no name table', () => {
  const header = Buffer.alloc(12 + 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(1, 4);
  header.write('glyf', 12, 4, 'latin1');
  assert.equal(parseFont(header), null);
});

test('normalizeKey makes Figma-style lookups case- and space-insensitive', () => {
  assert.equal(normalizeKey('  Acme   Grotesk '), 'acme grotesk');
  assert.equal(normalizeKey('SemiBold'), normalizeKey('semibold'));
  assert.equal(normalizeKey(null), '');
});

test('storage paths are purely content-addressed', () => {
  const hash = hashBuffer(Buffer.from('abc'));
  const path = storagePathFor('/Users/x/Library/Fonts/Acme Grotesk (1).ttf', hash);

  assert.equal(path, `${hash}.ttf`);

  // The same bytes saved under a different filename must collapse onto one
  // object, or a font gets stored once per spelling of its name.
  assert.equal(storagePathFor('/other/acme grotesk.ttf', hash), path);
  assert.equal(storagePathFor('/other/ACME-BOLD.TTF', hash), path);

  // Different formats stay distinct.
  assert.notEqual(storagePathFor('/x/Acme.otf', hash), path);
  // And nothing user-controlled reaches the path.
  assert.match(storagePathFor('/x/../../evil name;.ttf', hash), /^[a-f0-9]{64}\.ttf$/);
});

test('extension checks separate "is a font" from "we can parse it"', () => {
  assert.ok(isFontFile('X.woff2') && !isSupportedFontFile('X.woff2'));
  assert.ok(isFontFile('X.TTF') && isSupportedFontFile('X.TTF'));
  assert.ok(!isFontFile('X.png'));
});
