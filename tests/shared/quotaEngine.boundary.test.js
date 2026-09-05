'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  extractStaticRequires,
  resolveRequireTarget,
  fsFileExists,
  listJsFiles
} = require('../helpers/staticRequires');

const ENGINE_DIR = path.resolve(__dirname, '../../src/shared/quotaEngine');
const SRC_DIR = path.resolve(__dirname, '../../src');
const ENGINE_FACADE = path.join(ENGINE_DIR, 'index.js');
const FORBIDDEN_REQUIRE = /^(?:node:|electron$|fs$|path$|crypto$)/;

function makeDeepImportPolicy({ srcDir, engineDir, engineFacade }) {
  const engineRelativeDir = path.relative(srcDir, engineDir).split(path.sep).join('/');
  return function evaluateDeepImports({ file, source, resolveTarget }) {
    const relative = path.relative(srcDir, file).split(path.sep).join('/');
    if (relative.startsWith(`${engineRelativeDir}/`)) return [];
    const violations = [];
    for (const { target } of extractStaticRequires(source, file)) {
      const resolved = resolveTarget(file, target);
      if (!resolved) continue;
      if (!resolved.startsWith(engineDir + path.sep)) continue;
      if (resolved === engineFacade) continue;
      violations.push(
        `${relative} deep-imports '${target}' (${path.relative(srcDir, resolved).split(path.sep).join('/')}) — require('./quotaEngine') instead`
      );
    }
    return violations;
  };
}

const evaluateDeepImports = makeDeepImportPolicy({
  srcDir: SRC_DIR,
  engineDir: ENGINE_DIR,
  engineFacade: ENGINE_FACADE
});

test('quotaEngine is a closed pure core with no host or filesystem imports', () => {
  for (const file of listJsFiles(ENGINE_DIR)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const { target } of extractStaticRequires(source, file)) {
      assert.equal(
        FORBIDDEN_REQUIRE.test(target),
        false,
        `${path.relative(ENGINE_DIR, file)} requires ${target}`
      );
    }
  }
});

test('production code reaches quotaEngine only through the facade', () => {
  const violations = [];
  for (const file of listJsFiles(SRC_DIR)) {
    const source = fs.readFileSync(file, 'utf8');
    violations.push(...evaluateDeepImports({
      file,
      source,
      resolveTarget: (fromFile, target) => resolveRequireTarget(fromFile, target, fsFileExists)
    }));
  }
  assert.deepEqual(violations, []);
});
