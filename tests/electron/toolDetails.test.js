'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { detailPercentLabel, modelRowsForTool } = require('../../src/electron/renderer/toolDetails');

test('modelRowsForTool keeps the same model separated by tool and sorts usage', () => {
  const period = {
    clients: { codex: 1000, opencode: 400 },
    clientCosts: { codex: 2, opencode: 0.4 },
    clientModels: {
      codex: { shared: 250, 'gpt-5.4': 700 },
      opencode: { shared: 400 }
    },
    clientModelCosts: {
      codex: { shared: 0.25, 'gpt-5.4': 1.5 },
      opencode: { shared: 0.4 }
    }
  };

  assert.deepEqual(modelRowsForTool(period, 'codex'), [
    { key: 'gpt-5.4', name: 'gpt-5.4', value: 700, cost: 1.5, percent: 70, unattributed: false },
    { key: 'shared', name: 'shared', value: 250, cost: 0.25, percent: 25, unattributed: false },
    { key: '__unattributed', name: '__unattributed', value: 50, cost: 0.25, percent: 5, unattributed: true }
  ]);
  assert.deepEqual(modelRowsForTool(period, 'opencode'), [
    { key: 'shared', name: 'shared', value: 400, cost: 0.4, percent: 100, unattributed: false }
  ]);
});

test('modelRowsForTool tolerates missing, invalid, and cost-only attribution', () => {
  assert.deepEqual(modelRowsForTool(null, 'codex'), []);
  assert.deepEqual(modelRowsForTool({ clients: { codex: 0 }, clientModelCosts: { codex: { unknown: 2 } } }, 'codex'), [
    { key: 'unknown', name: 'unknown', value: 0, cost: 2, percent: 0, unattributed: false }
  ]);
  assert.deepEqual(modelRowsForTool({
    clients: { codex: 50 },
    clientModels: { codex: { broken: Number.NaN, negative: -1, valid: 75 } }
  }, 'codex'), [
    { key: 'valid', name: 'valid', value: 75, cost: 0, percent: 100, unattributed: false }
  ]);
});

test('modelRowsForTool does not invent a remainder without any model attribution', () => {
  assert.deepEqual(modelRowsForTool({
    clients: { codex: 50 },
    clientCosts: { codex: 1 }
  }, 'codex'), []);
});

test('detailPercentLabel does not present small positive shares as zero', () => {
  assert.equal(detailPercentLabel(95.2), '95%');
  assert.equal(detailPercentLabel(0.29), '<1%');
  assert.equal(detailPercentLabel(0), '0%');
  assert.equal(detailPercentLabel(150), '100%');
});

test('tool details helper loads before app.js and exposes a contextual app footer switch', () => {
  const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  assert.ok(html.indexOf('<script src="usageAttributionRows.js"></script>') < html.indexOf('<script src="toolDetails.js"></script>'));
  assert.ok(html.indexOf('<script src="toolDetails.js"></script>') < html.indexOf('<script src="app.js"></script>'));
  assert.match(html, /id="toolDetailFooter"[^>]*role="group"/);
  assert.match(app, /function activeToolDetail\(\)/);
  assert.match(app, /function setActiveToolDetailMode\(mode\)/);
  assert.match(app, /state\.toolDetailMode = mode/);
  assert.match(app, /toolDetailMode: state\.toolDetailMode/);
  assert.match(app, /state\.toolDetailMode = mode;\s*render\(\);/);
  assert.match(app, /const mode = state\.toolDetailMode === 'models' && hasModels/);
  assert.match(app, /model\.unattributed === true \? labels\.unclassified : model\.name/);
  assert.match(app, /els\.toolDetailFooter\.classList\.toggle\('hidden', !active\)/);
  assert.match(css, /\.tool-detail-footer-option:focus-visible/);
  assert.match(css, /\.accordion-row \{[^}]*line-height: 1\.35;/);
  assert.doesNotMatch(css, /\.tool-detail-switch/);
  assert.doesNotMatch(app, /className = 'tool-detail-tabs'/);
});
