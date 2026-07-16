'use strict';

/* global chrome, document */

const CONFIG_KEY = 'tokenMonitorOccupancyConfig';

function normalizedOptions(input) {
  return {
    hubUrl: String(input.hubUrl || '').trim().replace(/\/+$/, ''),
    secret: String(input.secret || '').trim(),
    deviceId: String(input.deviceId || '').trim(),
    deviceName: String(input.deviceName || '').trim(),
    accountIds: {
      chatgptCom: String(input.accountIds?.chatgptCom || '').trim(),
      chatOpenaiCom: String(input.accountIds?.chatOpenaiCom || '').trim()
    }
  };
}

function validHubUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(String(value || '')).protocol); } catch (_) { return false; }
}

function hubOriginPattern(value) {
  if (!validHubUrl(value)) return '';
  const url = new URL(value);
  return `${url.protocol}//${url.host}/*`;
}

function registerOptions() {
  const form = document.querySelector('#settings-form');
  const status = document.querySelector('#status');
  const fields = {
    hubUrl: document.querySelector('#hub-url'),
    secret: document.querySelector('#secret'),
    deviceId: document.querySelector('#device-id'),
    deviceName: document.querySelector('#device-name'),
    chatgptCom: document.querySelector('#account-chatgpt-com'),
    chatOpenaiCom: document.querySelector('#account-chat-openai-com')
  };

  chrome.storage.local.get(CONFIG_KEY, (result) => {
    const config = normalizedOptions(result[CONFIG_KEY] || {});
    fields.hubUrl.value = config.hubUrl;
    fields.secret.value = config.secret;
    fields.deviceId.value = config.deviceId || (crypto.randomUUID ? crypto.randomUUID() : `browser-${Date.now()}`);
    fields.deviceName.value = config.deviceName;
    fields.chatgptCom.value = config.accountIds.chatgptCom;
    fields.chatOpenaiCom.value = config.accountIds.chatOpenaiCom;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const config = normalizedOptions({
      hubUrl: fields.hubUrl.value,
      secret: fields.secret.value,
      deviceId: fields.deviceId.value,
      deviceName: fields.deviceName.value,
      accountIds: {
        chatgptCom: fields.chatgptCom.value,
        chatOpenaiCom: fields.chatOpenaiCom.value
      }
    });
    if (!validHubUrl(config.hubUrl)) {
      status.textContent = '请输入有效的 http:// 或 https:// Hub URL。';
      return;
    }
    if (!config.deviceId) {
      status.textContent = '设备 ID 不能为空。';
      return;
    }
    if (!config.secret) {
      status.textContent = '浏览器扩展跨域连接 Hub 时必须配置共享密钥。';
      return;
    }
    const origin = hubOriginPattern(config.hubUrl);
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      status.textContent = '未获得该 Hub 地址的访问权限，设置尚未保存。';
      return;
    }
    await chrome.storage.local.set({ [CONFIG_KEY]: config });
    status.textContent = '已保存。现有网页会在下一次状态变化时使用新设置。';
  });
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') registerOptions();

if (typeof module === 'object' && module.exports) module.exports = { hubOriginPattern, normalizedOptions, validHubUrl };
