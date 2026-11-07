'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const directory = path.resolve(__dirname, '../../plugins/openai-api-credit');
const manifest = require('../../plugins/openai-api-credit/manifest.json');
const locales = ['en', 'zh-TW', 'zh-CN', 'ja', 'ko', 'pt-BR'];

test('all supported plugin locales have complete messages and matching placeholders', async () => {
  const { messages, resolveLocale, t } = await import('../../plugins/openai-api-credit/i18n.mjs');
  assert.deepEqual(Object.keys(messages), locales);
  const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const locale of locales) {
    assert.deepEqual(Object.keys(messages[locale]).sort(), Object.keys(messages.en).sort(), locale);
    for (const [key, text] of Object.entries(messages[locale])) {
      assert.equal(typeof text, 'string'); assert.ok(text.trim(), `${locale}: ${key}`);
      assert.deepEqual(placeholders(text), placeholders(messages.en[key]), `${locale}: ${key}`);
    }
  }
  for (const [input, expected] of [['zh_Hans', 'zh-CN'], ['zh-SG', 'zh-CN'], ['zh-Hant-HK', 'zh-TW'], ['ja-JP', 'ja'], ['ko-KR', 'ko'], ['pt-PT', 'pt-BR'], ['en-GB', 'en'], ['fr', 'en'], ['', 'en']]) {
    assert.equal(resolveLocale(input), expected);
  }
  assert.equal(t('fr', 'save'), messages.en.save);
  assert.equal(t('ja', 'expires', { time: '2030-01-01 12:00' }), messages.ja.expires.replace('{time}', '2030-01-01 12:00'));
});

test('localized metadata and public documents are included in the importable package', async () => {
  const { messages } = await import('../../plugins/openai-api-credit/i18n.mjs');
  for (const [locale, words] of Object.entries(messages)) {
    assert.equal(manifest.name[locale], 'OpenAI API Credits');
    assert.equal(manifest.description[locale], words.description);
    assert.equal(manifest.views[0].title[locale], words.label);
    const field = manifest.settings.fields[0];
    assert.equal(field.label[locale], words.label);
    assert.equal(field.description[locale], words.displayHelp);
    assert.deepEqual(field.options.map(option => option.label[locale]), [words.bar, words.balance]);
    for (const prefix of ['README', 'CHANGELOG']) {
      const filename = `${prefix}${locale === 'en' ? '' : `.${locale}`}.md`;
      assert.ok(manifest.files.includes(filename), filename);
      const body = fs.readFileSync(path.join(directory, filename), 'utf8');
      assert.ok(body.trim(), filename);
      for (const [, target] of body.matchAll(/\]\(([^)]+)\)/g)) {
        if (!target.includes('://')) assert.ok(fs.existsSync(path.join(directory, target)), `${filename}: ${target}`);
      }
    }
  }
  for (const filename of ['i18n.mjs', 'settings.mjs', 'backend.cjs', 'balance.cjs']) assert.ok(manifest.files.includes(filename));
  assert.equal(manifest.limits[0].name, 'OpenAI');
  assert.deepEqual(manifest.limits[0].credentials.fields.map(field => field.label), ['Platform session token', 'Organization ID']);
  const { packageDirectory } = require('../../src/electron/plugins/package');
  assert.ok(packageDirectory(directory, { checkCompatibility: false }).bytes.length > 0);
});

test('the declared minimum App version is enforced by the host package importer', () => {
  const { packageDirectory, parsePackage } = require('../../src/electron/plugins/package');
  const appMetadata = require('../../package.json'), originalVersion = appMetadata.version;
  const packaged = packageDirectory(directory, { checkCompatibility: false });
  assert.equal(manifest.engines.tokenMonitor, '>=0.88.0');
  try {
    for (const version of ['0.82.0', '0.87.0', '0.87.99']) {
      appMetadata.version = version;
      assert.throws(() => parsePackage(packaged.bytes), /incompatible Token Monitor version/, version);
    }
    for (const version of ['0.88.0', '0.88.1', '0.89.0']) {
      appMetadata.version = version;
      assert.equal(parsePackage(packaged.bytes).rawManifest.engines.tokenMonitor, manifest.engines.tokenMonitor, version);
    }
  } finally { appMetadata.version = originalVersion; }
});
