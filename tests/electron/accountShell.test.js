'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { render, setExpanded, createBusyGuard, createRequestGuard } = require('../../src/electron/renderer/limits/accountShell');

function node() {
  const classes = new Set(['hidden']);
  const attributes = {};
  return {
    textContent: '',
    title: '',
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
    },
    setAttribute: (key, value) => { attributes[key] = value; },
    getAttribute: (key) => attributes[key]
  };
}

test('one shell renders status, error, and login progress independently', () => {
  const status = node();
  const error = node();
  const progress = node();
  render({ status, statusText: '2 of 3 linked', error, errorText: 'Try again', progress, progressText: 'Waiting' });
  assert.equal(status.textContent, '2 of 3 linked');
  assert.equal(status.title, status.textContent);
  assert.equal(error.classList.contains('hidden'), false);
  assert.equal(progress.classList.contains('hidden'), false);
  render({ error, errorText: '', progress, progressText: '' });
  assert.equal(error.classList.contains('hidden'), true);
  assert.equal(progress.classList.contains('hidden'), true);
  assert.equal(status.textContent, '2 of 3 linked');
});

test('expansion updates accessibility and follows the provider row', () => {
  const toggle = node();
  const details = node();
  const group = node();
  const changes = [];
  setExpanded({ toggle, details, group, expanded: true, onChange: (open) => changes.push(open) });
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(details.classList.contains('hidden'), false);
  assert.equal(group.classList.contains('expanded'), true);
  setExpanded({ toggle, details, group, expanded: false, onChange: (open) => changes.push(open) });
  assert.equal(details.classList.contains('hidden'), true);
  assert.deepEqual(changes, [true, false]);
});

test('profile saves prevent same-provider reentry and restore controls on rejection', async () => {
  const guard = createBusyGuard();
  const button = node();
  let release;
  let calls = 0;
  const first = guard.run('openrouter', button, () => {
    calls += 1;
    return new Promise((resolve) => { release = resolve; });
  });
  assert.equal(button.disabled, true);
  await guard.run('openrouter', button, () => { calls += 1; });
  await guard.run('thirdparty', null, () => { calls += 1; });
  assert.equal(calls, 2);
  release();
  await first;
  assert.equal(button.disabled, false);
  await assert.rejects(guard.run('openrouter', button, () => { throw new Error('failed'); }), /failed/);
  assert.equal(button.disabled, false);
});

test('profile requests retire stale replies per provider without affecting peers', () => {
  const guard = createRequestGuard();
  const older = guard.begin('openrouter');
  const peer = guard.begin('thirdparty');
  const newer = guard.begin('openrouter');
  assert.equal(older(), false);
  assert.equal(newer(), true);
  assert.equal(peer(), true);
  guard.retire('thirdparty');
  assert.equal(peer(), false);
  assert.equal(newer(), true);
});
