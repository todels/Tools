// Builds real sfnt containers in memory for testing.
//
// The output is a structurally valid TrueType/OpenType file containing only a
// `name` table — enough for the watcher's parser and the backend round trip.
// It has no glyph data, so the OS will not install it; use a real font file
// when you want to test an actual system font install.
//
// CLI:  node tools/fake-font.mjs "Acme Grotesk" "Bold" out.ttf

function utf16be(str) {
  const buf = Buffer.from(str, 'utf16le');
  const copy = Buffer.from(buf);
  copy.swap16();
  return copy;
}

/** @param entries Array<[nameID, value]> */
export function buildNameTable(entries, { platformID = 3, languageID = 0x409 } = {}) {
  const count = entries.length;
  const header = Buffer.alloc(6 + count * 12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(count, 2);
  header.writeUInt16BE(header.length, 4);

  const strings = [];
  let offset = 0;
  entries.forEach(([nameID, value], i) => {
    const encoded = platformID === 3 ? utf16be(value) : Buffer.from(value, 'latin1');
    const rec = 6 + i * 12;
    header.writeUInt16BE(platformID, rec);
    header.writeUInt16BE(platformID === 3 ? 1 : 0, rec + 2);
    header.writeUInt16BE(languageID, rec + 4);
    header.writeUInt16BE(nameID, rec + 6);
    header.writeUInt16BE(encoded.length, rec + 8);
    header.writeUInt16BE(offset, rec + 10);
    strings.push(encoded);
    offset += encoded.length;
  });

  return Buffer.concat([header, ...strings]);
}

export function buildSfnt(nameTable, version = 0x00010000) {
  const header = Buffer.alloc(12 + 16);
  header.writeUInt32BE(version, 0);
  header.writeUInt16BE(1, 4); // numTables

  header.write('name', 12, 4, 'latin1');
  header.writeUInt32BE(0, 16);
  header.writeUInt32BE(header.length, 20);
  header.writeUInt32BE(nameTable.length, 24);

  return Buffer.concat([header, nameTable]);
}

export function buildTtc(nameTables) {
  const header = Buffer.alloc(12 + nameTables.length * 4);
  header.write('ttcf', 0, 4, 'latin1');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(nameTables.length, 8);

  // Table offsets inside each nested sfnt are absolute within the whole file,
  // so they have to be written once the final position is known.
  const parts = [];
  let cursor = header.length;
  nameTables.forEach((nameTable, i) => {
    const sfntHeader = Buffer.alloc(28);
    sfntHeader.writeUInt32BE(0x00010000, 0);
    sfntHeader.writeUInt16BE(1, 4);
    sfntHeader.write('name', 12, 4, 'latin1');
    sfntHeader.writeUInt32BE(cursor + sfntHeader.length, 20);
    sfntHeader.writeUInt32BE(nameTable.length, 24);

    header.writeUInt32BE(cursor, 12 + i * 4);
    parts.push(sfntHeader, nameTable);
    cursor += sfntHeader.length + nameTable.length;
  });

  return Buffer.concat([header, ...parts]);
}

export function makeFakeFont(family, style = 'Regular') {
  const postscript = `${family}-${style}`.replace(/\s+/g, '');
  return buildSfnt(buildNameTable([
    [1, family],
    [2, style],
    [6, postscript],
    [16, family],
    [17, style],
  ]));
}

// --- CLI ---------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const { writeFileSync } = await import('node:fs');
  const [family = 'Test Grotesk', style = 'Regular', out] = process.argv.slice(2);
  const target = out || `${family.replace(/\s+/g, '')}-${style.replace(/\s+/g, '')}.ttf`;
  writeFileSync(target, makeFakeFont(family, style));
  console.log(`wrote ${target}  (${family} · ${style})`);
}
