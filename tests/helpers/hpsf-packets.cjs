const { Buffer } = require('node:buffer');

function align4(length) {
  return (length + 3) & ~3;
}

function typed(type, payload) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(type, 0);
  return Buffer.concat([header, payload]);
}

function int16(value) {
  const payload = Buffer.alloc(4);
  payload.writeInt16LE(value, 0);
  return typed(2, payload);
}

function int32(value) {
  const payload = Buffer.alloc(4);
  payload.writeInt32LE(value, 0);
  return typed(3, payload);
}

function filetime(milliseconds) {
  const ticks = BigInt(Math.trunc(milliseconds)) * 10000n + 116444736000000000n;
  return filetimeTicks(ticks);
}

function filetimeTicks(ticks) {
  const payload = Buffer.alloc(8);
  const value = BigInt(ticks);
  payload.writeUInt32LE(Number(value & 0xFFFFFFFFn), 0);
  payload.writeUInt32LE(Number((value >> 32n) & 0xFFFFFFFFn), 4);
  return typed(0x40, payload);
}

function string(value) {
  const data = Buffer.from(`${value}\0`, 'utf16le');
  const payload = Buffer.alloc(4);
  payload.writeUInt32LE(data.length, 0);
  return typed(30, Buffer.concat([payload, data, Buffer.alloc(align4(data.length) - data.length)]));
}

function dictionary(entries) {
  const chunks = [Buffer.alloc(4)];
  chunks[0].writeUInt32LE(entries.length, 0);
  for (const [id, name] of entries) {
    const text = Buffer.from(`${name}\0`, 'utf16le');
    const header = Buffer.alloc(8);
    header.writeUInt32LE(id, 0);
    header.writeUInt32LE(text.length / 2, 4);
    chunks.push(header, text, Buffer.alloc(align4(text.length) - text.length));
  }
  return Buffer.concat(chunks);
}

function section(properties, { formatId, declaredCount } = {}) {
  const ordered = [...properties].sort((left, right) => left.id - right.id);
  const tableSize = 8 + ordered.length * 8;
  const records = [];
  const values = [];
  let offset = tableSize;
  for (const property of ordered) {
    const value = Buffer.from(property.raw);
    records.push({ id: property.id, offset });
    values.push(value, Buffer.alloc(align4(value.length) - value.length));
    offset += align4(value.length);
  }

  const header = Buffer.alloc(tableSize);
  header.writeUInt32LE(tableSize + values.reduce((sum, value) => sum + value.length, 0), 0);
  header.writeUInt32LE(declaredCount == null ? ordered.length : declaredCount, 4);
  records.forEach((record, index) => {
    header.writeUInt32LE(record.id, 8 + index * 8);
    header.writeUInt32LE(record.offset, 12 + index * 8);
  });
  return Buffer.concat([header, ...values]);
}

function propertySet(sectionSpecs) {
  const sectionBytes = sectionSpecs.map(spec => section(spec.properties, spec));
  const headerLength = 28 + sectionSpecs.length * 20;
  let offset = headerLength;
  const header = Buffer.alloc(headerLength);
  header.writeUInt16LE(0xFFFE, 0);
  header.writeUInt16LE(0, 2);
  header.writeUInt32LE(0x00020006, 4);
  header.writeUInt32LE(sectionSpecs.length, 24);
  sectionSpecs.forEach((spec, index) => {
    Buffer.from(spec.fmtid, 'hex').copy(header, 28 + index * 20);
    header.writeUInt32LE(offset, 44 + index * 20);
    offset += sectionBytes[index].length;
  });
  return Buffer.concat([header, ...sectionBytes]);
}

module.exports = { dictionary, filetime, filetimeTicks, int16, int32, propertySet, section, string, typed };
