const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { makeDoc } = require('./helpers/hpsf-fixture.cjs');

const root = path.resolve(__dirname, '..');

test('browser bundle loads with the bundled CFB dependency and edits bytes without Node globals', () => {
  const context = vm.createContext({
    TextDecoder,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    BigInt,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'vendor/cfb.min.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'dist/ole-doc-metadata.js'), 'utf8'), context);

  const api = context.OLEDocMetadata;
  assert.equal(typeof api?.readDocMetadata, 'function');
  assert.equal(typeof api?.writeDocMetadata, 'function');
  const input = new context.Uint8Array(makeDoc());
  const output = api.writeDocMetadata(input, { title: 'Browser only' }, 'form', new Date('2026-10-09T12:00:00.000Z'));
  assert.equal(api.readDocMetadata(output).metadata.title, 'Browser only');
  assert.equal(context.Buffer, undefined);
  assert.equal(context.process, undefined);
});
