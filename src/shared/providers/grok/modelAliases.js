'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_MODEL_ID_LENGTH = 256;
const MAX_ALIASES = 4096;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function decodeQuotedKey(value, quote) {
  if (quote === '"') {
    try {
      return JSON.parse(`"${value}"`);
    } catch (_) {
      return '';
    }
  }
  return value.replace(/''/g, "'");
}

function parseTomlString(value) {
  const raw = text(value);
  if (!raw) return '';
  const quote = raw[0];
  if (quote !== '"' && quote !== "'") {
    return '';
  }
  for (let index = 1; index < raw.length; index += 1) {
    if (raw[index] !== quote || (quote === '"' && raw[index - 1] === '\\')) continue;
    const content = raw.slice(0, index + 1);
    if (quote === '"') {
      try {
        return JSON.parse(content);
      } catch (_) {
        return '';
      }
    }
    return content.slice(1, -1).replace(/''/g, "'");
  }
  return '';
}

function validModelId(value) {
  const model = text(value);
  return model && model.length <= MAX_MODEL_ID_LENGTH ? model : '';
}

// Grok's model routes are declared in tables such as
// `[model."grok-4.5"]` with a `model = "provider/routed-model"` entry.
// This intentionally parses only that small shape; malformed or unrelated TOML
// must never create evidence for dropping usage rows.
function parseGrokModelAliases(contents) {
  const aliases = {};
  let currentAlias = '';
  for (const rawLine of String(contents || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) currentAlias = '';
    const section = line.match(/^\[\s*models?\s*\.\s*(?:(['"])(.*?)\1|([A-Za-z0-9_-]+))\s*\]\s*$/i);
    if (section) {
      currentAlias = validModelId(section[2] !== undefined
        ? decodeQuotedKey(section[2], section[1])
        : section[3]);
      continue;
    }
    if (!currentAlias) continue;
    const assignment = line.match(/^model\s*=\s*(.+?)\s*$/i);
    if (!assignment) continue;
    const routed = validModelId(parseTomlString(assignment[1]));
    if (!routed || routed.toLowerCase() === currentAlias.toLowerCase()) continue;
    aliases[currentAlias] = routed;
    if (Object.keys(aliases).length >= MAX_ALIASES) break;
  }
  return aliases;
}

function resolveGrokHome(options = {}) {
  const env = options.env || process.env;
  const configured = options.grokHome ?? env.GROK_HOME;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  return path.join(os.homedir(), '.grok');
}

function grokConfigPath(options = {}) {
  if (typeof options.configPath === 'string' && options.configPath.trim()) return options.configPath.trim();
  return path.join(resolveGrokHome(options), 'config.toml');
}

function readGrokModelAliases(options = {}, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  try {
    return parseGrokModelAliases(readFileSync(grokConfigPath(options), 'utf8'));
  } catch (_) {
    return {};
  }
}

module.exports = {
  grokConfigPath,
  parseGrokModelAliases,
  readGrokModelAliases,
  resolveGrokHome
};
