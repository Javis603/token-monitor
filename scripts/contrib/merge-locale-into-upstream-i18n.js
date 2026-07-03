#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const locale = process.argv[2];

if (!locale || !['ko', 'ja'].includes(locale)) {
  console.error('Usage: node scripts/contrib/merge-locale-into-upstream-i18n.js <ko|ja>');
  process.exit(1);
}

const upstreamPath = path.join(ROOT, 'src/electron/renderer/i18n.js');
const forkPath = path.join(ROOT, '.contrib-fork-i18n.js');

if (!fs.existsSync(forkPath)) {
  console.error('Missing .contrib-fork-i18n.js — run: git show main:src/electron/renderer/i18n.js > .contrib-fork-i18n.js');
  process.exit(1);
}

function loadI18nApi(filePath) {
  const context = { window: {}, module: { exports: {} } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(filePath, 'utf8'), context);
  return context.window.TokenMonitorI18n || context.module.exports;
}

const meta = {
  ko: { option: 'korean', native: '한국어', tags: ["if (tag === 'ko' || tag.startsWith('ko-') || tag === 'kr') return 'ko';"] },
  ja: { option: 'japanese', native: '日本語', tags: ["if (tag === 'ja' || tag.startsWith('ja-')) return 'ja';"] }
}[locale];

const upstreamApi = loadI18nApi(upstreamPath);
const forkApi = loadI18nApi(forkPath);
const enKeys = Object.keys(upstreamApi.MESSAGES.en);
const forkLocale = forkApi.MESSAGES[locale] || {};
const merged = {};
for (const key of enKeys) merged[key] = forkLocale[key] || upstreamApi.MESSAGES.en[key];

let source = fs.readFileSync(upstreamPath, 'utf8');

if (!source.includes(`value: '${locale}'`)) {
  source = source.replace(
    "    { value: 'zh-CN', labelKey: 'settings.language.zhCN' }\n  ];",
    `    { value: 'zh-CN', labelKey: 'settings.language.zhCN' },\n    { value: '${locale}', labelKey: 'settings.language.${meta.option}' }\n  ];`
  );
  for (const marker of ["'settings.language.zhCN': '简体中文',", "'settings.language.zhCN': '简体中文'"]) {
    if (source.includes(marker)) {
      source = source.replace(
        marker,
        `${marker}\n      'settings.language.${meta.option}': '${meta.native}',`
      );
      break;
    }
  }
}

for (const rule of meta.tags) {
  if (!source.includes(rule)) {
    source = source.replace(
      "    if (tag === 'en' || tag.startsWith('en-')) return 'en';",
      `    ${rule}\n    if (tag === 'en' || tag.startsWith('en-')) return 'en';`
    );
  }
}

const escapedEntries = Object.entries(merged)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, value]) => `      '${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}': '${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',`);
const localeBlock = `\n    ${locale}: {\n${escapedEntries.join('\n')}\n    }`;

const insertRe = /\n    \}\n  \};\n\n  function localeFromTag\(value\) \{/;
if (!insertRe.test(source)) throw new Error('Could not find MESSAGES closing block');
source = source.replace(insertRe, `\n    },${localeBlock}\n  };\n\n  function localeFromTag(value) {`);

fs.writeFileSync(upstreamPath, source);
console.log(`Merged ${locale}: ${Object.keys(forkLocale).length} translated keys of ${enKeys.length} total.`);
