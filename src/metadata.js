(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.OLEDocMetadataCore = factory;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMetadataApi(dependencies) {
  'use strict';

  const { CFB, HPSF, classifyDoc, rootStream, toUint8Array } = dependencies;

  const FMTID_SUMMARY = 'e0859ff2f94f6810ab9108002b27b3d9';
  const FMTID_DOCUMENT_SUMMARY = '02d5cdd59c2e1b10939708002b2cf9ae';
  const FMTID_USER_DEFINED = '05d5cdd59c2e1b10939708002b2cf9ae';
  const STREAM_SUMMARY = '\u0005SummaryInformation';
  const STREAM_DOCUMENT_SUMMARY = '\u0005DocumentSummaryInformation';
  const STREAM_SIGNATURE = '\u0005DigitalSignature';
  const TICKS_PER_MINUTE = 600000000n;

  const SUMMARY_FIELDS = new Map([
    ['title', 2], ['subject', 3], ['author', 4], ['keywords', 5],
    ['description', 6], ['lastModBy', 8], ['revision', 9],
    ['lastPrinted', 11], ['created', 12], ['modified', 13], ['producer', 18],
  ]);
  const DOCUMENT_SUMMARY_FIELDS = new Map([
    ['category', 2], ['manager', 14], ['company', 15], ['status', 27], ['version', 29],
  ]);
  const METADATA_KEYS = new Set([
    ...SUMMARY_FIELDS.keys(), ...DOCUMENT_SUMMARY_FIELDS.keys(),
    'totalTime', 'appVersion', 'copyright',
  ]);
  const CODEPAGE_SENSITIVE_TYPES = new Set([0x1008, 0x100C, 0x101E]);

  function clonePropertySet(propertySet) {
    return {
      ...propertySet,
      clsid: propertySet.clsid ? propertySet.clsid.slice() : undefined,
      sections: propertySet.sections.map(section => ({
        ...section,
        trailingBytes: section.trailingBytes ? section.trailingBytes.slice() : new Uint8Array(0),
        properties: new Map([...section.properties].map(([id, property]) => [id, {
          ...property,
          rawValue: property.rawValue ? property.rawValue.slice() : undefined,
          value: Array.isArray(property.value)
            ? property.value.map(entry => Array.isArray(entry) ? [...entry] : entry)
            : property.value,
        }])),
      })),
    };
  }

  function makeSection(fmtid) {
    return {
      fmtid,
      codePage: 1200,
      properties: new Map([[1, { id: 1, type: 2, value: 1200, dirty: true }]]),
      trailingBytes: new Uint8Array(0),
    };
  }

  function makePropertySet(fmtid) {
    return {
      byteOrder: 0xFFFE,
      version: 0,
      systemIdentifier: 0x00020006,
      clsid: new Uint8Array(16),
      sections: [makeSection(fmtid)],
    };
  }

  function getSection(propertySet, fmtid) {
    return propertySet.sections.find(section => section.fmtid.toLowerCase() === fmtid);
  }

  function ensureSection(propertySet, fmtid) {
    const existing = getSection(propertySet, fmtid);
    if (existing) return existing;
    if (propertySet.sections.length >= 2) {
      throw new Error(`Cannot safely add HPSF section ${fmtid}: the stream already has two sections`);
    }
    const section = makeSection(fmtid);
    propertySet.sections.push(section);
    return section;
  }

  function getPropertySet(cfb, streamName) {
    const stream = rootStream(cfb, streamName);
    if (!stream) return null;
    return HPSF.parsePropertySet(toUint8Array(stream.content));
  }

  function isoDate(property) {
    if (!property || property.type !== 0x40 || !Number.isFinite(property.value)) return '';
    const date = new Date(property.value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  function stringValue(section, id) {
    const property = section && section.properties.get(id);
    if (!property || ![8, 30, 31].includes(property.type) || typeof property.value !== 'string') return '';
    return property.value;
  }

  function integerValue(section, id) {
    const property = section && section.properties.get(id);
    return property && property.type === 3 && Number.isInteger(property.value) ? property.value : null;
  }

  function readDurationMinutes(property) {
    if (!property || property.type !== 0x40 || !property.rawValue || property.rawValue.length < 12) return '';
    const bytes = toUint8Array(property.rawValue);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ticks = (BigInt(view.getUint32(8, true)) << 32n) | BigInt(view.getUint32(4, true));
    const minutes = Number(ticks) / Number(TICKS_PER_MINUTE);
    return Number.isFinite(minutes) ? String(Number.isInteger(minutes) ? minutes : Number(minutes.toFixed(6))) : '';
  }

  function readCustomCopyright(section) {
    if (!section) return '';
    const dictionaryProperty = section.properties.get(0);
    if (!dictionaryProperty || !Array.isArray(dictionaryProperty.value)) return '';
    const entry = dictionaryProperty.value.find(([, name]) => String(name).toLocaleLowerCase('en-US') === 'copyright');
    if (!entry) return '';
    const property = section.properties.get(entry[0]);
    return property && [8, 30, 31].includes(property.type) && typeof property.value === 'string'
      ? property.value
      : '';
  }

  function readDocMetadata(input) {
    const classification = classifyDoc(input);
    if (!classification.supported) throw new Error(`Unsupported DOC file: ${classification.reason}`);
    let cfb;
    try {
      cfb = CFB.parse(toUint8Array(input));
      const summarySet = getPropertySet(cfb, STREAM_SUMMARY);
      const documentSummarySet = getPropertySet(cfb, STREAM_DOCUMENT_SUMMARY);
      const summary = summarySet && getSection(summarySet, FMTID_SUMMARY);
      const documentSummary = documentSummarySet && getSection(documentSummarySet, FMTID_DOCUMENT_SUMMARY);
      const userDefined = documentSummarySet && getSection(documentSummarySet, FMTID_USER_DEFINED);

      const metadata = {};
      for (const key of METADATA_KEYS) metadata[key] = '';
      for (const [key, id] of SUMMARY_FIELDS) {
        if (key === 'created' || key === 'modified' || key === 'lastPrinted') {
          metadata[key] = isoDate(summary && summary.properties.get(id));
        } else {
          metadata[key] = stringValue(summary, id);
        }
      }
      metadata.totalTime = readDurationMinutes(summary && summary.properties.get(10));
      for (const [key, id] of DOCUMENT_SUMMARY_FIELDS) metadata[key] = stringValue(documentSummary, id);
      metadata.copyright = readCustomCopyright(userDefined);
      const appVersion = integerValue(documentSummary, 23);
      if (appVersion != null) {
        const major = appVersion >>> 16;
        const minor = appVersion & 0xFFFF;
        metadata.appVersion = `${major}.${String(minor).padStart(4, '0')}`;
      }

      return { metadata, signed: Boolean(rootStream(cfb, STREAM_SIGNATURE)) };
    } catch (error) {
      if (error instanceof Error && /^Unsupported DOC file:/.test(error.message)) throw error;
      throw new Error(`Malformed DOC metadata: ${error.message}`, { cause: error });
    }
  }

  function normalizeCodePageForWriting(section) {
    if (section.codePage === 1200) return;
    for (const property of section.properties.values()) {
      if (CODEPAGE_SENSITIVE_TYPES.has(property.type)) {
        throw new Error(`Cannot safely rewrite code-page-dependent HPSF property ${property.id}`);
      }
      if (property.id === 0) {
        property.dirty = true;
      } else if (property.type === 30 || property.type === 8) {
        if (typeof property.value !== 'string') throw new Error(`Cannot decode HPSF property ${property.id}`);
        property.type = 30;
        property.dirty = true;
      }
    }
    const codePage = section.properties.get(1);
    if (!codePage || codePage.type !== 2) throw new Error('HPSF section has no valid CodePage property');
    codePage.value = 1200;
    codePage.dirty = true;
    section.codePage = 1200;
  }

  function prepareCodePageForString(section, value) {
    if (section.codePage !== 1200 && !HPSF.canEncodeCodePageText(value, section.codePage)) {
      normalizeCodePageForWriting(section);
    }
  }

  function setString(section, id, value) {
    if (value == null) return;
    const text = String(value);
    if (text === '') {
      section.properties.delete(id);
      return;
    }
    prepareCodePageForString(section, text);
    section.properties.set(id, { id, type: 30, value: text, dirty: true });
  }

  function setInteger(section, id, value) {
    if (value == null || String(value) === '') {
      section.properties.delete(id);
      return;
    }
    const match = String(value).trim().match(/^(\d{1,5})(?:\.(\d{1,5}))?$/);
    if (!match) throw new Error('Application Version must use major.minor numbers, such as 16.0000');
    const major = Number(match[1]);
    const minor = Number((match[2] || '').padEnd(4, '0'));
    if (major > 0xFFFF || minor > 0xFFFF) throw new RangeError('Application Version is outside the HPSF range');
    section.properties.set(id, { id, type: 3, value: (major << 16) | minor, dirty: true });
  }

  function setDate(section, id, date) {
    section.properties.set(id, { id, type: 0x40, value: date.getTime(), dirty: true });
  }

  function setOptionalDate(section, id, value, key) {
    const text = value == null ? '' : String(value).trim();
    if (text === '') {
      section.properties.delete(id);
      return;
    }
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid ${key} date`);
    setDate(section, id, date);
  }

  function setDuration(section, id, value) {
    if (value == null || String(value).trim() === '') {
      section.properties.delete(id);
      return;
    }
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error('Total Editing Time must be a non-negative number of minutes');
    const roundedTicks = Math.round(minutes * Number(TICKS_PER_MINUTE));
    if (!Number.isSafeInteger(roundedTicks)) throw new RangeError('Total Editing Time is outside the HPSF range');
    const ticks = BigInt(roundedTicks);
    const rawValue = new Uint8Array(12);
    const view = new DataView(rawValue.buffer);
    view.setUint32(0, 0x40, true);
    view.setUint32(4, Number(ticks & 0xFFFFFFFFn), true);
    view.setUint32(8, Number((ticks >> 32n) & 0xFFFFFFFFn), true);
    section.properties.set(id, { id, type: 0x40, value: minutes, rawValue, dirty: false });
  }

  function updateCustomCopyright(documentSummarySet, value) {
    let section = getSection(documentSummarySet, FMTID_USER_DEFINED);
    const text = value == null ? '' : String(value);
    if (!section && text === '') return;
    if (!section) section = ensureSection(documentSummarySet, FMTID_USER_DEFINED);

    let dictionaryProperty = section.properties.get(0);
    let dictionary = dictionaryProperty && Array.isArray(dictionaryProperty.value)
      ? dictionaryProperty.value.map(entry => [...entry])
      : [];
    const entryIndex = dictionary.findIndex(([, name]) => String(name).toLocaleLowerCase('en-US') === 'copyright');
    if (text === '') {
      if (entryIndex !== -1) {
        const [propertyId] = dictionary[entryIndex];
        section.properties.delete(propertyId);
        dictionary.splice(entryIndex, 1);
      }
    } else {
      if (entryIndex === -1) {
        const used = new Set(dictionary.map(([id]) => id));
        let propertyId = 2;
        while (used.has(propertyId) || section.properties.has(propertyId)) propertyId += 1;
        dictionary.push([propertyId, 'Copyright']);
        section.properties.set(propertyId, { id: propertyId, type: 31, value: text, dirty: true });
      } else {
        const [propertyId, name] = dictionary[entryIndex];
        dictionary[entryIndex] = [propertyId, name];
        section.properties.set(propertyId, { id: propertyId, type: 31, value: text, dirty: true });
      }
    }

    if (dictionary.length) {
      if (section.codePage !== 1200 && dictionary.some(([, name]) =>
        !HPSF.canEncodeCodePageText(name, section.codePage))) {
        normalizeCodePageForWriting(section);
      }
      if (!dictionaryProperty) dictionaryProperty = { id: 0, type: 'dictionary', value: [], dirty: true };
      dictionaryProperty.value = dictionary;
      dictionaryProperty.dirty = true;
      section.properties.set(0, dictionaryProperty);
    } else {
      section.properties.delete(0);
      const standardPropertiesOnly = [...section.properties.keys()].every(id => id === 1);
      if (standardPropertiesOnly) {
        documentSummarySet.sections = documentSummarySet.sections.filter(item => item !== section);
      }
    }
  }

  function blankPropertySet(existing, fmtid) {
    const set = makePropertySet(fmtid);
    if (existing) {
      set.version = existing.version;
      set.systemIdentifier = existing.systemIdentifier;
      set.clsid = existing.clsid ? existing.clsid.slice() : set.clsid;
    }
    return set;
  }

  function streamSnapshot(cfb) {
    const streams = new Map();
    for (let index = 0; index < cfb.FullPaths.length; index += 1) {
      const entry = cfb.FileIndex[index];
      if (!entry || entry.type !== 2) continue;
      const name = String(cfb.FullPaths[index]).replace(/^Root Entry\//i, '').replace(/^\/+/, '');
      const lowerName = name.toLocaleLowerCase('en-US');
      if (lowerName === STREAM_SUMMARY.toLocaleLowerCase('en-US') ||
          lowerName === STREAM_DOCUMENT_SUMMARY.toLocaleLowerCase('en-US')) continue;
      streams.set(name, toUint8Array(entry.content).slice());
    }
    return streams;
  }

  function setRootStream(cfb, name, content) {
    const bytes = toUint8Array(content).slice();
    const existing = rootStream(cfb, name);
    if (existing) {
      existing.content = bytes;
      existing.size = bytes.length;
      return;
    }
    const rootPath = String(cfb.FullPaths[0] || 'Root Entry/');
    cfb.FullPaths.push(`${rootPath.replace(/\/?$/u, '/')}${name}`);
    cfb.FileIndex.push({ name, type: 2, content: bytes, size: bytes.length, L: -1, R: -1, C: -1 });
  }

  function writeCompoundFile(cfb) {
    // @stackline/cfb adds a private \u0001Sh33tJ5 marker to every container on
    // write. Avoid injecting that non-Office stream into customer documents
    // which did not already contain it. CFB.write is synchronous, so restore
    // the shared lookup function immediately after the write.
    const markerName = '\u0001Sh33tJ5';
    const markerAlreadyExists = Boolean(rootStream(cfb, markerName));
    const originalFind = CFB.find;
    if (!markerAlreadyExists && typeof originalFind === 'function') {
      CFB.find = function findWithoutAddingMarker(target, path) {
        const normalized = String(path || '').replace(/^\/+|^Root Entry\//giu, '').toLocaleLowerCase('en-US');
        if (target === cfb && normalized === markerName.toLocaleLowerCase('en-US')) {
          return { name: markerName, type: 2, synthetic: true };
        }
        return originalFind.apply(this, arguments);
      };
    }
    try {
      return toUint8Array(CFB.write(cfb, { type: 'buffer' }));
    } finally {
      if (!markerAlreadyExists && typeof originalFind === 'function') CFB.find = originalFind;
    }
  }

  function assertStreamsUnchanged(before, after) {
    const actual = streamSnapshot(after);
    if (before.size !== actual.size) throw new Error('DOC output changed the non-property stream count');
    for (const [name, bytes] of before) {
      const updated = actual.get(name);
      if (!updated || updated.length !== bytes.length) throw new Error(`DOC output changed stream path or size: ${name}`);
      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== updated[index]) throw new Error(`DOC output changed non-property stream bytes: ${name}`);
      }
    }
  }

  function expectedValue(value) {
    return value == null ? '' : String(value);
  }

  function writeDocMetadata(input, values, mode = 'form', now = new Date()) {
    if (!['form', 'template', 'clear'].includes(mode)) throw new TypeError(`Unsupported DOC metadata mode: ${mode}`);
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('Metadata values must be an object');
    for (const key of Object.keys(values)) {
      if (!METADATA_KEYS.has(key)) throw new TypeError(`Unsupported DOC metadata field: ${key}`);
    }
    const operationTime = now instanceof Date ? new Date(now.getTime()) : new Date(now);
    if (Number.isNaN(operationTime.getTime())) throw new TypeError('Operation time must be a valid date');
    const classification = classifyDoc(input);
    if (!classification.supported) throw new Error(`Unsupported DOC file: ${classification.reason}`);

    let cfb;
    try {
      cfb = CFB.parse(toUint8Array(input));
      const beforeStreams = streamSnapshot(cfb);
      const parsedSummary = getPropertySet(cfb, STREAM_SUMMARY);
      const parsedDocumentSummary = getPropertySet(cfb, STREAM_DOCUMENT_SUMMARY);
      let summarySet = parsedSummary ? clonePropertySet(parsedSummary) : makePropertySet(FMTID_SUMMARY);
      let documentSummarySet = parsedDocumentSummary
        ? clonePropertySet(parsedDocumentSummary)
        : makePropertySet(FMTID_DOCUMENT_SUMMARY);

      if (mode === 'template' || mode === 'clear') {
        summarySet = blankPropertySet(parsedSummary, FMTID_SUMMARY);
        documentSummarySet = blankPropertySet(parsedDocumentSummary, FMTID_DOCUMENT_SUMMARY);
        if (mode === 'template') {
          const summary = summarySet.sections[0];
          const documentSummary = documentSummarySet.sections[0];
          for (const [key, id] of SUMMARY_FIELDS) {
            if (key === 'modified') continue;
            if (key === 'created' || key === 'lastPrinted') {
              if (Object.hasOwn(values, key)) setOptionalDate(summary, id, values[key], key);
            } else if (Object.hasOwn(values, key)) {
              setString(summary, id, values[key]);
            }
          }
          if (Object.hasOwn(values, 'totalTime')) setDuration(summary, 10, values.totalTime);
          for (const [key, id] of DOCUMENT_SUMMARY_FIELDS) {
            if (Object.hasOwn(values, key)) setString(documentSummary, id, values[key]);
          }
          if (Object.hasOwn(values, 'appVersion')) setInteger(documentSummary, 23, values.appVersion);
          if (Object.hasOwn(values, 'copyright') && String(values.copyright ?? '') !== '') {
            updateCustomCopyright(documentSummarySet, values.copyright);
          }
        }
      } else {
        const summary = ensureSection(summarySet, FMTID_SUMMARY);
        const documentSummary = ensureSection(documentSummarySet, FMTID_DOCUMENT_SUMMARY);
        for (const [key, id] of SUMMARY_FIELDS) {
          if (key === 'created' || key === 'modified' || key === 'lastPrinted') {
            if (!Object.hasOwn(values, key)) continue;
            if (key === 'modified') continue;
            const text = values[key] == null ? '' : String(values[key]).trim();
            setOptionalDate(summary, id, text, key);
          } else if (Object.hasOwn(values, key)) {
            setString(summary, id, values[key]);
          }
        }
        if (Object.hasOwn(values, 'totalTime')) setDuration(summary, 10, values.totalTime);
        for (const [key, id] of DOCUMENT_SUMMARY_FIELDS) {
          if (Object.hasOwn(values, key)) setString(documentSummary, id, values[key]);
        }
        if (Object.hasOwn(values, 'appVersion')) setInteger(documentSummary, 23, values.appVersion);
        if (Object.hasOwn(values, 'copyright')) updateCustomCopyright(documentSummarySet, values.copyright);
      }

      const summary = ensureSection(summarySet, FMTID_SUMMARY);
      setDate(summary, 13, operationTime);

      const summaryBytes = HPSF.serializePropertySet(summarySet);
      const documentSummaryBytes = HPSF.serializePropertySet(documentSummarySet);
      setRootStream(cfb, STREAM_SUMMARY, summaryBytes);
      setRootStream(cfb, STREAM_DOCUMENT_SUMMARY, documentSummaryBytes);
      const output = writeCompoundFile(cfb);

      const outputClass = classifyDoc(output);
      if (!outputClass.supported) throw new Error(`Generated DOC failed validation: ${outputClass.reason}`);
      assertStreamsUnchanged(beforeStreams, CFB.parse(output));
      const decoded = readDocMetadata(output).metadata;
      if (decoded.modified !== operationTime.toISOString()) throw new Error('Generated DOC did not preserve the operation-time last-save value');
      for (const [key, value] of Object.entries(values)) {
        if (mode === 'clear' || key === 'modified') continue;
        let expected = expectedValue(value);
        if (key === 'created' || key === 'lastPrinted') {
          const text = expected.trim();
          expected = text ? new Date(text).toISOString() : '';
        }
        if (decoded[key] !== expected) throw new Error(`Generated DOC metadata failed validation for ${key}`);
      }
      return output;
    } catch (error) {
      if (error instanceof Error && /^Unsupported DOC file:/.test(error.message)) throw error;
      throw new Error(`DOC metadata write failed: ${error.message}`, { cause: error });
    }
  }

  return { readDocMetadata, writeDocMetadata };
});
