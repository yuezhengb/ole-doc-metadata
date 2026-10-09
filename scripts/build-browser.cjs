const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceFiles = ['src/hpsf.js', 'src/metadata.js', 'src/index.js'];
const output = sourceFiles.map(relative =>
  `/* ---- ${relative} ---- */\n${fs.readFileSync(path.join(root, relative), 'utf8').trim()}\n`,
).join('\n');
const outputPath = path.join(root, 'dist', 'ole-doc-metadata.js');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output);
process.stdout.write(`Built ${path.relative(root, outputPath)} (${Buffer.byteLength(output)} bytes)\n`);
