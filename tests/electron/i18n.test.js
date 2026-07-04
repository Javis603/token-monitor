'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyTranslations,
  LANGUAGE_OPTIONS,
  MESSAGES,
  normalizeLanguage,
  resolveLocale,
  translate
} = require('../../src/electron/renderer/i18n');

function fakeElement(dataset = {}) {
  const attributes = {};
  return {
    dataset,
    textContent: '',
    title: '',
    placeholder: '',
    attributes,
    setAttribute(name, value) {
      attributes[name] = value;
    },
    getAttribute(name) {
      return attributes[name];
    }
  };
}

test('normalizeLanguage keeps supported choices and falls back to auto', () => {
  assert.equal(normalizeLanguage('zh-tw'), 'zh-TW');
  assert.equal(normalizeLanguage('zh_cn'), 'zh-CN');
  assert.equal(normalizeLanguage('en'), 'en');
  assert.equal(normalizeLanguage('fr'), 'auto');
  assert.equal(normalizeLanguage(''), 'auto');
});

test('resolveLocale maps auto to Chinese variants from browser languages', () => {
  assert.equal(resolveLocale('auto', ['zh-HK', 'en-US']), 'zh-TW');
  assert.equal(resolveLocale('auto', ['zh-Hans-CN', 'en-US']), 'zh-CN');
  assert.equal(resolveLocale('auto', ['en-US']), 'en');
  assert.equal(resolveLocale('zh-CN', ['zh-TW']), 'zh-CN');
});

test('translate falls back to English and interpolates values', () => {
  assert.equal(translate('zh-TW', 'settings.sync.title'), '多裝置同步');
  assert.equal(translate('zh-CN', 'settings.appUpdate.latestWithStatus', { version: '0.2.1', status: '已是最新' }), 'v0.2.1（已是最新）');
  assert.equal(translate('zh-TW', 'missing.key'), 'missing.key');
});

test('every bundled locale defines every English settings key', () => {
  const englishKeys = Object.keys(MESSAGES.en).sort();
  for (const locale of Object.keys(MESSAGES).filter((code) => code !== 'en')) {
    const missing = englishKeys.filter((key) => MESSAGES[locale][key] === undefined);
    assert.deepEqual(missing, [], `${locale} should not rely on English fallback`);
  }
});

test('every language option has a dictionary, normalizes to itself, and is reachable via auto-detect', () => {
  for (const { value } of LANGUAGE_OPTIONS) {
    assert.equal(normalizeLanguage(value), value, `${value} should normalize to itself`);
    if (value !== 'auto') {
      assert.ok(MESSAGES[value], `${value} should have a message dictionary`);
      assert.equal(resolveLocale('auto', [value]), value, `auto should resolve a ${value} system locale`);
    }
  }
});

test('tray limit labels describe remaining quota instead of ambiguous worst windows', () => {
  assert.equal(translate('zh-TW', 'settings.tray.barsSession'), '額度條：單次剩餘最少');
  assert.equal(translate('zh-TW', 'settings.tray.barsAllSessions'), '額度條：前兩個工具的單次額度');
  assert.equal(translate('zh-CN', 'settings.tray.barsWindow'), '额度条：任一额度剩余最少');
});

test('window shortcut labels stay concise in Chinese', () => {
  assert.equal(translate('zh-TW', 'settings.display.windowShortcut'), '快捷鍵');
  assert.equal(translate('zh-TW', 'settings.shortcut.record'), '錄製');
  assert.equal(translate('zh-TW', 'settings.display.windowShortcutListening'), '按下快捷鍵，Esc 取消。');
  assert.equal(translate('zh-TW', 'settings.display.windowShortcutInvalid'), '請搭配 Ctrl、Cmd 或 Alt。');
  assert.equal(translate('zh-TW', 'settings.display.windowShortcutConflict', { shortcut: 'Cmd/Ctrl+Shift+M' }), '無法註冊 Cmd/Ctrl+Shift+M，可能和其他 app 衝突。');
  assert.equal(translate('zh-CN', 'settings.display.windowShortcut'), '快捷键');
  assert.equal(translate('zh-CN', 'settings.shortcut.record'), '录制');
  assert.equal(translate('zh-CN', 'settings.display.windowShortcutListening'), '按下快捷键，Esc 取消。');
  assert.equal(translate('zh-CN', 'settings.display.windowShortcutInvalid'), '请搭配 Ctrl、Cmd 或 Alt。');
  assert.equal(translate('zh-CN', 'settings.display.windowShortcutConflict', { shortcut: 'Cmd/Ctrl+Shift+M' }), '无法注册 Cmd/Ctrl+Shift+M，可能和其他 app 冲突。');
});

test('AI limit capability labels stay compact in Chinese', () => {
  assert.equal(translate('en', 'settings.limits.capability.appCliRpc'), 'App/CLI RPC');
  assert.equal(translate('zh-TW', 'settings.limits.capability.appMustBeOpen'), '需開啟 App 或 CLI');
  assert.equal(translate('zh-TW', 'settings.limits.capability.appCliRpc'), 'App/CLI RPC');
  assert.equal(translate('zh-TW', 'settings.limits.capability.manualLogin'), '手動登入');
  assert.equal(translate('zh-TW', 'settings.limits.status.openApp'), '請開啟 App 或 CLI');
  assert.equal(translate('zh-TW', 'settings.limits.status.linked'), '已連結');
  assert.equal(translate('zh-TW', 'settings.limits.device.local'), '本機');
  assert.equal(translate('zh-TW', 'settings.limits.device.from', { device: 'work-mac' }), '來自 work-mac');
  assert.equal(translate('zh-TW', 'settings.limits.device.localAndSynced', { count: 2 }), '本機 + 2 同步');
  assert.equal(translate('zh-TW', 'settings.limits.device.localAlso'), '本機也有');
  assert.equal(translate('zh-TW', 'settings.limits.capability.web'), 'Web');
  assert.equal(translate('zh-CN', 'settings.limits.capability.appMustBeOpen'), '需打开 App 或 CLI');
  assert.equal(translate('zh-CN', 'settings.limits.capability.appCliRpc'), 'App/CLI RPC');
  assert.equal(translate('zh-CN', 'settings.limits.capability.manualLogin'), '手动登录');
  assert.equal(translate('zh-CN', 'settings.limits.device.from', { device: 'work-mac' }), '来自 work-mac');
  assert.equal(translate('zh-CN', 'settings.limits.status.noSyncedData'), '暂无同步数据');
});

test('applyTranslations updates text, title, aria-label, placeholders, and document lang', () => {
  const title = fakeElement({ i18n: 'settings.sync.title' });
  const button = fakeElement({ i18nTitle: 'settings.sync.copySecret' });
  const dismiss = fakeElement({ i18nAriaLabel: 'settings.appUpdate.dismiss' });
  const input = fakeElement({ i18nPlaceholder: 'settings.sync.secretPlaceholder' });
  const langOption = fakeElement({ i18n: 'settings.language.zhTW' });
  const documentElement = fakeElement();
  const root = {
    documentElement,
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') return [title, langOption];
      if (selector === '[data-i18n-title]') return [button];
      if (selector === '[data-i18n-aria-label]') return [dismiss];
      if (selector === '[data-i18n-placeholder]') return [input];
      return [];
    }
  };

  applyTranslations(root, 'zh-TW');

  assert.equal(title.textContent, '多裝置同步');
  assert.equal(button.title, '複製密鑰');
  assert.equal(dismiss.getAttribute('aria-label'), '忽略此版本');
  assert.equal(input.placeholder, '選填的共享密鑰');
  assert.equal(langOption.textContent, '繁體中文');
  assert.equal(documentElement.getAttribute('lang'), 'zh-TW');
});

test('service status provider preference labels exist in Chinese', () => {
  assert.equal(translate('zh-TW', 'serviceStatus.providersNote'), '選擇 Status 頁顯示哪些服務、以及順序。');
  assert.equal(translate('zh-TW', 'serviceStatus.allHidden'), '已隱藏所有服務');
  assert.equal(translate('zh-TW', 'serviceStatus.configureProviders', { name: '狀態' }), '設定 狀態 服務');
});

test('the affected-component count is localized', () => {
  assert.equal(translate('en', 'serviceStatus.components', { count: 4 }), 'Affected: 4');
  assert.equal(translate('zh-TW', 'serviceStatus.components', { count: 4 }), '受影響組件：4');
  assert.equal(translate('zh-CN', 'serviceStatus.components', { count: 4 }), '受影响组件：4');
});

test('relative status timestamps are localized', () => {
  assert.equal(translate('zh-TW', 'serviceStatus.agoSeconds', { n: 5 }), '5 秒前');
  assert.equal(translate('zh-TW', 'serviceStatus.agoMinutes', { n: 3 }), '3 分鐘前');
});

test('status refresh interval labels exist in Chinese', () => {
  assert.equal(translate('zh-TW', 'serviceStatus.refreshEvery'), '檢查間隔');
  assert.equal(translate('zh-TW', 'serviceStatus.refreshManual'), '手動');
  assert.equal(translate('zh-TW', 'serviceStatus.refreshMinutes', { n: 5 }), '5 分鐘');
});

test('view switcher actions are localized', () => {
  assert.equal(translate('en', 'views.switcher.next', { view: 'Models' }), 'Next: Models');
  assert.equal(translate('zh-TW', 'views.switcher.next', { view: '模型' }), '下一個：模型');
  assert.equal(translate('zh-TW', 'views.switcher.choose'), '選擇視圖');
  assert.equal(translate('zh-CN', 'views.switcher.next', { view: '模型' }), '下一个：模型');
  assert.equal(translate('zh-CN', 'views.switcher.choose'), '选择视图');
});
