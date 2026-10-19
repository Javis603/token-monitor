'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const appUpdatePresentationApi = require('../../src/electron/renderer/appUpdatePresentation');

const renderer = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

function sourceBetween(start, end) {
  return renderer.slice(renderer.indexOf(start), renderer.indexOf(end, renderer.indexOf(start)));
}

function createHarness() {
  let allocations = 0;
  let locale = 'en';
  const expansions = [];
  const element = () => {
    const classes = new Set();
    return {
      children: [], dataset: {}, textContent: '', scrollTop: 0,
      classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); }
      },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; this.scrollTop = 0; },
      getBoundingClientRect() { return {}; }
    };
  };
  const els = Object.fromEntries([
    'appUpdateNotes', 'appUpdateNotesToggle', 'appUpdateNotesDetails',
    'appUpdateNotesTitle', 'appUpdateNotesBody'
  ].map((name) => [name, element()]));
  const context = vm.createContext({
    appUpdatePresentationApi, els, state: { appUpdateNotesPresentedVersion: '' },
    currentLocale: () => locale,
    t: (key, values) => `${locale}:${key}:${JSON.stringify(values)}`,
    setSettingsAccordionExpanded: (_notes, _toggle, _details, open) => expansions.push(open),
    document: {
      createElement() { allocations++; return element(); },
      createTextNode(text) { allocations++; return { textContent: text }; }
    }
  });
  vm.runInContext(
    sourceBetween('function releaseNoteHistoryForCurrentLocale(', '// The card explains;')
      + sourceBetween('function renderAppUpdateNotes(', 'function renderSettingsAppUpdateRow('),
    context
  );
  return {
    els, expansions, state: context.state,
    render: context.renderAppUpdateNotes,
    allocations: () => allocations,
    setLocale(value) { locale = value; }
  };
}

function updateState() {
  return {
    currentVersion: '0.68.0', hasUpdate: true,
    latest: {
      version: '0.71.0', htmlUrl: 'https://example.test/v0.71.0',
      releaseNotes: {
        en: [{ title: 'Fixed', items: ['Updates: Keep release notes readable.'] }],
        'zh-TW': [{ title: '修復', items: ['更新：保留完整說明。'] }]
      }
    }
  };
}

test('progress-only pushes allocate no release-note nodes and preserve the existing scroller', () => {
  const h = createHarness();
  const s = updateState();
  h.render(s);
  const initialAllocations = h.allocations();
  const firstNode = h.els.appUpdateNotesBody.children[0];
  assert.ok(initialAllocations > 0);
  h.els.appUpdateNotesBody.scrollTop = 80;
  for (let progress = 0; progress <= 100; progress++) {
    // IPC delivers fresh objects even when only progress changes.
    h.render({ ...structuredClone(s), installPhase: 'downloading', installProgress: progress });
  }
  assert.equal(h.allocations(), initialAllocations);
  assert.equal(h.els.appUpdateNotesBody.children[0], firstNode);
  assert.equal(h.els.appUpdateNotesBody.scrollTop, 80);
  assert.deepEqual(h.expansions, [true]);
});

test('locale and note changes rebuild the content while a later update flag still opens cached notes', () => {
  const h = createHarness();
  const s = updateState();
  s.hasUpdate = false;
  h.render(s);
  const initialAllocations = h.allocations();
  h.render({ ...s, hasUpdate: true });
  assert.equal(h.allocations(), initialAllocations);
  assert.deepEqual(h.expansions, [true]);

  h.setLocale('zh-TW');
  h.render(s);
  assert.ok(h.allocations() > initialAllocations);
  assert.match(h.els.appUpdateNotesTitle.textContent, /^zh-TW:/);
  const translatedItem = h.els.appUpdateNotesBody.children[0].children[0].children[1].children[0];
  assert.equal(translatedItem.children[0].textContent, '更新：');

  const beforeChangedNotes = h.allocations();
  s.latest.releaseNotes['zh-TW'][0].items.push('下載：改善進度顯示。');
  h.render(s);
  assert.ok(h.allocations() > beforeChangedNotes);
  assert.equal(h.els.appUpdateNotesBody.children[0].children[0].children[1].children.length, 2);
});

test('clearing notes removes cached content and the same version can be rendered again', () => {
  const h = createHarness();
  const s = updateState();
  h.render(s);
  const initialAllocations = h.allocations();
  h.render(null);
  assert.equal(h.els.appUpdateNotes.classList.contains('hidden'), true);
  assert.equal(h.els.appUpdateNotesBody.children.length, 0);
  assert.equal(h.els.appUpdateNotesTitle.textContent, '');
  assert.equal(h.els.appUpdateNotesBody.dataset.contentKey, undefined);
  assert.deepEqual(h.expansions, [true, false]);

  h.render(s);
  assert.ok(h.allocations() > initialAllocations);
  assert.equal(h.els.appUpdateNotes.classList.contains('hidden'), false);
  assert.ok(h.els.appUpdateNotesBody.children.length > 0);
});
