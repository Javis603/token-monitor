'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');


const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function readMainSource() {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
}

function readRendererSource() {
  return fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
}

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} function should exist`);
  let depth = 0;
  let parenDepth = 0;
  let started = false;
  let end = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(' && !started) parenDepth += 1;
    if (ch === ')' && !started) { parenDepth -= 1; continue; }
    if (parenDepth > 0) continue;
    if (ch === '{') { depth += 1; started = true; }
    if (ch === '}') depth -= 1;
    if (started && depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > start, `${name} function body should be well-formed`);
  return source.slice(start, end);
}

function handlerSlice(main) {
  const start = main.indexOf("ipcMain.handle('settings:update'");
  const end = main.indexOf("ipcMain.handle('appearance:preview'", start);
  assert.ok(start !== -1 && end !== -1, 'settings:update handler should exist');
  return main.slice(start, end);
}

// ─── Main process: settings:update limitScopes handling ──────────────────────

test('provider credential change triggers queueLimitInvalidation with clear: true', () => {
  const main = readMainSource();
  const handler = handlerSlice(main);

  // The normal (non-structural) branch should pass { clear: true }
  assert.match(handler, /for \(const scope of runtimeChange\.limitScopes\)/);
  assert.match(handler, /queueLimitInvalidation\(scope, 'settings-change', \{ clear: true \}\)/);
});

test('modeStructural branch stores pending invalidation with clear: true', () => {
  const main = readMainSource();
  const handler = handlerSlice(main);

  // The modeStructural branch should call rememberPendingLimitInvalidation with clear=true
  const modeStructuralBlock = handler.slice(
    handler.indexOf('runtimeChange.modeStructural'),
    handler.indexOf('} else if (runtimeChange.usageStructural')
  );
  assert.match(modeStructuralBlock, /rememberPendingLimitInvalidation\(scope, 'settings-change', true\)/);
});

test('usageStructural and sinkStructural branch stores pending invalidation with clear: true', () => {
  const main = readMainSource();
  const handler = handlerSlice(main);

  // The usageStructural/sinkStructural branch should also call rememberPendingLimitInvalidation with clear=true
  const usageStructuralBlock = handler.slice(
    handler.indexOf('runtimeChange.usageStructural || runtimeChange.sinkStructural'),
    handler.indexOf('} else {', handler.indexOf('runtimeChange.usageStructural'))
  );
  assert.match(usageStructuralBlock, /rememberPendingLimitInvalidation\(scope, 'settings-change', true\)/);
});

// ─── Main process: drainPendingLimitInvalidations respects clear flag ─────────

test('drainPendingLimitInvalidations calls clearLimits before refreshLimits when clear is true', () => {
  const main = readMainSource();
  const drainBody = extractFunction(main, 'drainPendingLimitInvalidations');

  // Should check entry.clear and call runtime.clearLimits
  assert.match(drainBody, /if \(entry\.clear\) runtime\.clearLimits\(entry\.scope, entry\.reason\)/);
  // Should check entry.refresh and call runtime.refreshLimits
  assert.match(drainBody, /if \(entry\.refresh\)/);
  assert.match(drainBody, /runtime\.refreshLimits\(entry\.scope, entry\.reason\)/);
});

test('rememberPendingLimitInvalidation defaults clear to false when not specified', () => {
  const main = readMainSource();
  const fn = extractFunction(main, 'rememberPendingLimitInvalidation');

  // Function signature should have clear = false as default
  assert.match(fn, /function rememberPendingLimitInvalidation\(scope, reason, clear = false/);
});

test('queueLimitInvalidation passes clear option to runtime', () => {
  const main = readMainSource();
  const fn = extractFunction(main, 'queueLimitInvalidation');

  // Should extract clear from options and pass to runtime
  assert.match(fn, /const clear = options\.clear === true/);
  assert.match(fn, /if \(clear\) deviceRuntimeHandle\.clearLimits\(scope, reason\)/);
});

// ─── Old probe race: stale probe result should not overwrite fresh data ──────

test('old probe returning after key change does not overwrite fresh provider status', () => {
  const main = readMainSource();
  const fn = extractFunction(main, 'queueLimitInvalidation');

  // queueLimitInvalidation should call clearLimits BEFORE refreshLimits
  // This ensures old probe results are evicted before the new probe starts
  const clearPos = fn.indexOf('deviceRuntimeHandle.clearLimits(scope, reason)');
  const refreshPos = fn.indexOf('deviceRuntimeHandle.refreshLimits(scope, reason)');
  assert.ok(clearPos !== -1, 'clearLimits should be called');
  assert.ok(refreshPos !== -1, 'refreshLimits should be called');
  assert.ok(clearPos < refreshPos, 'clearLimits must be called before refreshLimits');
});

// ─── DeepSeek renderer: submit handler retry logic ──────────────────────────

test('DeepSeek submit handler retries refreshStats once when not linked after first attempt', () => {
  const app = readRendererSource();

  // Find the submit handler body
  const submitStart = app.indexOf("getElementById('deepseekApiKeySubmit').addEventListener");
  assert.notEqual(submitStart, -1, 'DeepSeek submit handler should exist');

  // Find the handler body (up to the closing of the try block)
  const handlerBody = app.slice(submitStart, submitStart + 1200);

  // Should have the retry pattern: check linked, delay, refresh again
  assert.match(handlerBody, /if \(!deepseekAccountLinked\(\)\)/);
  assert.match(handlerBody, /await new Promise\(\(r\) => setTimeout\(r, 2500\)\)/);
  assert.match(handlerBody, /await refreshStats\(\{ force: true \}\)/);

  // Count occurrences of refreshStats({ force: true }) — should be exactly 2
  const refreshCount = (handlerBody.match(/await refreshStats\(\{ force: true \}\)/g) || []).length;
  assert.equal(refreshCount, 2, 'should call refreshStats exactly twice (initial + retry)');
});

test('DeepSeek submit handler does not introduce infinite retry or recurring timer', () => {
  const app = readRendererSource();

  const submitStart = app.indexOf("getElementById('deepseekApiKeySubmit').addEventListener");
  const handlerBody = app.slice(submitStart, submitStart + 1200);

  // Should not use setInterval, recursive setTimeout, or while/for loops for retry
  assert.doesNotMatch(handlerBody, /setInterval/);
  assert.doesNotMatch(handlerBody, /setTimeout\(.*setTimeout/);  // no nested setTimeout
  assert.doesNotMatch(handlerBody, /while\s*\(/);
});

test('DeepSeek submit handler only retries when not linked', () => {
  const app = readRendererSource();

  const submitStart = app.indexOf("getElementById('deepseekApiKeySubmit').addEventListener");
  const handlerBody = app.slice(submitStart, submitStart + 1200);

  // The retry should be guarded by !deepseekAccountLinked()
  // Pattern: first refreshStats, then if (!linked) delay + refresh again
  const firstRefresh = handlerBody.indexOf("await refreshStats({ force: true })");
  const guardCheck = handlerBody.indexOf("!deepseekAccountLinked()", firstRefresh);
  const delayCall = handlerBody.indexOf("setTimeout(r, 2500)", guardCheck);
  const secondRefresh = handlerBody.indexOf("await refreshStats({ force: true })", delayCall);

  assert.ok(firstRefresh < guardCheck, 'guard should come after first refresh');
  assert.ok(guardCheck < delayCall, 'delay should be inside the guard');
  assert.ok(delayCall < secondRefresh, 'second refresh should come after delay');
});
