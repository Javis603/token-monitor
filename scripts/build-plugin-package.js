#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { packageDirectory } = require('../src/electron/plugins/package');
function main(argv) {
  const [dir, output] = argv;
  if (!dir || !output || argv.length !== 2) throw new Error('Usage: node scripts/build-plugin-package.js <plugin-folder> <output.tmplugin>');
  const pkg = packageDirectory(path.resolve(dir));
  fs.writeFileSync(path.resolve(output), pkg.bytes, { flag: 'wx' });
  console.log(`${pkg.manifest.id}@${pkg.manifest.version} · SHA-256 ${pkg.hash}`);
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { main };
