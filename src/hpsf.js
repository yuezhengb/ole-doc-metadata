(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OLEHPSF = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

const MAX_PROPERTY_SET_BYTES = 2 * 1024 * 1024;
const FILETIME_EPOCH_TICKS = 116444736000000000n;

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (Array.isArray(input)) return Uint8Array.from(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('Expected an ArrayBuffer or byte array');
}

function readU16(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function readI16(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(offset, true);
}

function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readI32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true);
}

function assertRange(start, length, limit, label) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 ||
      start + length > limit) {
    throw new RangeError(`Invalid or truncated ${label}`);
  }
}

function align4(length) {
  return (length + 3) & ~3;
}

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function concatBytes(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function writeU16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function writeU32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function codePageLabel(codePage) {
  const labels = {
    874: 'windows-874',
    932: 'shift_jis',
    936: 'gbk',
    949: 'euc-kr',
    950: 'big5',
    1250: 'windows-1250',
    1251: 'windows-1251',
    1252: 'windows-1252',
    1253: 'windows-1253',
    1254: 'windows-1254',
    1255: 'windows-1255',
    1256: 'windows-1256',
    1257: 'windows-1257',
    1258: 'windows-1258',
    65001: 'utf-8',
  };
  if (codePage === 1200) return 'utf-16le';
  return labels[codePage] || `windows-${codePage}`;
}

function decodeText(bytes, codePage) {
  try {
    return new TextDecoder(codePageLabel(codePage), { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Unsupported or invalid HPSF code page ${codePage}: ${error.message}`);
  }
}

function decodeCodePageString(bytes, codePage) {
  assertRange(0, 4, bytes.length, 'CodePageString length');
  const length = readU32(bytes, 0);
  if (length === 0) return '';
  if (codePage === 1200 && length % 2 !== 0) throw new Error('Invalid Unicode CodePageString size');
  assertRange(4, length, bytes.length, 'CodePageString data');
  const data = bytes.subarray(4, 4 + length);
  const terminatorSize = codePage === 1200 ? 2 : 1;
  if (length < terminatorSize ||
      (terminatorSize === 2 ? data[length - 1] !== 0 || data[length - 2] !== 0 : data[length - 1] !== 0)) {
    throw new Error('Unterminated CodePageString');
  }
  return decodeText(data, codePage).replace(/\0+$/u, '');
}

function parseDictionary(bytes, codePage) {
  assertRange(0, 4, bytes.length, 'Dictionary count');
  const count = readU32(bytes, 0);
  if (count > Math.floor(bytes.length / 8)) throw new RangeError('Invalid Dictionary count');
  let offset = 4;
  const entries = [];
  const ids = new Set();
  const names = new Set();
  for (let i = 0; i < count; i += 1) {
    assertRange(offset, 8, bytes.length, 'Dictionary entry header');
    const id = readU32(bytes, offset);
    const length = readU32(bytes, offset + 4);
    offset += 8;
    if (id < 2 || id > 0x7FFFFFFF || ids.has(id)) throw new Error('Invalid or duplicate Dictionary identifier');
    const byteLength = codePage === 1200 ? length * 2 : length;
    assertRange(offset, byteLength, bytes.length, 'Dictionary entry name');
    const data = bytes.subarray(offset, offset + byteLength);
    const terminatorSize = codePage === 1200 ? 2 : 1;
    if (length < 1 ||
        (terminatorSize === 2 ? data[byteLength - 1] !== 0 || data[byteLength - 2] !== 0 : data[byteLength - 1] !== 0)) {
      throw new Error('Unterminated Dictionary entry name');
    }
    const name = decodeText(data, codePage).replace(/\0+$/u, '');
    const normalized = name.toLocaleLowerCase('en-US');
    if (!name || names.has(normalized)) throw new Error('Invalid or duplicate Dictionary name');
    ids.add(id);
    names.add(normalized);
    entries.push([id, name]);
    offset += byteLength;
    if (codePage === 1200) offset = align4(offset);
  }
  if (offset > bytes.length) throw new RangeError('Invalid Dictionary padding');
  return entries;
}

function decodeTypedValue(rawValue, codePage) {
  const raw = asBytes(rawValue);
  assertRange(0, 4, raw.length, 'TypedPropertyValue type');
  const type = readU32(raw, 0);
  if (type === 2) {
    assertRange(4, 4, raw.length, 'VT_I2 value');
    return { type, value: readI16(raw, 4) };
  }
  if (type === 3) {
    assertRange(4, 4, raw.length, 'VT_I4 value');
    return { type, value: readI32(raw, 4) };
  }
  if (type === 30 || type === 8) {
    return { type, value: decodeCodePageString(raw.subarray(4), codePage) };
  }
  if (type === 31) {
    assertRange(4, 4, raw.length, 'VT_LPWSTR length');
    const characterCount = readU32(raw, 4);
    const byteLength = characterCount * 2;
    assertRange(8, byteLength, raw.length, 'VT_LPWSTR data');
    const data = raw.subarray(8, 8 + byteLength);
    if (characterCount && (data[byteLength - 1] !== 0 || data[byteLength - 2] !== 0)) {
      throw new Error('Unterminated VT_LPWSTR');
    }
    return { type, value: decodeText(data, 1200).replace(/\0+$/u, '') };
  }
  if (type === 0x40) {
    assertRange(4, 8, raw.length, 'VT_FILETIME value');
    const ticks = (BigInt(readU32(raw, 8)) << 32n) | BigInt(readU32(raw, 4));
    const milliseconds = Number((ticks - FILETIME_EPOCH_TICKS) / 10000n);
    if (!Number.isFinite(milliseconds)) throw new RangeError('Invalid VT_FILETIME value');
    return { type, value: milliseconds };
  }
  if (type === 11) {
    assertRange(4, 4, raw.length, 'VT_BOOL value');
    return { type, value: readI16(raw, 4) !== 0 };
  }
  return { type, value: undefined };
}

function parseSection(bytes, offset, end) {
  assertRange(offset, 8, end, 'PropertySet header');
  const size = readU32(bytes, offset);
  if (size < 8 || size % 4 !== 0) throw new RangeError('Invalid PropertySet size or alignment');
  assertRange(offset, size, end, 'PropertySet size');
  const count = readU32(bytes, offset + 4);
  if (count < 1 || count > Math.floor((size - 8) / 8)) throw new RangeError('Invalid property count');
  const tableEnd = 8 + count * 8;
  const rows = [];
  const ids = new Set();
  const valueOffsets = new Set();
  let priorOffset = -1;
  for (let i = 0; i < count; i += 1) {
    const rowOffset = offset + 8 + i * 8;
    const id = readU32(bytes, rowOffset);
    const valueOffset = readU32(bytes, rowOffset + 4);
    if (ids.has(id)) throw new Error('Duplicate property identifier');
    if (valueOffset < tableEnd || valueOffset >= size ||
        valueOffsets.has(valueOffset) || valueOffset <= priorOffset) {
      throw new RangeError('Invalid or unordered property offset');
    }
    ids.add(id);
    valueOffsets.add(valueOffset);
    priorOffset = valueOffset;
    rows.push({ id, valueOffset });
  }
  const properties = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const valueEnd = i + 1 < rows.length ? rows[i + 1].valueOffset : size;
    const rawValue = bytes.slice(offset + row.valueOffset, offset + valueEnd);
    if (row.id === 0) {
      properties.set(row.id, { id: row.id, type: 'dictionary', value: undefined, rawValue });
    } else {
      const decoded = decodeTypedValue(rawValue, 1252);
      properties.set(row.id, { id: row.id, ...decoded, rawValue });
    }
  }
  const codePageProperty = properties.get(1);
  if (!codePageProperty || codePageProperty.type !== 2 || !Number.isInteger(codePageProperty.value) ||
      codePageProperty.value <= 0) {
    throw new Error('PropertySet is missing a valid CodePage property');
  }
  const codePage = codePageProperty.value;
  for (const property of properties.values()) {
    if (property.id === 0) property.value = parseDictionary(property.rawValue, codePage);
    else if (property.type === 30 || property.type === 8) {
      property.value = decodeCodePageString(property.rawValue.subarray(4), codePage);
    }
  }
  return {
    size,
    codePage,
    properties,
    trailingBytes: bytes.slice(offset + size, end),
  };
}

function parsePropertySet(input) {
  const bytes = asBytes(input);
  if (bytes.length > MAX_PROPERTY_SET_BYTES) throw new RangeError('PropertySetStream exceeds 2 MiB limit');
  assertRange(0, 28, bytes.length, 'PropertySetStream header');
  if (readU16(bytes, 0) !== 0xFFFE) throw new Error('Invalid PropertySetStream byte order');
  const version = readU16(bytes, 2);
  if (version > 1) throw new Error('Unsupported PropertySetStream version');
  const systemIdentifier = readU32(bytes, 4);
  const clsid = bytes.slice(8, 24);
  const count = readU32(bytes, 24);
  if (count < 1 || count > 2) throw new RangeError('Invalid PropertySetStream property set count');
  const headerLength = 28 + count * 20;
  assertRange(0, headerLength, bytes.length, 'PropertySetStream section table');
  const headers = [];
  const formatIds = new Set();
  for (let i = 0; i < count; i += 1) {
    const headerOffset = 28 + i * 20;
    const fmtid = hex(bytes.slice(headerOffset, headerOffset + 16));
    if (formatIds.has(fmtid)) throw new Error('Duplicate PropertySet FMTID');
    formatIds.add(fmtid);
    headers.push({
      fmtid,
      offset: readU32(bytes, headerOffset + 16),
    });
  }
  const offsets = headers.map(section => section.offset);
  if (offsets.some((offset, index) => offset < headerLength || offset % 4 !== 0 ||
      (index > 0 && offset <= offsets[index - 1]))) {
    throw new RangeError('Invalid or unordered PropertySet section offset');
  }
  const sections = headers.map((header, index) => {
    const end = index + 1 < headers.length ? headers[index + 1].offset : bytes.length;
    return { fmtid: header.fmtid, ...parseSection(bytes, header.offset, end) };
  });
  return { byteOrder: 0xFFFE, version, systemIdentifier, clsid, sections };
}

function encodeCodePageText(text, codePage) {
  const value = String(text);
  if (codePage === 1200) {
    const bytes = new Uint8Array((value.length + 1) * 2);
    for (let i = 0; i < value.length; i += 1) {
      new DataView(bytes.buffer).setUint16(i * 2, value.charCodeAt(i), true);
    }
    return bytes;
  }
  if (codePage === 65001) return new TextEncoder().encode(`${value}\0`);
  const asciiCompatibleCodePages = new Set([
    874, 932, 936, 949, 950, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258,
  ]);
  if (asciiCompatibleCodePages.has(codePage) && /^[\x00-\x7F]*$/u.test(value)) {
    return Uint8Array.from([...value].map(character => character.charCodeAt(0)).concat(0));
  }
  if (codePage === 1252) {
    const output = [];
    const high = new Map([
      [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84], [0x2026, 0x85],
      [0x2020, 0x86], [0x2021, 0x87], [0x02C6, 0x88], [0x2030, 0x89], [0x0160, 0x8A],
      [0x2039, 0x8B], [0x0152, 0x8C], [0x017D, 0x8E], [0x2018, 0x91], [0x2019, 0x92],
      [0x201C, 0x93], [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
      [0x02DC, 0x98], [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B], [0x0153, 0x9C],
      [0x017E, 0x9E], [0x0178, 0x9F],
    ]);
    for (const char of value) {
      const code = char.codePointAt(0);
      if (code <= 0x7F || (code >= 0xA0 && code <= 0xFF)) output.push(code);
      else if (high.has(code)) output.push(high.get(code));
      else throw new Error('Value cannot be represented in the document code page');
    }
    output.push(0);
    return Uint8Array.from(output);
  }
  throw new Error(`Writing code page ${codePage} is not supported for changed values`);
}

function canEncodeCodePageText(text, codePage) {
  try {
    encodeCodePageText(text, codePage);
    return true;
  } catch (_) {
    return false;
  }
}

function encodeProperty(property, codePage) {
  if (property.id === 0 && (property.type === 'dictionary' || Array.isArray(property.value))) {
    const rows = [writeU32(property.value.length)];
    for (const [id, name] of property.value) {
      const encoded = encodeCodePageText(name, codePage);
      const length = codePage === 1200 ? encoded.length / 2 : encoded.length;
      rows.push(writeU32(id), writeU32(length), encoded);
      if (codePage === 1200 && encoded.length % 4) rows.push(new Uint8Array(4 - (encoded.length % 4)));
    }
    return concatBytes(rows);
  }
  const type = property.type;
  const value = property.value;
  if (type === 2) return concatBytes([writeU32(type), writeU16(value), new Uint8Array(2)]);
  if (type === 3) return concatBytes([writeU32(type), writeU32(value)]);
  if (type === 30 || type === 8) {
    const encoded = encodeCodePageText(value, codePage);
    return concatBytes([writeU32(type), writeU32(encoded.length), encoded,
      new Uint8Array(align4(encoded.length) - encoded.length)]);
  }
  if (type === 31) {
    const encoded = encodeCodePageText(value, 1200);
    return concatBytes([writeU32(type), writeU32(encoded.length / 2), encoded,
      new Uint8Array(align4(encoded.length) - encoded.length)]);
  }
  if (type === 0x40) {
    const ticks = BigInt(Math.trunc(Number(value))) * 10000n + FILETIME_EPOCH_TICKS;
    return concatBytes([writeU32(type), writeU32(Number(ticks & 0xFFFFFFFFn)),
      writeU32(Number((ticks >> 32n) & 0xFFFFFFFFn))]);
  }
  if (type === 11) return concatBytes([writeU32(type), writeU16(value ? 0xFFFF : 0), new Uint8Array(2)]);
  throw new Error(`Cannot encode HPSF property type ${type}`);
}

function serializeSection(section) {
  const properties = [...section.properties.values()].sort((left, right) => left.id - right.id);
  const tableSize = 8 + properties.length * 8;
  const records = [];
  const values = [];
  let offset = tableSize;
  for (const property of properties) {
    const value = property.rawValue && !property.dirty
      ? asBytes(property.rawValue)
      : encodeProperty(property, section.codePage);
    if (value.length === 0) throw new Error('HPSF property value cannot be empty');
    const padding = align4(value.length) - value.length;
    records.push({ id: property.id, offset });
    values.push(value, new Uint8Array(padding));
    offset += value.length + padding;
  }
  const header = new Uint8Array(tableSize);
  new DataView(header.buffer).setUint32(0, tableSize + values.reduce((sum, value) => sum + value.length, 0), true);
  new DataView(header.buffer).setUint32(4, properties.length, true);
  records.forEach((record, index) => {
    const view = new DataView(header.buffer);
    view.setUint32(8 + index * 8, record.id, true);
    view.setUint32(12 + index * 8, record.offset, true);
  });
  return concatBytes([header, ...values]);
}

function serializePropertySet(propertySet) {
  if (!propertySet || !Array.isArray(propertySet.sections) ||
      propertySet.sections.length < 1 || propertySet.sections.length > 2) {
    throw new TypeError('PropertySetStream must contain one or two sections');
  }
  const serializedSections = propertySet.sections.map(section => concatBytes([
    serializeSection(section), section.trailingBytes ? asBytes(section.trailingBytes) : new Uint8Array(0),
  ]));
  const headerLength = 28 + serializedSections.length * 20;
  const header = new Uint8Array(headerLength);
  const view = new DataView(header.buffer);
  view.setUint16(0, 0xFFFE, true);
  view.setUint16(2, propertySet.version || 0, true);
  view.setUint32(4, propertySet.systemIdentifier || 0x00020006, true);
  const clsid = propertySet.clsid ? asBytes(propertySet.clsid) : new Uint8Array(16);
  if (clsid.length !== 16) throw new RangeError('HPSF CLSID must contain 16 bytes');
  header.set(clsid, 8);
  view.setUint32(24, serializedSections.length, true);
  let offset = headerLength;
  propertySet.sections.forEach((section, index) => {
    const fmtid = Uint8Array.from(String(section.fmtid).match(/.{2}/g) || [], pair => parseInt(pair, 16));
    if (fmtid.length !== 16) throw new RangeError('HPSF FMTID must contain 16 bytes');
    const record = 28 + index * 20;
    header.set(fmtid, record);
    view.setUint32(record + 16, offset, true);
    offset += serializedSections[index].length;
  });
  const output = concatBytes([header, ...serializedSections]);
  if (output.length > MAX_PROPERTY_SET_BYTES) throw new RangeError('PropertySetStream exceeds 2 MiB limit');
  return output;
}

return { canEncodeCodePageText, parsePropertySet, serializePropertySet };
});
