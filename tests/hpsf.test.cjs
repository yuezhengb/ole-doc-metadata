const assert = require('node:assert/strict');
const test = require('node:test');
const { dictionary, filetime, int16, int32, propertySet, string, typed } = require('./helpers/hpsf-packets.cjs');

let HPSF = null;
try {
  HPSF = require('../src/hpsf.js');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes('../src/hpsf.js')) throw error;
}

const SUMMARY = 'e0859ff2f94f6810ab9108002b27b3d9';
const DOC_SUMMARY = '02d5cdd59c2e1b10939708002b2cf9ae';
const USER_DEFINED = '05d5cdd59c2e1b10939708002b2cf9ae';
const CODEPAGE = int16(1200);

function parse(bytes) {
  assert.equal(typeof HPSF?.parsePropertySet, 'function', 'parsePropertySet export should exist');
  return HPSF.parsePropertySet(bytes);
}

test('parses SummaryInformation title, Unicode text, and FILETIME', () => {
  const createdMs = Date.UTC(2026, 9, 9, 7, 8, 9);
  const bytes = propertySet([{
    fmtid: SUMMARY,
    properties: [
      { id: 1, raw: CODEPAGE },
      { id: 2, raw: string('合同标题') },
      { id: 12, raw: filetime(createdMs) },
    ],
  }]);
  const parsed = parse(bytes);
  assert.equal(parsed.sections[0].fmtid, SUMMARY);
  assert.equal(parsed.sections[0].properties.get(1).value, 1200);
  assert.equal(parsed.sections[0].properties.get(2).value, '合同标题');
  assert.equal(parsed.sections[0].properties.get(12).value, createdMs);
});

test('parses DocumentSummaryInformation and its user-defined dictionary section', () => {
  const bytes = propertySet([
    {
      fmtid: DOC_SUMMARY,
      properties: [{ id: 1, raw: CODEPAGE }, { id: 2, raw: string('Legal Document') }],
    },
    {
      fmtid: USER_DEFINED,
      properties: [
        { id: 0, raw: dictionary([[2, 'Content Status']]) },
        { id: 1, raw: CODEPAGE },
        { id: 2, raw: string('Internal') },
      ],
    },
  ]);
  const parsed = parse(bytes);
  assert.equal(parsed.sections.length, 2);
  assert.equal(parsed.sections[0].properties.get(2).value, 'Legal Document');
  assert.deepEqual(parsed.sections[1].properties.get(0).value, [[2, 'Content Status']]);
  assert.equal(parsed.sections[1].properties.get(2).value, 'Internal');
});

test('preserves an unsupported typed value exactly across a parse/serialize round trip', () => {
  const opaque = typed(0x7777, Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));
  const bytes = propertySet([{
    fmtid: SUMMARY,
    properties: [{ id: 1, raw: CODEPAGE }, { id: 99, raw: opaque }],
  }]);
  assert.equal(typeof HPSF?.serializePropertySet, 'function', 'serializePropertySet export should exist');
  const parsed = parse(bytes);
  assert.ok(Buffer.from(parsed.sections[0].properties.get(99).rawValue).equals(opaque));
  const reparsed = parse(HPSF.serializePropertySet(parsed));
  assert.ok(Buffer.from(reparsed.sections[0].properties.get(99).rawValue).equals(opaque));
});

test('accepts ordered in-bounds legacy property offsets and normalizes them when serialized', () => {
  const bytes = Buffer.from(propertySet([{
    fmtid: SUMMARY,
    properties: [
      { id: 1, raw: CODEPAGE },
      { id: 2, raw: string('AB') },
      { id: 3, raw: int32(42) },
    ],
  }]));
  const sectionOffset = 48;
  const thirdRow = sectionOffset + 8 + 2 * 8;
  const oldOffset = bytes.readUInt32LE(thirdRow + 4);
  const legacyOffset = oldOffset - 2;
  const oldValueStart = sectionOffset + oldOffset;

  // Some real-world HPSF writers omit the two alignment bytes after a
  // variable-length property. Keep the enclosing section size unchanged.
  bytes.copy(bytes, oldValueStart - 2, oldValueStart, oldValueStart + 8);
  bytes.writeUInt32LE(legacyOffset, thirdRow + 4);

  const parsed = parse(bytes);
  assert.equal(parsed.sections[0].properties.get(2).value, 'AB');
  assert.equal(parsed.sections[0].properties.get(3).value, 42);

  const normalized = Buffer.from(HPSF.serializePropertySet(parsed));
  const reparsed = parse(normalized);
  assert.equal(reparsed.sections[0].properties.get(2).value, 'AB');
  assert.equal(reparsed.sections[0].properties.get(3).value, 42);
  const normalizedSectionOffset = normalized.readUInt32LE(44);
  const normalizedThirdRow = normalizedSectionOffset + 8 + 2 * 8;
  assert.equal(normalized.readUInt32LE(normalizedThirdRow + 4) % 4, 0);
});

test('rejects invalid byte order, section offsets, property counts, duplicate identifiers, and truncation', () => {
  const base = propertySet([{
    fmtid: SUMMARY,
    properties: [{ id: 1, raw: CODEPAGE }, { id: 2, raw: string('Title') }],
  }]);
  const invalidByteOrder = Buffer.from(base);
  invalidByteOrder.writeUInt16LE(0x1234, 0);
  assert.throws(() => parse(invalidByteOrder), /byte order/i);

  const invalidOffset = Buffer.from(base);
  invalidOffset.writeUInt32LE(1, 48 + 12);
  assert.throws(() => parse(invalidOffset), /offset/i);

  const invalidCount = Buffer.from(base);
  invalidCount.writeUInt32LE(0xFFFFFFFF, 48 + 4);
  assert.throws(() => parse(invalidCount), /count/i);

  const duplicateIds = Buffer.from(base);
  duplicateIds.writeUInt32LE(1, 48 + 16);
  assert.throws(() => parse(duplicateIds), /duplicate/i);

  assert.throws(() => parse(base.subarray(0, base.length - 2)), /size|truncated/i);

  const nonAligned = Buffer.from(base);
  nonAligned.writeUInt32LE(nonAligned.readUInt32LE(48) - 1, 48);
  assert.throws(() => parse(nonAligned), /size|align/i);
});
