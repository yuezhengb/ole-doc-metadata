const assert = require('node:assert/strict');
const test = require('node:test');
const { makeDoc } = require('./helpers/hpsf-fixture.cjs');

let api = null;
try {
  api = require('../src/index.js');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes('../src/index.js')) throw error;
}

function classify(bytes) {
  assert.equal(typeof api?.classifyDoc, 'function', 'classifyDoc export should exist');
  return api.classifyDoc(bytes);
}

test('accepts an unencrypted Word CFB with its FIB-selected table stream', () => {
  assert.deepEqual(classify(makeDoc({ whichTable: 1, includeUnselectedTable: true })), {
    supported: true,
    reason: null,
  });
});

test('rejects input without the CFB signature', () => {
  assert.deepEqual(classify(new Uint8Array(512)), { supported: false, reason: 'notCfb' });
});

test('rejects a compound file without WordDocument', () => {
  assert.deepEqual(classify(makeDoc({ includeWordDocument: false })), {
    supported: false,
    reason: 'notWord',
  });
});

test('rejects a missing table stream selected by fWhichTblStm', () => {
  assert.deepEqual(classify(makeDoc({ whichTable: 1, includeSelectedTable: false })), {
    supported: false,
    reason: 'missingTableStream',
  });
});

test('rejects a truncated FIB base', () => {
  assert.deepEqual(classify(makeDoc({ length: 31 })), { supported: false, reason: 'malformed' });
});

test('rejects encrypted and XOR-obfuscated Word files', () => {
  assert.deepEqual(classify(makeDoc({ encrypted: true })), { supported: false, reason: 'encrypted' });
  assert.deepEqual(classify(makeDoc({ encrypted: true, obfuscated: true })), {
    supported: false,
    reason: 'encrypted',
  });
});
