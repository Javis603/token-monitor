'use strict';

const fs = require('node:fs');
const path = require('node:path');
// The parser comes from the project's direct eslint dependency (package.json);
// no new or undeclared transitive dependency is introduced.
const { Linter } = require('eslint');

// ---------------------------------------------------------------------------
// Static require() extraction, shared by the import guards
// (tests/shared/quotaEngine.boundary.test.js 和
//  tests/shared/quotaAdapters/boundary.test.js).
//
// A guard must recognize a real static require() call by JavaScript syntax
// structure, not by searching for look-alike text. We use the ESLint Linter
// (the project already depends on eslint) with an AST visitor over
// CallExpression nodes: the callee must be the identifier `require` and the
// single argument must be a static string — a single- or double-quoted literal
// or a template literal with no `${...}` interpolation. Text inside plain
// strings, comments, regex literals and template text is never a call node, so
// it can never trip a guard, and a dynamic template target is not guessed.
//
// Both guards share one extractor on purpose: two copies of "what counts as an
// import" drift, and a guard that disagrees with its neighbour is worse than
// either alone.
// ---------------------------------------------------------------------------

const linter = new Linter({ configType: 'flat' });

function extractStaticRequires(source, fileName = '<inline>') {
  const found = [];
  const staticRequireRule = {
    meta: { schema: [] },
    create() {
      return {
        CallExpression(node) {
          if (!node.callee || node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
          if (node.arguments.length !== 1) return;
          const arg = node.arguments[0];
          let target = null;
          if (arg.type === 'Literal' && typeof arg.value === 'string') target = arg.value;
          else if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0 && arg.quasis.length === 1) {
            target = arg.quasis[0].value.cooked;
          }
          if (typeof target === 'string') found.push({ target, line: node.loc.start.line });
        }
      };
    }
  };
  // No filename is passed to verify(): a synthetic name like <inline> makes
  // ESLint treat the config as not matching the file. The fileName argument
  // is only used for our own error reporting below.
  const messages = linter.verify(source, {
    plugins: { quotaGuard: { rules: { staticRequire: staticRequireRule } } },
    rules: { 'quotaGuard/staticRequire': 'error' },
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs' }
  });
  const fatal = messages.find((message) => message.fatal);
  if (fatal) {
    throw new Error(`${fileName} cannot be parsed by the import guard (${fatal.message}) — fix the syntax or widen the guard`);
  }
  return found;
}

// Node CommonJS LOAD_AS_FILE / LOAD_AS_DIRECTORY, minus .mjs (require() on
// this project's Node 22/24 does not load ESM as a CJS target).
function loadAsFile(base, fileExists) {
  if (path.extname(base) === '.mjs') return null;
  for (const candidate of [base, `${base}.js`, `${base}.json`, `${base}.node`]) {
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

function loadIndex(dir, fileExists) {
  for (const name of ['index.js', 'index.json', 'index.node']) {
    const candidate = path.join(dir, name);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

function packageMain(dir, fileExists) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fileExists(pkgPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return typeof parsed?.main === 'string' && parsed.main.trim() ? parsed.main.trim() : null;
  } catch {
    return null;
  }
}

function loadAsDirectory(dir, fileExists, depth = 0) {
  if (depth > 4) return null;
  const main = packageMain(dir, fileExists);
  if (main) {
    const mainPath = path.resolve(dir, main);
    const asFile = loadAsFile(mainPath, fileExists);
    if (asFile) return asFile;
    const nested = loadAsDirectory(mainPath, fileExists, depth + 1);
    if (nested) return nested;
    const indexed = loadIndex(mainPath, fileExists);
    if (indexed) return indexed;
  }
  return loadIndex(dir, fileExists);
}

function resolveRequireTarget(fromFile, target, fileExists) {
  if (typeof target !== 'string' || !target.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), target);
  return loadAsFile(base, fileExists) || loadAsDirectory(base, fileExists);
}

function fsFileExists(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function listJsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

module.exports = {
  extractStaticRequires,
  resolveRequireTarget,
  fsFileExists,
  listJsFiles
};
