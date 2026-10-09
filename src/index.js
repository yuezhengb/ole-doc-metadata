(function (root, factory) {
  const isCommonJS = typeof module === 'object' && module.exports;
  const CFB = isCommonJS ? require('@stackline/cfb') : root.CFB;
  const HPSF = isCommonJS ? require('./hpsf') : root.OLEHPSF;
  const createMetadataApi = isCommonJS ? require('./metadata') : root.OLEDocMetadataCore;
  const api = factory(CFB, HPSF, createMetadataApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OLEDocMetadata = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CFB, HPSF, createMetadataApi) {
  'use strict';

  const CFB_SIGNATURE = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

  function toUint8Array(input) {
    if (input instanceof Uint8Array) return input;
    if (Array.isArray(input)) return Uint8Array.from(input);
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    throw new TypeError('Expected an ArrayBuffer or byte array');
  }

  function rootStream(cfb, name) {
    const wanted = String(name).toLowerCase();
    for (let i = 0; i < cfb.FullPaths.length; i += 1) {
      let path = String(cfb.FullPaths[i]).replace(/^\/+/, '');
      const slash = path.indexOf('/');
      if (slash !== -1) path = path.slice(slash + 1);
      if (path && !path.includes('/') && path.toLowerCase() === wanted) {
        const entry = cfb.FileIndex[i];
        if (entry && !entry.type || entry && entry.type === 2) return entry;
      }
    }
    return null;
  }

  function classifyDoc(input) {
    let bytes;
    try {
      bytes = toUint8Array(input);
    } catch (_) {
      return { supported: false, reason: 'notCfb' };
    }
    if (bytes.length < CFB_SIGNATURE.length ||
        !CFB_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
      return { supported: false, reason: 'notCfb' };
    }

    let cfb;
    try {
      if (!CFB || typeof CFB.parse !== 'function') throw new Error('CFB parser is unavailable');
      cfb = CFB.parse(bytes);
    } catch (_) {
      return { supported: false, reason: 'malformed' };
    }

    const wordDocument = rootStream(cfb, 'WordDocument');
    if (!wordDocument) return { supported: false, reason: 'notWord' };
    const fib = toUint8Array(wordDocument.content);
    if (fib.length < 32) return { supported: false, reason: 'malformed' };
    const view = new DataView(fib.buffer, fib.byteOffset, fib.byteLength);
    if (view.getUint16(0, true) !== 0xA5EC) return { supported: false, reason: 'malformed' };

    const flags = view.getUint16(10, true);
    if ((flags & 0x0100) !== 0) return { supported: false, reason: 'encrypted' };
    if ((flags & 0x8000) !== 0) return { supported: false, reason: 'obfuscated' };
    const tableName = (flags & 0x0200) !== 0 ? '1Table' : '0Table';
    if (!rootStream(cfb, tableName)) {
      return { supported: false, reason: 'missingTableStream' };
    }
    return { supported: true, reason: null };
  }

  const metadataApi = createMetadataApi({ CFB, HPSF, classifyDoc, rootStream, toUint8Array });
  return Object.assign({ classifyDoc }, metadataApi);
});
