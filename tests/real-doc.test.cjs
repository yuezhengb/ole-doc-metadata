const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const CFB = require('@stackline/cfb');
const { classifyDoc, readDocMetadata, writeDocMetadata } = require('../src');
const { readMetadataIndependently } = require('./helpers/independent-hpsf-reader.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'Bug49820.doc');
const PROPERTY_STREAMS = new Set([
  '\u0005SummaryInformation',
  '\u0005DocumentSummaryInformation',
]);

function nonPropertyStreams(bytes) {
  const cfb = CFB.parse(bytes);
  const streams = new Map();
  for (let index = 0; index < cfb.FullPaths.length; index += 1) {
    const entry = cfb.FileIndex[index];
    if (entry?.type !== 2) continue;
    const name = String(cfb.FullPaths[index]).replace(/^Root Entry\//iu, '');
    if (PROPERTY_STREAMS.has(name)) continue;
    streams.set(name, Buffer.from(entry.content));
  }
  return streams;
}

test('rewrites a real Apache POI legacy DOC sample in all modes without changing other streams', () => {
  const input = new Uint8Array(fs.readFileSync(FIXTURE));
  assert.deepEqual(classifyDoc(input), { supported: true, reason: null });
  const before = nonPropertyStreams(input);
  const operationTime = new Date('2026-10-09T12:34:56.000Z');
  const cases = [
    {
      mode: 'form',
      values: {
        title: 'Direct DOC interoperability check',
        author: 'DOC browser editor',
        category: 'Internal',
        status: 'Draft',
      },
      expectedTitle: 'Direct DOC interoperability check',
      expected: {
        author: 'DOC browser editor',
        company: 'KIOS s.r.o',
        status: 'Draft',
        copyright: '',
      },
    },
    {
      mode: 'template',
      values: {
        title: 'Sofos & Partners - Legal Document',
        author: 'Sofos Legal Team',
        category: 'Legal Document',
        status: 'Final',
        company: 'Sofos & Partners',
        copyright: '© 2026 Sofos & Partners',
      },
      expectedTitle: 'Sofos & Partners - Legal Document',
      expected: {
        author: 'Sofos Legal Team',
        company: 'Sofos & Partners',
        status: 'Final',
        copyright: '© 2026 Sofos & Partners',
      },
    },
    {
      mode: 'clear',
      values: { title: 'Stale form value', author: 'Stale author' },
      expectedTitle: '',
      expected: { author: '', company: '', status: '', copyright: '' },
    },
  ];

  for (const { mode, values, expectedTitle, expected } of cases) {
    const output = writeDocMetadata(input, values, mode, operationTime);
    const metadata = readDocMetadata(output).metadata;
    const independent = readMetadataIndependently(output);
    assert.equal(metadata.title, expectedTitle, `${mode} title`);
    assert.equal(metadata.modified, operationTime.toISOString(), `${mode} operation time`);
    assert.equal(independent.title, expectedTitle, `${mode} independent title`);
    assert.equal(independent.modified, operationTime.toISOString(), `${mode} independent modified`);
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(independent[field], value, `${mode} independent ${field}`);
    }
    const after = nonPropertyStreams(output);
    assert.equal(after.size, before.size, `${mode} non-property stream count`);
    for (const [name, contents] of before) {
      assert.ok(after.get(name)?.equals(contents), `${mode} preserves ${name}`);
    }
  }
});
