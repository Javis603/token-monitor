'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appUpdatePresentation = require('../../src/electron/renderer/appUpdatePresentation');
const { buildEdgeDockCells } = require('../../src/electron/renderer/edgeDock/presentation');

const rendererDir = path.resolve(__dirname, '../../src/electron/renderer');
const dockSource = fs.readFileSync(path.join(rendererDir, 'edgeDock', 'dock.js'), 'utf8');
const dockCss = fs.readFileSync(path.join(rendererDir, 'edgeDock', 'dock.css'), 'utf8');
const dockHtml = fs.readFileSync(path.join(rendererDir, 'edgeDock', 'index.html'), 'utf8');

function updateCell(appUpdate) {
  return buildEdgeDockCells(null, { items: [], appUpdate }).at(-1);
}

const RING_RADIUS = 18.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// The updater's own state, at the three moments the rail draws differently.
function updateState(patch = {}) {
  return {
    currentVersion: '0.69.0',
    latest: {
      version: '0.70.0',
      tag: 'v0.70.0',
      name: 'v0.70.0',
      htmlUrl: 'https://github.com/Javis603/token-monitor/releases/tag/v0.70.0',
      publishedAt: '2026-10-10T00:00:00.000Z',
      releaseNotes: {
        en: [{ title: 'Rail', items: ['Update ring in the edge dock.'] }],
        zh: [{ title: '侧边栏', items: ['侧边栏新增更新圆环。'] }]
      }
    },
    hasUpdate: true,
    showUpdateNotice: true,
    installSupported: true,
    installPhase: 'idle',
    installProgress: null,
    installStarting: false,
    downloaded: false,
    installRetryBlocked: false,
    lastError: null,
    ...patch
  };
}

// ---- Projection -----------------------------------------------------------

test('the update ring rides the tail of the rail and nowhere else when no update is outstanding', () => {
  const stats = { limits: { providers: [{ provider: 'claude', status: 'ok', windows: [{ kind: 'session', label: 'Session', remaining: 40 }] }] } };
  const items = [{ type: 'limit', provider: 'claude' }];

  assert.deepEqual(buildEdgeDockCells(stats, { items }).map((cell) => cell.id), ['claude']);
  assert.deepEqual(buildEdgeDockCells(stats, { items, appUpdate: null }).map((cell) => cell.id), ['claude']);
  // A dismissed version raises no ring — the same `showUpdateNotice` the settings
  // panel's notice is gated on, rather than a rail deciding on its own.
  assert.deepEqual(
    buildEdgeDockCells(stats, { items, appUpdate: updateState({ showUpdateNotice: false }) }).map((cell) => cell.id),
    ['claude']
  );

  const cells = buildEdgeDockCells(stats, { items, appUpdate: updateState() });
  assert.equal(cells.length, 2);
  // Last, always: the cells above it are the user's own order, and an update
  // arriving on top of them would push every provider down for as long as it
  // was outstanding.
  assert.equal(cells.at(-1).id, 'update:app');
  assert.equal(cells[0].id, 'claude');
  assert.equal(cells.at(-1).kind, 'update');
  assert.equal(cells.at(-1).version, '0.70.0');
  // Whole notes and unlocalized: the renderer resolves the locale with the
  // settings panel's own helper.
  assert.equal(cells.at(-1).releaseNotes.zh[0].title, '侧边栏');
  assert.equal(cells.at(-1).progress, null);
  assert.equal(cells.at(-1).downloading, false);
});

test('the ring follows the automatic rail too, and survives limits being off', () => {
  const stats = { limits: { providers: [{ provider: 'claude', status: 'ok', windows: [{ kind: 'session', label: 'Session', remaining: 40 }] }] } };
  const automatic = buildEdgeDockCells(stats, { appUpdate: updateState() });
  assert.equal(automatic.at(-1).id, 'update:app');
  // It is not a limits item, so the limits switch is not its switch.
  const limitsOff = buildEdgeDockCells(stats, {
    items: [{ type: 'limit', provider: 'claude' }],
    limitsEnabled: false,
    appUpdate: updateState()
  });
  assert.deepEqual(limitsOff.map((cell) => cell.id), ['update:app']);
});

test('what a press does is the settings panel\'s action, including the release-page fallback', () => {
  assert.equal(updateCell(updateState()).action, 'download');
  assert.equal(updateCell(updateState({
    installSupported: false,
    installSupportReason: 'unpackaged'
  })).action, 'release');
  assert.equal(updateCell(updateState({ downloaded: true, installPhase: 'downloaded', installProgress: 100 })).action, 'install');
  // A spent attempt can never be installed in this process, so the panel falls
  // back to the page and the ring must not offer a press that can only fail.
  assert.equal(updateCell(updateState({
    downloaded: true,
    installPhase: 'downloaded',
    installProgress: 100,
    installRetryBlocked: true
  })).action, 'release');
});

test('a download in flight rides the ring as a real percentage, clamped', () => {
  const cell = updateCell(updateState({ installPhase: 'downloading', installProgress: 42.4 }));
  assert.equal(cell.downloading, true);
  assert.equal(cell.progress, 42.4);
  assert.equal(updateCell(updateState({ installPhase: 'downloading', installProgress: 140 })).progress, 100);
  assert.equal(updateCell(updateState({ installPhase: 'downloading', installProgress: -3 })).progress, 0);
  // A phase with no reading yet is not zero progress: an updater that has only
  // started says nothing about how much has arrived.
  assert.equal(updateCell(updateState({ installPhase: 'downloading', installProgress: null })).progress, null);
});

test('why the ring stopped moving travels as a key, in the settings panel\'s words', () => {
  const failed = updateCell(updateState({ installPhase: 'error', installError: 'disk full', installErrorKind: 'install-spent-by-failure' }));
  assert.equal(failed.installErrorKey, 'settings.appUpdate.installSpentByFailure');
  assert.equal(failed.checkErrorKey, '');
  const unchecked = updateCell(updateState({ lastError: 'rate limited', lastErrorKind: 'rateLimited' }));
  assert.equal(unchecked.checkErrorKey, 'settings.appUpdate.rateLimited');
  assert.equal(unchecked.installErrorKey, '');
});

// ---- Renderer -------------------------------------------------------------

function fakeElement(tag) {
  return {
    tagName: tag,
    className: '',
    textContent: '',
    children: [],
    dataset: {},
    title: '',
    attributes: {},
    style: { setProperty(name, value) { this[name] = value; }, opacity: '' },
    classList: { add() {} },
    append(...nodes) { this.children.push(...nodes.filter(Boolean)); },
    // SVG nodes are classed through setAttribute, HTML nodes through className,
    // and the ring's fill sits two levels down inside the svg it belongs to.
    setAttribute(name, value) {
      this.attributes[name] = value;
      if (name === 'class') this.className = value;
    },
    querySelector(selector) {
      const wanted = selector.slice(1);
      for (const child of this.children) {
        if (child.className === wanted || child.attributes?.class === wanted) return child;
        const found = child.querySelector?.(selector);
        if (found) return found;
      }
      return null;
    }
  };
}

// The rail's own paint, sliced whole: `ringNode` and `markNode` included, so the
// dasharray the ring really writes is what the assertions read.
function dockHarness() {
  const marks = [];
  const context = vm.createContext({
    document: { createElement: fakeElement, createElementNS: (_ns, tag) => fakeElement(tag) },
    Math, Number, Boolean, Array, Object, JSON,
    SVG_NS: 'http://www.w3.org/2000/svg',
    RING_RADIUS,
    RING_CIRCUMFERENCE,
    RUNNING_SPIN_MS: 1400,
    WAITING_PULSE_MS: 2400,
    Date,
    appearance: () => ({}),
    state: { locale: 'en' },
    appUpdatePresentationApi: appUpdatePresentation,
    t: (key, params) => (params ? `${key}:${params.version ?? ''}` : key),
    el: (tag, className, text) => {
      const node = fakeElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    },
    parseColor: () => null,
    // The real markNode probes the stylesheet for a mask, which needs a real
    // computed style; what matters here is which id the cell asked for.
    markNode: (id) => {
      marks.push(id);
      const node = fakeElement('span');
      node.className = `edge-dock-mark row-icon-${id}`;
      return node;
    }
  });
  // `ringNode` lives with the provider cells it was written next to, so both
  // slices run in one context: the ring this page paints, and the update cell
  // that asks for it.
  vm.runInContext(
    dockSource.slice(dockSource.indexOf('function ringNode('), dockSource.indexOf('function providerCellNode(')),
    context
  );
  const slice = dockSource.slice(
    dockSource.indexOf('// ---- App update ring'),
    dockSource.indexOf('// ---- Reset refill motion')
  );
  vm.runInContext(slice, context);
  return { context, marks };
}

function ringOf(node) {
  const ring = node.children.find((child) => child.className === 'edge-dock-ring');
  return ring.querySelector('.edge-dock-ring-fill');
}

test('the ring offers the update as an empty arc around the app\'s own mark', () => {
  const h = dockHarness();
  const node = h.context.updateCellNode(updateCell(updateState()));
  assert.equal(node.dataset.phase, 'available');
  // Empty rather than filled to zero: there is no reading yet, and a filled arc
  // at 0% would be a claim the updater never made.
  assert.equal(ringOf(node).style.opacity, '0');
  assert.deepEqual(h.marks, ['token-monitor']);
  assert.equal(node.children[1].textContent, '0.70.0');
  assert.equal(node.title, 'edgeDock.update.download');
  assert.match(node.attributes['aria-label'], /edgeDock\.update\.title 0\.70\.0 edgeDock\.update\.download/);
});

test('a download fills the green ring to the real percentage and spins while it runs', () => {
  const h = dockHarness();
  const node = h.context.updateCellNode(updateCell(updateState({ installPhase: 'downloading', installProgress: 42 })));
  assert.equal(node.dataset.phase, 'downloading');
  const fill = ringOf(node);
  assert.equal(fill.attributes['stroke-dashoffset'], String(RING_CIRCUMFERENCE * (1 - 0.42)));
  assert.equal(fill.attributes['stroke-dasharray'], String(RING_CIRCUMFERENCE));
  assert.notEqual(fill.style.opacity, '0');
  assert.equal(node.children[1].textContent, '42%');
  // The arc the other rings spin for work in flight, raised here by phase: an
  // upgrade is work, and the user asked to see it running.
  assert.ok(node.querySelector('.edge-dock-ring-spinner'));
});

test('a download that has not reported a byte yet says so rather than claiming 0%', () => {
  const h = dockHarness();
  // `checking` reaches the rail with no progress reading at all. Drawing that as a
  // filled 0% arc would be a figure the updater never reported.
  const cell = updateCell(updateState({ installPhase: 'checking', installProgress: null }));
  assert.equal(cell.progress, null);
  const node = h.context.updateCellNode(cell);
  assert.equal(node.dataset.phase, 'downloading');
  assert.equal(ringOf(node).style.opacity, '0');
  assert.equal(node.children[1].textContent, '—');
  // Still work in flight, so the arc still turns.
  assert.ok(node.querySelector('.edge-dock-ring-spinner'));
  assert.equal(node.attributes['aria-busy'], 'true');
});

test('a running download invites no press, because one would only be refused', () => {
  const h = dockHarness();
  const node = h.context.updateCellNode(updateCell(updateState({
    installPhase: 'downloading', installProgress: 12
  })));
  // The action policy still says "download" while bytes arrive; the title is what
  // the pointer reads, and it must not offer a press the busy guard refuses.
  assert.equal(node.title, '');
  assert.doesNotMatch(node.attributes['aria-label'], /edgeDock\.update\.download/);
});

test('a full download swaps the logo for a green arrow and offers the restart', () => {
  const h = dockHarness();
  const cell = updateCell(updateState({
    downloaded: true, installPhase: 'downloaded', installProgress: 100
  }));
  assert.equal(cell.action, 'install');
  const node = h.context.updateCellNode(cell);
  assert.equal(node.dataset.phase, 'downloaded');
  // Full, so the ring itself says the download is complete before the press.
  assert.equal(ringOf(node).attributes['stroke-dashoffset'], '0');
  assert.deepEqual(h.marks, [], 'the app mark is replaced, not kept behind the arrow');
  const mark = node.children[0].children.find((child) => child.className.includes('edge-dock-mark-update'));
  assert.ok(mark);
  assert.equal(node.children[1].textContent, '0.70.0');
  assert.equal(node.title, 'edgeDock.update.restart');
});

test('the hand-off window and the unsupported case each say what the ring can still do', () => {
  const h = dockHarness();
  const starting = h.context.updateCellNode(updateCell(updateState({
    downloaded: true, installPhase: 'downloaded', installProgress: 100, installStarting: true
  })));
  assert.equal(starting.dataset.phase, 'downloaded');
  assert.equal(starting.title, 'edgeDock.update.installing');

  const unsupported = h.context.updateCellNode(updateCell(updateState({
    installSupported: false, installSupportReason: 'windows-portable'
  })));
  assert.equal(unsupported.title, 'edgeDock.update.release');
});

test('the hover card is the release notes in the reader\'s language, plus the press it describes', () => {
  const h = dockHarness();
  const card = h.context.updateCard(updateCell(updateState()));
  const notes = card.children.find((child) => child.className.includes('edge-dock-update-notes'));
  const items = notes.querySelector('.edge-dock-update-notes-list').children;
  assert.deepEqual(items.map((item) => item.textContent), ['Update ring in the edge dock.']);
  // `.edge-dock-accounts` is the card's scroll container (`overflow-y: auto`,
  // `flex: 1 1 auto; min-height: 0`) and the class commitCard restores a scroll
  // position for. A release long enough to outgrow the card only scrolls if the
  // notes are in it, and only stays where the reader left it if it stays there.
  assert.match(notes.className, /edge-dock-accounts/);
  assert.match(dockCss, /\.edge-dock-accounts \{[^}]*overflow-y: auto/);
  assert.match(dockSource, /const CARD_SCROLL_SELECTOR = '\.edge-dock-accounts, \.edge-dock-session-list';/);

  // The same module resolves the locale the settings panel does, including its
  // fallback — the card cannot answer in a different language than the panel.
  h.context.state.locale = 'zh-CN';
  const localized = h.context.updateCard(updateCell(updateState()));
  assert.deepEqual(
    localized.querySelector('.edge-dock-update-notes-list').children.map((item) => item.textContent),
    ['侧边栏新增更新圆环。']
  );
  // A locale with no group of its own falls back the way the panel does, rather
  // than showing an empty release.
  h.context.state.locale = 'ja';
  assert.deepEqual(
    h.context.updateCard(updateCell(updateState())).querySelector('.edge-dock-update-notes-list')
      .children.map((item) => item.textContent),
    ['Update ring in the edge dock.']
  );

  const status = card.children.find((child) => child.className.includes('edge-dock-update-status'));
  assert.equal(status.textContent, 'edgeDock.update.currentVersion:0.69.0 · edgeDock.update.download');
});

test('a release with no notes in this language says so rather than showing an empty card', () => {
  const h = dockHarness();
  const cell = updateCell(updateState({
    latest: { version: '0.70.0', htmlUrl: 'https://example.test/release' }
  }));
  const card = h.context.updateCard(cell);
  assert.equal(card.children.some((child) => child.className.includes('edge-dock-update-notes')), false);
  assert.ok(card.children.some((child) => child.textContent === 'edgeDock.update.noNotes'));
});

test('a new kind of cell cannot arrive half-wired: the rail and the card dispatch on it', () => {
  const h = dockHarness();
  const cell = updateCell(updateState());
  assert.equal(h.context.cellNode(cell).dataset.phase, 'available');
  assert.equal(h.context.cellCard(cell).className, 'edge-dock-card edge-dock-card-update');
});

// ---- Page wiring ----------------------------------------------------------

test('the dock page loads the update module the card resolves its notes with', () => {
  // Loaded before presentation.js and dock.js, which is the order the renderer's
  // globals are read in; a missing tag is a card that throws on first hover.
  const module = dockHtml.indexOf('<script src="../appUpdatePresentation.js"></script>');
  assert.ok(module > 0, 'the update presentation module must be on the page');
  assert.ok(module < dockHtml.indexOf('<script src="dock.js"></script>'));
});

test('every state the updater announces reaches the rail, in the same push', () => {
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  // The rail is projected, not subscribed: the dock window holds no updater, so
  // the only way a download tick lands on it is this broadcast. Without it the
  // ring would sit on "update available" until the next stats push.
  const push = main.slice(main.indexOf('function sendAppUpdatePush()'), main.indexOf('async function runAppUpdateCheck('));
  assert.match(push, /repaintEdgeDockCells\(\)/);

  // The install hand-off is the case a return value cannot carry: the settings
  // panel reads the promise's result over IPC, and the rail has no such channel.
  // Between the press and the installer taking over — tens of seconds on macOS —
  // the ring must already say so, or a second press is offered and refused.
  const install = main.slice(
    main.indexOf('async function installDownloadedAppUpdate('),
    main.indexOf('// The one URL the edge dock can ask for')
  );
  const handOff = install.indexOf('autoUpdater.quitAndInstall(true, true);');
  const broadcast = install.indexOf('sendAppUpdatePush();', handOff);
  assert.ok(handOff >= 0 && broadcast > handOff, 'a successful hand-off must broadcast the new state');
});

test('the release-page fallback returns its promise, so a browser that refuses is not a silent no-op', () => {
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  const action = main.slice(main.indexOf('onUpdateCellAction:'), main.indexOf('onPlacementChange:'));
  assert.match(action, /return shell\.openExternal\(cell\.htmlUrl\)/);
});

test('the stylesheet dresses exactly the phases the ring paints', () => {
  // Green rather than the accent colour: it is the one reading on the rail that
  // is not a quota, and must not read as another account.
  assert.match(dockCss, /\.edge-dock-cell-update\[data-phase="downloading"\] \.edge-dock-ring-spinner \{[^}]*animation: edge-dock-running-spin/);
  assert.match(dockCss, /\.edge-dock-mark-update \{[^}]*var\(--success\)[^}]*arrow-up\.svg/);
});
