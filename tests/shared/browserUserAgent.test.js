'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { BROWSER_USER_AGENT } = require('../../src/shared/browserUserAgent');

const root = path.join(__dirname, '..', '..');

function jsFilesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('the shared browser user-agent reads as a current browser', () => {
  // The whole point is to not look like a script: Cloudflare challenges anything
  // that doesn't, so a well-meaning edit to an honest agent has to fail here.
  assert.match(BROWSER_USER_AGENT, /^Mozilla\/5\.0 /);
  assert.match(BROWSER_USER_AGENT, /Chrome\/\d+[\d.]* Safari\/[\d.]+$/);
  assert.doesNotMatch(BROWSER_USER_AGENT, /token-monitor/i);
});

test('providers share one browser user-agent instead of copying the string', () => {
  const owners = jsFilesUnder(path.join(root, 'src'))
    .concat(jsFilesUnder(path.join(root, 'worker', 'src')))
    .filter((file) => fs.readFileSync(file, 'utf8').includes(BROWSER_USER_AGENT))
    // Windows would otherwise report `src\shared\...` and never match.
    .map((file) => path.relative(root, file).split(path.sep).join('/'));

  // A second copy is how one collector ends up stranded on a stale Chrome
  // version. `cursorProbe` and `mimoLimits` deliberately send their own, older
  // agents, and stay out of this by not matching the shared string.
  assert.deepEqual(owners, ['src/shared/browserUserAgent.js']);
});

test('every web-session provider takes its agent from the shared module', () => {
  for (const file of [
    'src/shared/limitCollector.js',
    'src/shared/opencodeWeb.js',
    'src/shared/ollamaLimits.js',
    'src/shared/qoderLimits.js'
  ]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /require\('\.\/browserUserAgent'\)/, `${file} should require the shared agent`);
    assert.match(source, /BROWSER_USER_AGENT/, `${file} should use the shared agent`);
  }
});
