'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { sessionRowsForPeriod } = require('../../src/electron/renderer/sessionRows');

function rendererSource() {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
}

function rendererStyles() {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'styles.css'), 'utf8');
}

function clientLabelIds(source) {
  const match = source.match(/const clientLabels = \{([^}]+)\};/);
  assert.ok(match, 'clientLabels declaration should exist');
  return new Set([...match[1].matchAll(/([a-z0-9_-]+)\s*:/g)].map((item) => item[1]));
}

function knownClientIds(source) {
  const match = source.match(/const KNOWN_CLIENTS = \[([\s\S]*?)\];/);
  assert.ok(match, 'KNOWN_CLIENTS declaration should exist');
  return [...match[1].matchAll(/id:\s*'([^']+)'/g)].map((item) => item[1]);
}

test('renderer client labels cover every known client', () => {
  const source = rendererSource();
  const labels = clientLabelIds(source);
  const missing = knownClientIds(source).filter((id) => !labels.has(id));

  assert.deepEqual(missing, []);
});

test('renderer known clients include current tokscale-supported tools', () => {
  const clients = knownClientIds(rendererSource());
  for (const client of ['cline', 'kimi', 'qwen', 'grok', 'copilot', 'pi', 'zed', 'kilocode', 'commandcode', 'micode', 'zcode', 'kiro', 'codebuddy', 'workbuddy', 'reasonix']) {
    assert.ok(clients.includes(client), `${client} should be a known renderer client`);
  }
});

test('renderer distinguishes Grok model and Grok Build tool icons', () => {
  const styles = rendererStyles();
  assert.match(styles, /\.row-icon-xai\s*\{[^}]*assets\/icons\/grok\.svg/s);
  assert.match(styles, /\.row-icon-grok\s*\{[^}]*assets\/icons\/xai\.svg/s);
  assert.match(styles, /\.limit-icon-grok\s*\{[^}]*assets\/icons\/grok\.svg/s);
  assert.match(styles, /\.limit-icon-copilot\s*\{[^}]*assets\/icons\/copilot\.svg/s);
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
  assert.match(styles, /\.limit-icon-zai\s*\{[^}]*assets\/icons\/zai\.svg/s);
  assert.match(styles, /\.limit-icon-volcengine\s*\{[^}]*assets\/icons\/volcengine\.svg/s);
  assert.match(styles, /\.limit-icon-qoder\s*\{[^}]*assets\/icons\/qoder\.svg/s);
  assert.match(styles, /\.limit-icon-ollama\s*\{[^}]*assets\/icons\/ollama\.svg/s);
  assert.match(styles, /\.row-icon-ollama\s*\{[^}]*assets\/icons\/ollama\.svg/s);
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
