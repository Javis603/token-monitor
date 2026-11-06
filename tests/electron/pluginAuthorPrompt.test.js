'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { translate, LANGUAGE_OPTIONS } = require('../../src/electron/renderer/i18n');
const root = path.resolve(__dirname, '../..');
const decode = text => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
test('App and both static website entry points share the exact author prompt for every website locale', () => {
  // Desktop and website translations can ship independently.
  const site = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'site/scripts/i18n.js'), 'utf8'), site);
  assert.ok(site.supportedLanguages.length > 0);
  const appLocales = new Set(LANGUAGE_OPTIONS.map(option => option.value));
  for (const file of ['index', 'plugin-quickstart']) {
    const html = fs.readFileSync(path.join(root, `site/docs/${file}.html`), 'utf8');
    const articles = new Map([...html.matchAll(/<article\b[^>]*lang="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)].map(([, locale, body]) => [locale, body]));
    for (const locale of site.supportedLanguages) {
      assert.ok(appLocales.has(locale), `app supports website locale ${locale}`);
      const prompt = articles.get(locale)?.match(/<figure class="code prompt-card">[\s\S]*?<code>([\s\S]*?)<\/code>/)?.[1];
      assert.ok(prompt, `${file}/${locale}`);
      assert.equal(translate(locale, 'plugins.authoring.prompt'), decode(prompt), `${file}/${locale}`);
      for (const key of ['intro', 'label', 'guide', 'copy', 'copied', 'copyFallback']) assert.notEqual(translate(locale, `plugins.authoring.${key}`), `plugins.authoring.${key}`);
    }
  }
});
