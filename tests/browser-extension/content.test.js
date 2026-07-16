'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { providerFromHostname, isVisible, detectsGeneration } = require('../../browser-extension/content');

function node({ width = 20, height = 20, disabled = false, ariaHidden = 'false' } = {}) {
  return {
    disabled,
    getAttribute(name) { return name === 'aria-hidden' ? ariaHidden : null; },
    getBoundingClientRect() { return { width, height }; }
  };
}

test('recognizes only exact supported hostnames', () => {
  assert.equal(providerFromHostname('chatgpt.com'), 'chatgpt');
  assert.equal(providerFromHostname('CHAT.OPENAI.COM'), 'chatgpt');
  assert.equal(providerFromHostname('claude.ai'), '');
  assert.equal(providerFromHostname('claude.ai.evil.example'), '');
});

test('visibility rejects hidden, transparent, disabled, and zero-size controls', () => {
  const visibleView = { getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: '1' }; } };
  assert.equal(isVisible(node(), visibleView), true);
  assert.equal(isVisible(node({ disabled: true }), visibleView), false);
  assert.equal(isVisible(node({ ariaHidden: 'true' }), visibleView), false);
  assert.equal(isVisible(node({ width: 0 }), visibleView), false);
  assert.equal(isVisible(node(), { getComputedStyle() { return { display: 'none' }; } }), false);
});

test('generation detection requires a known visible stop button', () => {
  const visible = node();
  const hidden = node({ width: 0 });
  const root = {
    querySelectorAll(selector) {
      if (selector === 'button[data-testid="stop-button"]') return [hidden, visible];
      return [];
    }
  };
  assert.equal(detectsGeneration(root, 'chatgpt', null), true);
  assert.equal(detectsGeneration({ querySelectorAll() { return []; } }, 'chatgpt', null), false);
});
