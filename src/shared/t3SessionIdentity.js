'use strict';

const fs = require('node:fs');
const path = require('node:path');

// T3 owns the relationship. These bindings only select the accounting client;
// a strong native reference must still match an existing session exactly.
const DRIVER_CLIENTS = Object.freeze({
  codex: 'codex', claudeAgent: 'claude', cursor: 'cursor',
  opencode: 'opencode', grok: 'grok', muse: 'muse'
});
const REGISTRY_CLIENTS = Object.freeze({
  'codex-acp': 'codex', 'claude-acp': 'claude', cursor: 'cursor',
  opencode: 'opencode', 'grok-build': 'grok', devin: 'devin',
  'amp-acp': 'amp', cline: 'cline', 'codebuddy-code': 'codebuddy',
  'factory-droid': 'droid', 'github-copilot-cli': 'copilot',
  kilo: 'kilo', kimi: 'kimi', 'minimax-code': 'mcode', 'qwen-code': 'qwen'
});
const CLIENTS = new Set([...Object.values(DRIVER_CLIENTS), ...Object.values(REGISTRY_CLIENTS)]);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function supportsT3SessionClient(client) { return CLIENTS.has(client); }

function nativeAccountingId(client, value, historical = false) {
  // Opaque ids are case sensitive. Only UUID-based Codex/Claude identities
  // have an established case-insensitive contract; do not rewrite ACP names.
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > 512 || /[\s\x00-\x1f]/u.test(id)) return '';
  if (historical && ['codex', 'claude'].includes(client) && !UUID.test(id)) return '';
  return ['codex', 'claude'].includes(client) && UUID.test(id) ? id.toLowerCase() : id;
}

function readT3IdentityBindings(dbPath) {
  const bindings = new Map();
  // ServerConfig derives settings.json beside statev2.sqlite. Never use a
  // different environment's catalog, nor infer an agent from an instance name.
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(path.dirname(dbPath), 'settings.json'), 'utf8'));
    for (const [id, instance] of Object.entries(settings.providerInstances || {})) {
      const config = instance?.config;
      if (instance?.driver !== 'acpRegistry' || !config || Array.isArray(config)
        || (config.source !== undefined && config.source !== 'registry')
        || config.commandPath || config.commandArgs?.length) continue;
      const client = Object.hasOwn(REGISTRY_CLIENTS, config.agentId) ? REGISTRY_CLIENTS[config.agentId] : null;
      if (client) bindings.set(id, client);
    }
  } catch (_) { /* absent/unreadable configuration cannot identify an ACP agent */ }
  return bindings;
}

function t3AccountingClient(driver, instanceId, bindings) {
  return driver === 'acpRegistry' ? bindings.get(instanceId)
    : (Object.hasOwn(DRIVER_CLIENTS, driver) ? DRIVER_CLIENTS[driver] : null);
}

module.exports = { supportsT3SessionClient, nativeAccountingId, readT3IdentityBindings, t3AccountingClient };
