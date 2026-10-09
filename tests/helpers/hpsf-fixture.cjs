const CFB = require('@stackline/cfb');

function makeFib({ whichTable = 0, encrypted = false, obfuscated = false, length = 32 } = {}) {
  const fib = Buffer.alloc(length);
  if (length >= 2) fib.writeUInt16LE(0xA5EC, 0);
  if (length >= 4) fib.writeUInt16LE(0x00C1, 2);
  if (length >= 12) {
    let flags = whichTable ? 0x0200 : 0;
    if (encrypted) flags |= 0x0100;
    if (obfuscated) flags |= 0x8000;
    fib.writeUInt16LE(flags, 10);
  }
  return fib;
}

function makeDoc(options = {}) {
  const cfb = CFB.utils.cfb_new();
  if (options.includeWordDocument !== false) {
    CFB.utils.cfb_add(cfb, '/WordDocument', makeFib(options));
  }
  const tableName = options.whichTable ? '/1Table' : '/0Table';
  if (options.includeSelectedTable !== false) {
    CFB.utils.cfb_add(cfb, tableName, Buffer.from('TABLE_SENTINEL'));
  }
  if (options.includeUnselectedTable) {
    CFB.utils.cfb_add(cfb, options.whichTable ? '/0Table' : '/1Table', Buffer.from('UNUSED_TABLE'));
  }
  if (options.streams) {
    for (const [path, contents] of Object.entries(options.streams)) {
      CFB.utils.cfb_add(cfb, `/${path}`, Buffer.from(contents));
    }
  }
  return new Uint8Array(CFB.write(cfb, { type: 'buffer' }));
}

module.exports = { CFB, makeDoc, makeFib };
