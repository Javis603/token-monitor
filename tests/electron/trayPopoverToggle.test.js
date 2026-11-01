'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const { createTray } = require(path.join(ROOT, 'src/electron/tray'));
const { createWindowVisibilityActions } = require(path.join(ROOT, 'src/electron/plugins/windowVisibility'));
const { popoverBlurMatchesPress, popoverToggleAction, trayToggleAction } = require(path.join(ROOT, 'src/electron/trayModeSettings'));
const { windowToggleShortcutAction } = require(path.join(ROOT, 'src/electron/windowShortcut'));
const source = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');

function sourceBetween(first, next) {
  const start = source.indexOf(first);
  const end = source.indexOf(next, start);
  assert.ok(start >= 0 && end > start, `Missing main.js boundary: ${first}`);
  return source.slice(start, end);
}

// Run the actual main-process show/hide/toggle/blur callbacks and tray handlers
// together, without starting the collector or loading personal settings.
function fixture({ visible = true, focused = visible, platform = 'darwin' } = {}) {
  let point = { x: 110, y: 10 };
  let now = 1000;
  const changes = [], summons = [], cancellations = [];
  const timers = [];
  const win = {
    isDestroyed: () => false,
    isVisible: () => visible,
    isFocused: () => focused,
    isMinimized: () => false,
    getBounds: () => ({ width: 300, height: 200 }),
    setBounds() {},
    show() { visible = true; focused = true; changes.push('show'); },
    hide() { visible = false; focused = false; changes.push('hide'); },
    on(name, callback) { this[name] = callback; }
  };
  class FakeTray {
    constructor() { this.handlers = {}; }
    on(name, callback) { this.handlers[name] = callback; }
    isDestroyed() { return false; }
    setToolTip() {}
    getBounds() { return { x: 100, y: 0, width: 20, height: 24 }; }
    popUpContextMenu() {}
    setContextMenu() {}
  }
  const screen = { getCursorScreenPoint: () => point };
  const context = vm.createContext({
    mainWindow: win, win, tray: null, recentPopoverBlur: null,
    sendMainWindowEvent: channel => { if (channel === 'window:summonCancelled') cancellations.push(channel); else summons.push(channel); },
    pluginWindowActions: createWindowVisibilityActions(hidden => assert.equal(hidden, win)),
    settings: { trayMode: true, showTrayIcon: true },
    process: { platform }, performance: { now: () => now }, screen,
    popoverBlurMatchesPress, popoverToggleAction, trayToggleAction, windowToggleShortcutAction,
    suppressNextBlurHide: false, quitRequested: false, floatingBubbleState: { collapsed: false },
    popoverBounds: () => ({}), setTimeout: (fn) => timers.push(fn),
    applyMacActivationPolicy() {}, applyMacSpaceBehavior() {}, applyWindowSettings() {},
    nudgeTaskbarZOrder() {}, scheduleFloatingBubbleAutoCollapse() {}, expandFloatingBubble() {},
    focusExistingWindow: () => win.show()
  });
  vm.runInContext([
    sourceBetween('function showPopover(', 'function focusExistingWindow('),
    sourceBetween('function handleWindowToggleShortcut(', 'function trayMenuLocale('),
    sourceBetween("  win.on('blur', () => {", '  const onBoundsChange =')
  ].join('\n'), context);
  const pressOptions = vm.runInContext(`({${sourceBetween(
    '    getWindowVisible: () => Boolean(mainWindow', '    onOpenView: openViewFromTray'
  )}})`, context);
  const tray = createTray({
    ...pressOptions, platform, onToggle: context.handleTrayToggle,
    electron: {
      Tray: FakeTray, screen,
      Menu: { buildFromTemplate: () => ({}) },
      nativeImage: { createFromPath: () => ({ resize: () => ({ setTemplateImage() {} }) }) }
    }
  });
  context.tray = tray;
  function emit(name) { tray.handlers[name]?.({}, {}, {}); }
  return {
    get visible() { return visible; },
    get focused() { return focused; }, changes, summons, cancellations,
    advance(ms) { now += ms; },
    enter() { point = { x: 110, y: 10 }; emit('mouse-enter'); },
    leave() { point = { x: 150, y: 50 }; emit('mouse-leave'); },
    down() { emit('mouse-down'); },
    blur() { focused = false; win.blur(); },
    up() { emit('mouse-up'); },
    click() { emit('click'); },
    doubleClick() { emit('double-click'); },
    rightClick() { emit('right-click'); },
    shortcut() { context.handleWindowToggleShortcut(); },
    finishShow() { timers.splice(0).forEach((fn) => fn()); },
    voiceOver() { emit('click'); emit('mouse-down'); }
  };
}

for (const order of ['before-down', 'after-down']) {
  test(`a physical tray click stays closed when blur is ${order}`, () => {
    const f = fixture();
    f.enter();
    if (order === 'before-down') f.blur();
    f.down();
    if (order === 'after-down') f.blur();
    f.advance(5000); // Holding a press must not expire its ownership.
    f.up();
    f.click();
    assert.equal(f.visible, false);
    assert.deepEqual(f.changes, ['hide']);
    f.down(); f.up(); f.click();
    assert.equal(f.visible, true);
  });
}

for (const returnToIcon of [false, true]) {
  test(`a canceled press ignores its trailing click, returnToIcon=${returnToIcon}`, () => {
    const f = fixture();
    f.enter(); f.down(); f.blur(); f.leave();
    if (returnToIcon) f.enter();
    f.up(); f.click();
    assert.equal(f.visible, false);
    assert.deepEqual(f.changes, ['hide']);
    f.enter(); f.down(); f.up(); f.click();
    assert.equal(f.visible, true);
  });
}

test('canceling a press without a click leaves a fresh press usable', () => {
  const f = fixture();
  f.enter(); f.blur(); f.down(); f.leave();
  f.enter(); f.down(); f.up(); f.click();
  assert.equal(f.visible, true);
});

for (const hideVia of ['blur', 'shortcut']) {
  for (const delay of [100, 5000]) {
    test(`VoiceOver reopens after ${hideVia} and ${delay}ms without reusing its trailing down`, () => {
      const f = fixture({ visible: false });
      f.voiceOver();
      assert.equal(f.visible, true);
      f.finishShow();
      if (hideVia === 'blur') f.blur(); else f.shortcut();
      assert.equal(f.visible, false);
      f.advance(delay); f.voiceOver();
      assert.equal(f.visible, true);
    });
  }
}

test('ordinary VoiceOver toggles and a subsequent physical press remain usable', () => {
  const f = fixture({ visible: false });
  f.voiceOver(); assert.equal(f.visible, true);
  f.voiceOver(); assert.equal(f.visible, false);
  f.down(); f.up(); f.click(); assert.equal(f.visible, true);
});

test('a shortcut does not reuse a tray blur and continues toggling visibility', () => {
  const f = fixture();
  f.enter(); f.blur();
  f.shortcut(); assert.equal(f.visible, true);
  f.shortcut(); assert.equal(f.visible, false);
  f.down(); f.up(); f.click(); assert.equal(f.visible, true);
});

test('an unused mouse-up cannot leave a snapshot for a later accessibility activation', async () => {
  const f = fixture();
  f.enter(); f.down(); f.up(); // Cocoa emits no click for clickCount > 2.
  await new Promise(setImmediate);
  f.shortcut(); f.voiceOver();
  assert.equal(f.visible, true);
});

test('double-click and right-click discard a completed press before VoiceOver', () => {
  for (const action of ['doubleClick', 'rightClick']) {
    const f = fixture();
    f.enter(); f.down(); f.up(); f[action]();
    f.shortcut(); f.voiceOver();
    assert.equal(f.visible, true);
  }
});

for (const platform of ['win32', 'linux']) {
  test(`${platform} tray clicks still use current visibility without macOS press state`, () => {
    const f = fixture({ platform });
    f.click(); assert.equal(f.visible, false);
    f.click(); assert.equal(f.visible, true);
  });
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform} shortcut refocuses a visible popover after a suppressed blur`, () => {
    const f = fixture({ platform, visible: false });
    f.shortcut();
    f.blur(); // The opening 250ms guard leaves the popover visible but unfocused.
    assert.equal(f.visible, true);
    assert.equal(f.focused, false);
    f.finishShow();
    f.advance(1000);
    f.shortcut();
    assert.equal(f.visible, true);
    assert.equal(f.focused, true);
    assert.deepEqual(f.changes, ['show', 'show']);
    f.shortcut();
    assert.equal(f.visible, false);
  });

  test(`${platform} tray activation without a completed press refocuses an unfocused popover`, () => {
    const f = fixture({ platform, visible: true, focused: false });
    f.click();
    assert.equal(f.visible, true);
    assert.equal(f.focused, true);
    assert.deepEqual(f.changes, ['show']);
    f.click();
    assert.equal(f.visible, false);
  });
}

test('a completed macOS press closes a visible unfocused popover', () => {
  const f = fixture({ visible: true, focused: false });
  f.enter(); f.down(); f.up(); f.click();
  assert.equal(f.visible, false);
  assert.deepEqual(f.changes, ['hide']);
});

test('VoiceOver refocuses after a suppressed blur without consuming its unpaired down', () => {
  const f = fixture({ visible: false });
  f.voiceOver();
  f.blur();
  assert.equal(f.visible, true);
  assert.equal(f.focused, false);
  f.finishShow();
  f.advance(1000);
  f.voiceOver();
  assert.equal(f.visible, true);
  assert.equal(f.focused, true);
  assert.deepEqual(f.changes, ['show', 'show']);
  f.voiceOver();
  assert.equal(f.visible, false);
});


test('only a completed physical tray press opening the window requests neutral plugin focus', () => {
  const f = fixture({ visible: false });
  f.enter(); f.down(); f.up(); f.click();
  assert.equal(f.visible, true);
  assert.deepEqual(f.summons, ['window:summoned']);
  f.finishShow(); f.down(); f.up(); f.click();
  assert.equal(f.visible, false);
  assert.equal(f.summons.length, 1, 'closing does not reset focus');
});

test('shortcut summons request neutral focus while VoiceOver preserves accessibility focus', () => {
  for (const open of ['shortcut', 'voiceOver']) {
    const f = fixture({ visible: false }); f[open]();
    assert.equal(f.visible, true); assert.deepEqual(f.summons, open === 'shortcut' ? ['window:summoned'] : []);
  }
});


test('native blur cancels focus reset except during the existing popover activation grace', () => {
  const f = fixture({ visible: false });
  f.shortcut(); f.blur();
  assert.deepEqual(f.cancellations, [], 'menu-bar activation blur does not cancel');
  f.finishShow(); f.blur();
  assert.deepEqual(f.cancellations, ['window:summonCancelled'], 'real departure cancels');
});
