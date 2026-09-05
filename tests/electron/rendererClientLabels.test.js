'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { sessionRowsForPeriod } = require('../../src/electron/renderer/sessionRows');
const { CLIENT_LABELS, CLIENT_IDS } = require('../../src/shared/clientCatalog');

function rendererSource() {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
}

function rendererStyles() {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'styles.css'), 'utf8');
}

// clientLabels and KNOWN_CLIENTS are destructured out of the shared catalog
// now, so read that contract directly instead of regex-scraping app.js for
// declarations that have moved. The clientsWithIcon and styles.css checks below
// still scrape on purpose — that wiring has not been migrated.
function clientLabelIds() {
  return new Set(Object.keys(CLIENT_LABELS));
}

function knownClientIds() {
  return [...CLIENT_IDS];
}

test('app.js takes client identity from the catalog and keeps no copy of it', () => {
  // An ownership boundary, not a data layout: that CLIENT_LABELS covers every
  // catalog id is asserted in tests/shared/clientCatalog.test.js, so repeating it
  // here would only compare the catalog with itself. What is worth guarding is
  // that the renderer still sources identity from the catalog and has not grown a
  // second copy of the list.
  const source = rendererSource();
  assert.match(source, /window\.TokenMonitorClientCatalog/);
  assert.doesNotMatch(source, /const clientLabels = \{/);
  assert.doesNotMatch(source, /const KNOWN_CLIENTS = \[/);
});

test('renderer known clients include current tokscale-supported tools', () => {
  const clients = knownClientIds();
  for (const client of ['cline', 'kimi', 'qwen', 'grok', 'copilot', 'pi', 'zed', 'kilocode', 'commandcode', 'micode', 'zcode', 'kiro', 'codebuddy', 'workbuddy', 'reasonix', 'dsh']) {
    assert.ok(clients.includes(client), `${client} should be a known renderer client`);
  }
});

test('renderer distinguishes Grok model and Grok Build tool icons', () => {
  const styles = rendererStyles();
  assert.match(styles, /\.row-icon-xai\s*\{[^}]*assets\/icons\/grok\.svg/s);
  assert.match(styles, /\.row-icon-grok\s*\{[^}]*assets\/icons\/xai\.svg/s);
  assert.match(styles, /\.limit-icon\.row-icon-grok\s*\{[^}]*assets\/icons\/grok\.svg/s);
  assert.match(styles, /^\.row-icon-copilot\s*\{[^}]*assets\/icons\/copilot\.svg/m);
});

test('renderer reuses vendor icons for MiMo Code and ZCode tool rows', () => {
  const styles = rendererStyles();
  assert.match(styles, /\.row-icon-micode\s*\{[^}]*assets\/icons\/xiaomi\.svg/s);
  assert.match(styles, /\.row-icon-zcode\s*\{[^}]*assets\/icons\/zai\.svg/s);
});

test('renderer uses the Kiro brand icon for the Kiro tool row', () => {
  const styles = rendererStyles();
  assert.match(styles, /\.row-icon-kiro\s*\{[^}]*assets\/icons\/kiro\.svg/s);
});

test('renderer wires limit provider brand icons for Z.ai, Volcengine, and Qoder', () => {
  const source = rendererSource();
  const styles = rendererStyles();

  assert.match(source, /clientsWithIcon = new Set\(\[[\s\S]*'zai'[\s\S]*'volcengine'[\s\S]*'qoder'/);
  assert.match(styles, /^\.row-icon-zai\s*\{[^}]*assets\/icons\/zai\.svg/m);
  assert.match(styles, /^\.row-icon-volcengine\s*\{[^}]*assets\/icons\/volcengine\.svg/m);
  assert.match(styles, /^\.row-icon-qoder\s*\{[^}]*assets\/icons\/qoder\.svg/m);
  assert.match(styles, /^\.row-icon-ollama\s*\{[^}]*assets\/icons\/ollama\.svg/m);
});

test('renderer wires the Doubao vendor icon for Doubao model rows', () => {
  const source = rendererSource();
  const styles = rendererStyles();

  assert.match(source, /clientsWithIcon = new Set\(\[[\s\S]*'doubao'[\s\S]*'volcengine'[\s\S]*'qoder'/);
  assert.match(styles, /\.row-icon-doubao\s*\{[^}]*assets\/icons\/doubao\.svg/s);
});

test('renderer wires the Hunyuan vendor icon for Hunyuan model rows', () => {
  const source = rendererSource();
  const styles = rendererStyles();

  assert.match(source, /clientsWithIcon = new Set\(\[[\s\S]*'hunyuan'/);
  assert.match(styles, /\.row-icon-hunyuan\s*\{[^}]*assets\/icons\/hunyuan\.svg/s);
  assert.equal(fs.existsSync(path.join(__dirname, '..', '..', 'assets', 'icons', 'hunyuan.svg')), true);
});

test('renderer maps MiMo provider rows to the Xiaomi brand icon', () => {
  const source = rendererSource();
  const styles = rendererStyles();

  assert.match(source, /clientsWithIcon = new Set\(\[[\s\S]*'xiaomi', 'mimo'/);
  assert.match(styles, /\.row-icon-xiaomi,\s*\.row-icon-mimo\s*\{[^}]*assets\/icons\/xiaomi\.svg/s);
});

test('renderer uses the CodeBuddy and WorkBuddy brand icons for their tool rows', () => {
  const styles = rendererStyles();
  assert.match(styles, /\.row-icon-codebuddy\s*\{[^}]*assets\/icons\/codebuddy\.svg/s);
  assert.match(styles, /\.row-icon-workbuddy\s*\{[^}]*assets\/icons\/workbuddy\.svg/s);
});

test('renderer uses the Reasonix icon for the Reasonix tool row', () => {
  const styles = rendererStyles();
  assert.match(styles, /\.row-icon-reasonix\s*\{[^}]*assets\/icons\/reasonix\.svg/s);
});

test('renderer uses the DeepSeek Harness icon for the DSH tool row', () => {
  const styles = rendererStyles();
  assert.match(styles, /\.row-icon-dsh\s*\{[^}]*assets\/icons\/dsh\.svg/s);
});

test('renderer uses the mask-safe Command Code icon for its tool row', () => {
  const source = rendererSource();
  const styles = rendererStyles();
  const icon = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'icons', 'commandcode.svg'), 'utf8');

  assert.match(source, /clientsWithIcon = new Set\([\s\S]*'commandcode'/);
  assert.match(styles, /\.row-icon-commandcode\s*\{[^}]*assets\/icons\/commandcode\.svg/s);
  // Cropped to the glyph: the outer rounded-square frame was dropped so the
  // mark fills the icon box like every other tool row.
  assert.match(icon, /viewBox="26\.1784 26\.1784 83\.7708 83\.7708"/);
  assert.doesNotMatch(icon, /fill="#(?:000|fff)"/i);
  assert.equal((icon.match(/<path\b/g) || []).length, 1);
});

test('Reasonix icon keeps the official color in a mask-safe SVG path', () => {
  const icon = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'icons', 'reasonix.svg'), 'utf8');
  assert.match(icon, /fill="#0153e5"/);
  assert.match(icon, /fill-rule="evenodd"/);
  assert.doesNotMatch(icon, /stroke=/);
});

test('Reasonix native session keeps presentation identity for the brand icon path', () => {
  const source = rendererSource();
  assert.match(source, /clientsWithIcon = new Set\([\s\S]*'reasonix'/);
  assert.match(source, /if \(breakdown === 'session'\) \{[\s\S]*rowData\.client && clientsWithIcon\.has\(rowData\.client\)[\s\S]*row-icon-\$\{rowData\.client\}/);

  const [row] = sessionRowsForPeriod({ sessions: {} }, {
    nativeSessions: {
      'reasonix:branch-id': {
        client: 'reasonix',
        sessionId: 'reasonix:branch-id',
        model: 'deepseek/deepseek-v4-flash',
        totalTokens: 140
      }
    },
    clientLabels: { reasonix: 'Reasonix' },
    clientColors: { reasonix: '#4d6bfe' }
  });
  assert.equal(row.client, 'reasonix');
  assert.equal(row.name, 'Reasonix · deepseek/deepseek-v4-flash');
});

test('LM Studio has a label and uses the standard mask-safe icon path', () => {
  const source = rendererSource();
  const styles = rendererStyles();

  assert.ok(clientLabelIds().has('lmstudio'));
  assert.match(source, /clientsWithIcon = new Set\([\s\S]*'lmstudio'/);
  assert.match(styles, /\.row-icon-lmstudio\s*\{[^}]*mask-image:\s*url\([^)]*assets\/icons\/lmstudio\.svg\)/s);
  assert.doesNotMatch(styles, /\.row-icon-lmstudio\s*\{[^}]*background-image:/s);
  assert.equal(fs.existsSync(path.join(__dirname, '..', '..', 'assets', 'icons', 'lmstudio.svg')), true);
  assert.equal(fs.existsSync(path.join(__dirname, '..', '..', '.github', 'assets', 'tools-icon', 'lmstudio.png')), true);
});

test('Unsloth has a label and uses the standard mask-safe icon path', () => {
  const source = rendererSource();
  const styles = rendererStyles();
  assert.ok(clientLabelIds().has('unsloth'));
  assert.match(source, /clientsWithIcon = new Set\([\s\S]*'unsloth'/);
  assert.match(styles, /\.row-icon-unsloth\s*\{[^}]*mask-image:\s*url\([^)]*assets\/icons\/unsloth\.svg\)/s);
  assert.doesNotMatch(styles, /\.row-icon-unsloth\s*\{[^}]*background-image:/s);
  assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'assets', 'icons', 'unsloth.svg')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', '..', '.github', 'assets', 'tools-icon', 'unsloth.png')));
});
