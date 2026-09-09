'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { builtinModules } = require('node:module');
const {
  extractStaticRequires,
  resolveRequireTarget,
  fsFileExists,
  listJsFiles
} = require('../helpers/staticRequires');

const ENGINE_DIR = path.resolve(__dirname, '../../src/shared/quotaEngine');
const SRC_DIR = path.resolve(__dirname, '../../src');
const ENGINE_FACADE = path.join(ENGINE_DIR, 'index.js');

function forbiddenHostImports() {
  const names = new Set(['electron']);
  for (const name of builtinModules) {
    names.add(name);
    if (name.startsWith('node:')) names.add(name.slice('node:'.length));
    else names.add(`node:${name}`);
  }
  return names;
}

const FORBIDDEN_HOST_IMPORTS = forbiddenHostImports();

function makeDeepImportPolicy({ srcDir, engineDir, engineFacade }) {
  const engineRelativeDir = path.relative(srcDir, engineDir).split(path.sep).join('/');
  return function evaluateDeepImports({ file, source, resolveTarget }) {
    const relative = path.relative(srcDir, file).split(path.sep).join('/');
    if (relative.startsWith(`${engineRelativeDir}/`)) return [];
    const violations = [];
    for (const { target } of extractStaticRequires(source, file)) {
      const resolved = resolveTarget(file, target);
      if (!resolved) {
        if (!target.startsWith('.')) continue;
        const wouldBe = path.resolve(path.dirname(file), target);
        if (wouldBe === engineDir || wouldBe === engineFacade) continue;
        if (wouldBe.startsWith(engineDir + path.sep)) {
          violations.push(
            `${relative} unresolved deep-import '${target}' — require('./quotaEngine') instead`
          );
        }
        continue;
      }
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
        FORBIDDEN_HOST_IMPORTS.has(target),
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

test('host builtin deny-list covers node builtins and electron', () => {
  for (const target of ['os', 'node:os', 'child_process', 'worker_threads', 'electron', 'fs', 'node:fs']) {
    assert.equal(FORBIDDEN_HOST_IMPORTS.has(target), true, target);
  }
  assert.equal(FORBIDDEN_HOST_IMPORTS.has('./windowIdentity'), false);
  assert.equal(FORBIDDEN_HOST_IMPORTS.has('../quotaEngine'), false);
});

test('CJS require resolution covers json, package main and index without treating mjs as loadable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-requires-'));
  try {
    const fromFile = path.join(dir, 'caller.js');
    fs.writeFileSync(fromFile, 'module.exports = {}\n');
    fs.writeFileSync(path.join(dir, 'secret.json'), '{"ok":true}\n');
    fs.mkdirSync(path.join(dir, 'pkg'));
    fs.writeFileSync(path.join(dir, 'pkg', 'package.json'), JSON.stringify({ main: './lib/entry' }));
    fs.mkdirSync(path.join(dir, 'pkg', 'lib'));
    fs.writeFileSync(path.join(dir, 'pkg', 'lib', 'entry.js'), 'module.exports = 1\n');
    fs.mkdirSync(path.join(dir, 'indexed'));
    fs.writeFileSync(path.join(dir, 'indexed', 'index.json'), '{"i":1}\n');
    fs.writeFileSync(path.join(dir, 'only.mjs'), 'export default 1\n');

    assert.equal(
      resolveRequireTarget(fromFile, './secret', fsFileExists),
      path.join(dir, 'secret.json')
    );
    assert.equal(
      resolveRequireTarget(fromFile, './pkg', fsFileExists),
      path.join(dir, 'pkg', 'lib', 'entry.js')
    );
    assert.equal(
      resolveRequireTarget(fromFile, './indexed', fsFileExists),
      path.join(dir, 'indexed', 'index.json')
    );
    assert.equal(resolveRequireTarget(fromFile, './only', fsFileExists), null);
    assert.equal(resolveRequireTarget(fromFile, './only.mjs', fsFileExists), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unresolved lexical quotaEngine deep paths are violations', () => {
  const file = path.join(SRC_DIR, 'shared', 'codexQuota.js');
  const violations = evaluateDeepImports({
    file,
    source: 'const x = require("./quotaEngine/missing-internal");\n',
    resolveTarget: (fromFile, target) => resolveRequireTarget(fromFile, target, fsFileExists)
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /unresolved deep-import/);
});
