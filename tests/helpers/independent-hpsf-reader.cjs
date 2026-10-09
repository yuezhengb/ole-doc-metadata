const CFB = require('@stackline/cfb');

const SUMMARY = 'e0859ff2f94f6810ab9108002b27b3d9';
const DOCUMENT_SUMMARY = '02d5cdd59c2e1b10939708002b2cf9ae';
const USER_DEFINED = '05d5cdd59c2e1b10939708002b2cf9ae';
const FILETIME_EPOCH = 116444736000000000n;

function u16(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function u32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function i32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true);
}

function u64(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

function readDictionary(bytes, codePage) {
  const count = u32(bytes, 0);
  const values = new Map();
  let cursor = 4;
  for (let i = 0; i < count; i += 1) {
    const id = u32(bytes, cursor);
    const nameLength = u32(bytes, cursor + 4);
    cursor += 8;
    const byteLength = codePage === 1200 ? nameLength * 2 : nameLength;
    const nameBytes = bytes.subarray(cursor, cursor + byteLength);
    const name = codePage === 1200
      ? Buffer.from(nameBytes).toString('utf16le').replace(/\0+$/u, '')
      : Buffer.from(nameBytes).toString('latin1').replace(/\0+$/u, '');
    values.set(id, name);
    cursor += byteLength;
    if (codePage === 1200) cursor = (cursor + 3) & ~3;
  }
  return values;
}

function readValue(bytes, codePage) {
  const type = u32(bytes, 0);
  if (type === 2) return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(4, true);
  if (type === 3) return i32(bytes, 4);
  if (type === 30 || type === 8) {
    const byteLength = u32(bytes, 4);
    const textBytes = bytes.subarray(8, 8 + byteLength);
    return codePage === 1200
      ? Buffer.from(textBytes).toString('utf16le').replace(/\0+$/u, '')
      : Buffer.from(textBytes).toString('latin1').replace(/\0+$/u, '');
  }
  if (type === 31) {
    const byteLength = u32(bytes, 4) * 2;
    return Buffer.from(bytes.subarray(8, 8 + byteLength)).toString('utf16le').replace(/\0+$/u, '');
  }
  if (type === 0x40) {
    const milliseconds = Number((u64(bytes, 4) - FILETIME_EPOCH) / 10000n);
    return new Date(milliseconds).toISOString();
  }
  return undefined;
}

function readSections(stream) {
  if (u16(stream, 0) !== 0xFFFE) throw new Error('Independent reader: invalid byte order');
  const sectionCount = u32(stream, 24);
  const sections = new Map();
  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
    const header = 28 + sectionIndex * 20;
    const fmtid = Buffer.from(stream.subarray(header, header + 16)).toString('hex');
    const offset = u32(stream, header + 16);
    const size = u32(stream, offset);
    const count = u32(stream, offset + 4);
    const rows = [];
    for (let row = 0; row < count; row += 1) {
      const rowOffset = offset + 8 + row * 8;
      rows.push({ id: u32(stream, rowOffset), valueOffset: u32(stream, rowOffset + 4) });
    }
    const codePageRow = rows.find(row => row.id === 1);
    const codePage = codePageRow ? readValue(stream.subarray(
      offset + codePageRow.valueOffset,
      offset + (rows.find(row => row.valueOffset > codePageRow.valueOffset)?.valueOffset || size),
    ), 1200) : 1200;
    const properties = new Map();
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const end = rows[rowIndex + 1]?.valueOffset || size;
      const bytes = stream.subarray(offset + row.valueOffset, offset + end);
      properties.set(row.id, row.id === 0 ? readDictionary(bytes, codePage) : readValue(bytes, codePage));
    }
    sections.set(fmtid, properties);
  }
  return sections;
}

function readMetadataIndependently(input) {
  const cfb = CFB.parse(input);
  const summaryStream = CFB.find(cfb, `/\u0005SummaryInformation`);
  const documentSummaryStream = CFB.find(cfb, `/\u0005DocumentSummaryInformation`);
  if (!summaryStream || !documentSummaryStream) throw new Error('Independent reader: missing property stream');
  const summary = readSections(new Uint8Array(summaryStream.content)).get(SUMMARY) || new Map();
  const documentSummarySections = readSections(new Uint8Array(documentSummaryStream.content));
  const documentSummary = documentSummarySections.get(DOCUMENT_SUMMARY) || new Map();
  const custom = documentSummarySections.get(USER_DEFINED) || new Map();
  const names = custom.get(0) || new Map();
  let copyright = '';
  for (const [id, name] of names) {
    if (String(name).toLowerCase() === 'copyright') copyright = custom.get(id) || '';
  }
  return {
    title: summary.get(2) || '',
    author: summary.get(4) || '',
    modified: summary.get(13) || '',
    company: documentSummary.get(15) || '',
    status: documentSummary.get(27) || '',
    copyright,
  };
}

module.exports = { readMetadataIndependently };
