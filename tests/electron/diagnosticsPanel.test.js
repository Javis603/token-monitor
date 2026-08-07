'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDiagnosticsPanel } = require('../../src/electron/renderer/diagnosticsPanel');

function fakeElement() {
  const listeners = new Map();
  const classes = new Set();
  return {
    hidden: false,
    inert: false,
    disabled: false,
    textContent: '',
    className: '',
    attributes: {},
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); }
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(name, handler) { listeners.set(name, handler); },
    click() { listeners.get('click')?.(); },
    listeners
  };
}

function fakeElements() {
  return Object.fromEntries([
    'toggle', 'details', 'generate', 'copy', 'previewButton', 'status',
    'preview', 'reportText', 'regenerate'
  ].map((key) => [key, fakeElement()]));
}

function createPanel(options = {}) {
  const elements = options.elements || fakeElements();
  let generated = 0;
  const copied = [];
  const panel = createDiagnosticsPanel({
    elements,
    api: {
      generateDiagnosticReport: async () => ({
        generatedAt: `2026-08-06T10:00:0${generated}.000Z`,
        text: `report-${++generated}`
      }),
      copyText: async (text) => { copied.push(text); }
    },
    translate: (key, values) => values?.time ? `${key}:${values.time}` : key,
    getLocale: () => 'en',
    ...options
  });
  return { copied, elements, getGenerated: () => generated, panel };
}

test('generate opens the panel and preview, while repeated generate reuses the snapshot', async () => {
  const { elements, getGenerated, panel } = createPanel();

  await panel.generate();
  assert.equal(getGenerated(), 1);
  assert.equal(panel.getState().detailsOpen, true);
  assert.equal(panel.getState().previewOpen, true);
  assert.equal(panel.getState().text, 'report-1');
  assert.equal(elements.preview.hidden, false);
  assert.equal(elements.copy.hidden, false);
  assert.equal(elements.generate.hidden, true);

  await panel.generate();
  assert.equal(getGenerated(), 1);
  assert.equal(panel.getState().text, 'report-1');
});

test('copy uses the cached text and regenerate is the only forced refresh', async () => {
  const { copied, getGenerated, panel } = createPanel();

  await panel.generate();
  await panel.copy();
  assert.deepEqual(copied, ['report-1']);

  panel.togglePreview();
  assert.equal(panel.getState().previewOpen, false);
  await panel.regenerate();
  assert.equal(getGenerated(), 2);
  assert.equal(panel.getState().text, 'report-2');
  assert.equal(panel.getState().previewOpen, true);
});

test('panel ignores a second report request while the first is sampling', async () => {
  const elements = fakeElements();
  let resolveReport;
  let calls = 0;
  const panel = createDiagnosticsPanel({
    elements,
    api: {
      generateDiagnosticReport: () => {
        calls += 1;
        return new Promise((resolve) => { resolveReport = resolve; });
      }
    },
    translate: (key) => key
  });

  const first = panel.generate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(panel.getState().busy, true);
  await panel.regenerate();
  assert.equal(calls, 1);

  resolveReport({ generatedAt: '2026-08-06T10:00:00.000Z', text: 'report' });
  await first;
  assert.equal(panel.getState().busy, false);
  assert.equal(panel.getState().text, 'report');
});
