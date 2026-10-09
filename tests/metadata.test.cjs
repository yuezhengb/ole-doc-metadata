const assert = require('node:assert/strict');
const test = require('node:test');
const { CFB, makeDoc } = require('./helpers/hpsf-fixture.cjs');
const { dictionary, filetime, filetimeTicks, int16, int32, propertySet, string, typed } = require('./helpers/hpsf-packets.cjs');

const SUMMARY = 'e0859ff2f94f6810ab9108002b27b3d9';
const DOC_SUMMARY = '02d5cdd59c2e1b10939708002b2cf9ae';
const USER_DEFINED = '05d5cdd59c2e1b10939708002b2cf9ae';
const CODEPAGE = int16(1200);
const TICKS_PER_MINUTE = 600000000n;
const ORIGINAL_DATE = Date.UTC(2024, 3, 5, 6, 7, 8);

let api = require('../src/index.js');

function readMetadata(bytes) {
  assert.equal(typeof api.readDocMetadata, 'function', 'readDocMetadata export should exist');
  return api.readDocMetadata(bytes);
}

function writeMetadata(bytes, values, mode, now) {
  assert.equal(typeof api.writeDocMetadata, 'function', 'writeDocMetadata export should exist');
  return api.writeDocMetadata(bytes, values, mode, now);
}

function makeSummary(overrides = {}) {
  const properties = [
    { id: 1, raw: CODEPAGE },
    { id: 2, raw: string('Original title') },
    { id: 3, raw: string('Original subject') },
    { id: 4, raw: string('Original author') },
    { id: 5, raw: string('Sofos, Legal') },
    { id: 6, raw: string('Original description') },
    { id: 8, raw: string('Original editor') },
    { id: 9, raw: string('8') },
    { id: 10, raw: filetimeTicks(TICKS_PER_MINUTE * 60n) },
    { id: 11, raw: filetime(ORIGINAL_DATE - 86400000) },
    { id: 12, raw: filetime(ORIGINAL_DATE - 86400000 * 30) },
    { id: 13, raw: filetime(ORIGINAL_DATE) },
    { id: 18, raw: string('Microsoft Office Word') },
    { id: 99, raw: typed(0x7777, Buffer.from([0xDE, 0xAD, 0xBE, 0xEF])) },
  ];
  for (const [id, raw] of Object.entries(overrides)) {
    const propertyId = Number(id);
    const existing = properties.find(property => property.id === propertyId);
    if (existing) existing.raw = raw;
    else properties.push({ id: propertyId, raw });
  }
  return propertySet([{ fmtid: SUMMARY, properties }]);
}

function makeDocumentSummary({ includeCustom = true } = {}) {
  const standard = [
    { id: 1, raw: CODEPAGE },
    { id: 2, raw: string('Legal Document') },
    { id: 14, raw: string('Managing Partner') },
    { id: 15, raw: string('Sofos & Partners') },
    { id: 23, raw: int32((16 << 16) | 2) },
    { id: 27, raw: string('Draft') },
    { id: 29, raw: string('0.9') },
    { id: 31, raw: int32(1234) },
  ];
  const sections = [{ fmtid: DOC_SUMMARY, properties: standard }];
  if (includeCustom) {
    sections.push({
      fmtid: USER_DEFINED,
      properties: [
        { id: 0, raw: dictionary([[2, 'Client matter'], [3, 'Copyright']]) },
        { id: 1, raw: CODEPAGE },
        { id: 2, raw: string('Matter-2024-001') },
        { id: 3, raw: string('Old copyright') },
      ],
    });
  }
  return propertySet(sections);
}

function makeInput({ signature = false, withProperties = true } = {}) {
  const streams = {};
  if (withProperties) {
    streams['\u0005SummaryInformation'] = makeSummary();
    streams['\u0005DocumentSummaryInformation'] = makeDocumentSummary();
  }
  if (signature) streams['\u0005DigitalSignature'] = Buffer.from('SIGNATURE_SENTINEL');
  streams['ObjectPool/EmbeddedDocument'] = Buffer.from('OBJECT_SENTINEL');
  return makeDoc({ streams });
}

function makeDocWithoutContainerMarker() {
  const source = CFB.parse(makeDoc({ streams: {
    '\u0005SummaryInformation': makeSummary(),
    '\u0005DocumentSummaryInformation': makeDocumentSummary(),
  } }));
  const cfb = {
    FullPaths: ['Root Entry/'],
    FileIndex: [{ name: 'Root Entry', type: 5 }],
  };
  for (let i = 1; i < source.FileIndex.length; i += 1) {
    const entry = source.FileIndex[i];
    if (entry?.type !== 2) continue;
    const name = String(source.FullPaths[i]).replace(/^Root Entry\//iu, '');
    if (!name || name === '\u0001Sh33tJ5') continue;
    cfb.FullPaths.push(`Root Entry/${name}`);
    cfb.FileIndex.push({
      name: entry.name, type: 2, content: Buffer.from(entry.content), size: entry.size,
    });
  }
  const marker = '\u0001Sh33tJ5';
  const originalFind = CFB.find;
  CFB.find = function findWithoutAddingMarker(target, path) {
    const normalized = String(path || '').replace(/^\/+|^Root Entry\//giu, '').toLocaleLowerCase('en-US');
    if (target === cfb && normalized === marker.toLocaleLowerCase('en-US')) {
      return { name: marker, type: 2, synthetic: true };
    }
    return originalFind.apply(this, arguments);
  };
  try {
    return new Uint8Array(CFB.write(cfb, { type: 'buffer' }));
  } finally {
    CFB.find = originalFind;
  }
}

function streamMap(bytes) {
  const cfb = CFB.parse(bytes);
  const streams = new Map();
  for (let i = 0; i < cfb.FullPaths.length; i += 1) {
    const entry = cfb.FileIndex[i];
    if (!entry || entry.type !== 2) continue;
    const name = String(cfb.FullPaths[i]).replace(/^Root Entry\//i, '').replace(/^\/+/, '');
    streams.set(name, Buffer.from(entry.content));
  }
  return streams;
}

function assertNonPropertyStreamsEqual(beforeBytes, afterBytes) {
  const before = streamMap(beforeBytes);
  const after = streamMap(afterBytes);
  const propertyNames = new Set([
    '\u0005SummaryInformation',
    '\u0005DocumentSummaryInformation',
  ]);
  for (const [name, contents] of before) {
    if (propertyNames.has(name)) continue;
    assert.ok(after.has(name), `non-property stream ${JSON.stringify(name)} remains`);
    assert.ok(after.get(name).equals(contents), `non-property stream ${JSON.stringify(name)} is byte-identical`);
  }
}

function propertySetIn(bytes, streamName) {
  const stream = streamMap(bytes).get(streamName);
  return stream ? require('../src/hpsf.js').parsePropertySet(stream) : null;
}

test('reads standard summary fields, extended fields, custom fields, and signature state', () => {
  const result = readMetadata(makeInput({ signature: true }));
  assert.equal(result.metadata.title, 'Original title');
  assert.equal(result.metadata.subject, 'Original subject');
  assert.equal(result.metadata.author, 'Original author');
  assert.equal(result.metadata.description, 'Original description');
  assert.equal(result.metadata.category, 'Legal Document');
  assert.equal(result.metadata.status, 'Draft');
  assert.equal(result.metadata.version, '0.9');
  assert.equal(result.metadata.copyright, 'Old copyright');
  assert.equal(result.metadata.lastModBy, 'Original editor');
  assert.equal(result.metadata.company, 'Sofos & Partners');
  assert.equal(result.metadata.manager, 'Managing Partner');
  assert.equal(result.metadata.producer, 'Microsoft Office Word');
  assert.equal(result.metadata.appVersion, '16.0002');
  assert.equal(result.metadata.totalTime, '60');
  assert.equal(result.metadata.revision, '8');
  assert.equal(result.metadata.modified, new Date(ORIGINAL_DATE).toISOString());
  assert.equal(result.signed, true);
});

test('form mode updates submitted fields and preserves untouched properties and stream bytes', () => {
  const input = makeInput();
  const operationTime = new Date(Date.UTC(2026, 9, 9, 11, 12, 13));
  const output = writeMetadata(input, { title: 'Updated title' }, 'form', operationTime);
  const result = readMetadata(output);
  assert.equal(result.metadata.title, 'Updated title');
  assert.equal(result.metadata.subject, 'Original subject');
  assert.equal(result.metadata.author, 'Original author');
  assert.equal(result.metadata.copyright, 'Old copyright');
  assert.equal(result.metadata.modified, operationTime.toISOString());
  const summary = propertySetIn(output, '\u0005SummaryInformation');
  assert.ok(Buffer.from(summary.sections[0].properties.get(99).rawValue)
    .equals(typed(0x7777, Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]))));
  assertNonPropertyStreamsEqual(input, output);
});

test('writes every mapped standard property and the named copyright property', () => {
  const input = makeInput();
  const operationTime = new Date(Date.UTC(2026, 9, 9, 15, 16, 17));
  const created = new Date(Date.UTC(2021, 2, 4, 5, 6, 7));
  const lastPrinted = new Date(Date.UTC(2025, 6, 8, 9, 10, 11));
  const output = writeMetadata(input, {
    title: 'Title', subject: 'Subject', author: 'Author', keywords: 'one, two',
    description: 'Description', lastModBy: 'Editor', revision: '12',
    created: created.toISOString(), lastPrinted: lastPrinted.toISOString(),
    totalTime: '135', producer: 'Microsoft Word', category: 'Legal',
    manager: 'Manager', company: 'Example LLP', status: 'Final', version: '2.1',
    appVersion: '16.0000', copyright: '© 2026 Example LLP',
    modified: '2000-01-01T00:00:00.000Z',
  }, 'form', operationTime);
  const metadata = readMetadata(output).metadata;
  assert.equal(metadata.title, 'Title');
  assert.equal(metadata.subject, 'Subject');
  assert.equal(metadata.author, 'Author');
  assert.equal(metadata.keywords, 'one, two');
  assert.equal(metadata.description, 'Description');
  assert.equal(metadata.lastModBy, 'Editor');
  assert.equal(metadata.revision, '12');
  assert.equal(metadata.created, created.toISOString());
  assert.equal(metadata.lastPrinted, lastPrinted.toISOString());
  assert.equal(metadata.totalTime, '135');
  assert.equal(metadata.producer, 'Microsoft Word');
  assert.equal(metadata.category, 'Legal');
  assert.equal(metadata.manager, 'Manager');
  assert.equal(metadata.company, 'Example LLP');
  assert.equal(metadata.status, 'Final');
  assert.equal(metadata.version, '2.1');
  assert.equal(metadata.appVersion, '16.0000');
  assert.equal(metadata.copyright, '© 2026 Example LLP');
  assert.equal(metadata.modified, operationTime.toISOString());
  const docSummary = propertySetIn(output, '\u0005DocumentSummaryInformation');
  assert.equal(docSummary.sections[1].properties.get(2).value, 'Matter-2024-001');
});

test('template mode replaces known properties and stores copyright as a named custom value', () => {
  const input = makeInput();
  const operationTime = new Date(Date.UTC(2026, 9, 9, 12, 0, 0));
  const output = writeMetadata(input, {
    title: 'Firm template title',
    company: 'Sofos & Partners',
    category: 'Legal Document',
    status: 'Internal',
    version: '1.0',
    copyright: '© 2026 Sofos & Partners',
  }, 'template', operationTime);
  const result = readMetadata(output);
  assert.equal(result.metadata.title, 'Firm template title');
  assert.equal(result.metadata.author, '');
  assert.equal(result.metadata.subject, '');
  assert.equal(result.metadata.status, 'Internal');
  assert.equal(result.metadata.version, '1.0');
  assert.equal(result.metadata.copyright, '© 2026 Sofos & Partners');
  assert.equal(result.metadata.modified, operationTime.toISOString());
  const summary = propertySetIn(output, '\u0005SummaryInformation');
  assert.equal(summary.sections[0].properties.has(99), false);
  const docSummary = propertySetIn(output, '\u0005DocumentSummaryInformation');
  assert.equal(docSummary.sections.length, 2);
  assert.deepEqual(docSummary.sections[1].properties.get(0).value, [[2, 'Copyright']]);
  assertNonPropertyStreamsEqual(input, output);
});

test('clear mode removes standard and custom metadata and writes only operation-time last-save', () => {
  const input = makeInput();
  const operationTime = new Date(Date.UTC(2026, 9, 9, 13, 14, 15));
  const output = writeMetadata(input, {
    title: 'Stale form value', author: 'Stale author', copyright: 'Stale copyright',
  }, 'clear', operationTime);
  const result = readMetadata(output);
  assert.equal(result.metadata.title, '');
  assert.equal(result.metadata.status, '');
  assert.equal(result.metadata.version, '');
  assert.equal(result.metadata.copyright, '');
  assert.equal(result.metadata.modified, operationTime.toISOString());
  const summary = propertySetIn(output, '\u0005SummaryInformation');
  assert.deepEqual([...summary.sections[0].properties.keys()].sort((a, b) => a - b), [1, 13]);
  const docSummary = propertySetIn(output, '\u0005DocumentSummaryInformation');
  assert.equal(docSummary.sections.length, 1);
  assert.deepEqual([...docSummary.sections[0].properties.keys()], [1]);
  assertNonPropertyStreamsEqual(input, output);
});

test('creates property streams when absent and keeps long values over the CFB mini-stream boundary', () => {
  const input = makeInput({ withProperties: false });
  const title = '合'.repeat(5000);
  const output = writeMetadata(input, { title }, 'form', new Date(ORIGINAL_DATE));
  assert.equal(readMetadata(output).metadata.title, title);
  assertNonPropertyStreamsEqual(input, output);
});

test('does not inject the CFB library maker marker into an unmarked DOC', () => {
  const input = makeDocWithoutContainerMarker();
  const marker = '\u0001Sh33tJ5';
  assert.equal([...streamMap(input).keys()].some(name => name.endsWith(marker)), false);

  const output = writeMetadata(input, { title: 'Marker-free DOC' }, 'form', new Date(ORIGINAL_DATE));
  const streams = streamMap(output);
  assert.equal([...streams.keys()].some(name => name.endsWith(marker)), false);
  assertNonPropertyStreamsEqual(input, output);
});

test('rejects malformed and encrypted files and never modifies a VBA or signature stream', () => {
  const malformed = makeDoc({ length: 20 });
  assert.throws(() => writeMetadata(malformed, { title: 'x' }, 'form'), /malformed/i);
  const encrypted = makeDoc({ encrypted: true });
  assert.throws(() => writeMetadata(encrypted, { title: 'x' }, 'form'), /encrypted/i);
  const input = makeInput({ signature: true });
  const output = writeMetadata(input, { title: 'Signed source' }, 'form', new Date(ORIGINAL_DATE));
  assert.equal(readMetadata(output).signed, true);
  assertNonPropertyStreamsEqual(input, output);
});

test('form mode updates the local date fields and HPSF editing-time duration', () => {
  const input = makeInput();
  const operationTime = new Date(Date.UTC(2026, 9, 9, 14, 15, 16));
  const output = writeMetadata(input, {
    created: new Date(ORIGINAL_DATE).toISOString(),
    totalTime: '135',
  }, 'form', operationTime);
  const metadata = readMetadata(output).metadata;
  assert.equal(metadata.created, new Date(ORIGINAL_DATE).toISOString());
  assert.equal(metadata.totalTime, '135');
  assert.equal(metadata.modified, operationTime.toISOString());
});

test('template mode applies optional standard dates while last-save uses operation time', () => {
  const input = makeInput();
  const operationTime = new Date(Date.UTC(2026, 9, 9, 16, 0, 0));
  const created = new Date(Date.UTC(2022, 1, 3, 4, 5, 6));
  const output = writeMetadata(input, {
    title: 'Template with date',
    created: created.toISOString(),
  }, 'template', operationTime);
  const metadata = readMetadata(output).metadata;
  assert.equal(metadata.created, created.toISOString());
  assert.equal(metadata.modified, operationTime.toISOString());
});

test('converts a legacy ANSI property section to Unicode before writing Chinese values', () => {
  const ansiSummary = propertySet([{
    fmtid: SUMMARY,
    properties: [
      { id: 1, raw: int16(1252) },
      { id: 2, raw: typed(30, Buffer.from([5, 0, 0, 0, 0x4F, 0x6C, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00])) },
      { id: 99, raw: typed(0x7777, Buffer.from([0x10, 0x20, 0x30, 0x40])) },
    ],
  }]);
  const input = makeDoc({ streams: { '\u0005SummaryInformation': ansiSummary } });
  const output = writeMetadata(input, { title: '中文标题' }, 'form', new Date(ORIGINAL_DATE));
  const read = readMetadata(output).metadata;
  assert.equal(read.title, '中文标题');
  assert.equal(read.subject, '');
  const summary = propertySetIn(output, '\u0005SummaryInformation');
  assert.equal(summary.sections[0].codePage, 1200);
  assert.ok(Buffer.from(summary.sections[0].properties.get(99).rawValue)
    .equals(typed(0x7777, Buffer.from([0x10, 0x20, 0x30, 0x40]))));
});

test('rejects ANSI conversion if an opaque string vector depends on the original code page', () => {
  const ansiSummary = propertySet([{
    fmtid: SUMMARY,
    properties: [
      { id: 1, raw: int16(1252) },
      { id: 99, raw: typed(0x101E, Buffer.alloc(4)) },
    ],
  }]);
  const input = makeDoc({ streams: { '\u0005SummaryInformation': ansiSummary } });
  assert.throws(() => writeMetadata(input, { title: '中文' }, 'form'), /code-page-dependent/i);
});

test('keeps an ANSI code page and opaque vectors when the edited values are representable', () => {
  const opaqueVector = typed(0x100C, Buffer.alloc(4));
  const ansiSummary = propertySet([{
    fmtid: SUMMARY,
    properties: [
      { id: 1, raw: int16(1252) },
      { id: 99, raw: opaqueVector },
    ],
  }]);
  const input = makeDoc({ streams: { '\u0005SummaryInformation': ansiSummary } });
  const output = writeMetadata(input, { title: 'Ordinary English title' }, 'form', new Date(ORIGINAL_DATE));
  const summary = propertySetIn(output, '\u0005SummaryInformation');
  assert.equal(summary.sections[0].codePage, 1252);
  assert.equal(readMetadata(output).metadata.title, 'Ordinary English title');
  assert.ok(Buffer.from(summary.sections[0].properties.get(99).rawValue).equals(opaqueVector));
});

test('rejects XOR-obfuscated Word documents', () => {
  const obfuscated = makeDoc({ obfuscated: true });
  assert.throws(() => writeMetadata(obfuscated, { title: 'x' }, 'form'), /obfuscated/i);
});
