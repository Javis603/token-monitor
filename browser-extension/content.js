'use strict';

/* global chrome, document, MutationObserver */

const CHATGPT_STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[data-testid="stop-generating-button"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop streaming"]'
];

function providerFromHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'chatgpt.com' || host === 'chat.openai.com') return 'chatgpt';
  return '';
}

function isVisible(element, view) {
  if (!element || element.disabled || element.getAttribute?.('aria-hidden') === 'true') return false;
  const style = view?.getComputedStyle ? view.getComputedStyle(element) : null;
  if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false;
  const rect = element.getBoundingClientRect?.();
  return !rect || (rect.width > 0 && rect.height > 0);
}

function detectsGeneration(root, _provider, view) {
  return CHATGPT_STOP_SELECTORS.some((selector) => (
    Array.from(root.querySelectorAll(selector)).some((node) => isVisible(node, view))
  ));
}

function createIndicator(doc) {
  const host = doc.createElement('div');
  host.id = 'token-monitor-occupancy-status';
  host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;font:12px system-ui,sans-serif;color:#fff;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const wrapper = doc.createElement('div');
  wrapper.innerHTML = `
    <style>
      .box{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:999px;background:rgba(35,35,35,.9);box-shadow:0 2px 12px rgba(0,0,0,.25)}
      .dot{width:10px;height:10px;border:0;border-radius:50%;background:#188038;padding:0;cursor:pointer}.dot.active{background:#d93025}.dot.error{background:#777}
      .controls{display:none;gap:4px}.box:hover .controls,.box:focus-within .controls{display:flex}
      button.action{border:0;border-radius:10px;padding:2px 7px;background:#555;color:#fff;cursor:pointer;font:11px system-ui,sans-serif}button.action:hover{background:#777}
    </style>
    <div class="box" title="Token Monitor">
      <button class="dot" type="button" aria-label="Token Monitor status"></button>
      <span class="label">自动</span>
      <span class="controls">
        <button class="action" data-action="acquire" type="button">占用</button>
        <button class="action" data-action="release" type="button">释放</button>
        <button class="action" data-action="auto" type="button">自动</button>
      </span>
    </div>`;
  shadow.appendChild(wrapper);
  doc.documentElement.appendChild(host);
  const dot = wrapper.querySelector('.dot');
  const label = wrapper.querySelector('.label');
  return {
    host,
    setStatus(status) {
      dot.className = `dot ${status.state === 'active' ? 'active' : status.state === 'error' ? 'error' : ''}`;
      const mode = status.override === 'force-on' ? '手动占用' : status.override === 'force-off' ? '手动释放' : '自动';
      label.textContent = status.state === 'error' ? '连接错误' : mode;
      wrapper.querySelector('.box').title = status.message || 'Token Monitor';
    },
    onAction(listener) {
      wrapper.addEventListener('click', (event) => {
        const action = event.target?.dataset?.action;
        if (action) listener(action);
      });
    }
  };
}

function registerContentScript() {
  const provider = providerFromHostname(window.location.hostname);
  if (!provider) return;
  const indicator = createIndicator(document);
  let lastActive;
  let scheduled = false;

  function report(force = false) {
    scheduled = false;
    const active = detectsGeneration(document, provider, window);
    if (!force && active === lastActive) return;
    lastActive = active;
    chrome.runtime.sendMessage({
      type: 'token-monitor-occupancy-detection',
      provider,
      active
    }).catch((error) => indicator.setStatus({ state: 'error', message: error.message }));
  }

  function scheduleReport() {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(report, 150);
  }

  indicator.onAction((action) => {
    chrome.runtime.sendMessage({ type: 'token-monitor-occupancy-override', action, provider })
      .catch((error) => indicator.setStatus({ state: 'error', message: error.message }));
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'token-monitor-occupancy-status') indicator.setStatus(message);
  });
  new MutationObserver(scheduleReport).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'aria-hidden', 'data-testid', 'disabled', 'style', 'class']
  });
  report();
  window.setInterval(() => report(true), 15_000);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  registerContentScript();
}

if (typeof module === 'object' && module.exports) {
  module.exports = {
    CHATGPT_STOP_SELECTORS,
    providerFromHostname,
    isVisible,
    detectsGeneration
  };
}
