'use strict';

function isAllowedCodexLoginUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'auth.openai.com') return false;
  return parsed.pathname === '/oauth/authorize' || parsed.pathname.startsWith('/oauth/authorize/') || parsed.pathname.startsWith('/device');
}

function codexLoginUrlFromOutput(output) {
  const candidates = String(output || '').match(/https:\/\/[^\s<>"']+/gi) || [];
  for (const candidate of candidates) {
    const trimmed = candidate.replace(/[),.;\]]+$/g, '');
    if (!isAllowedCodexLoginUrl(trimmed)) continue;
    try {
      return new URL(trimmed).toString();
    } catch (_) {}
  }
  return '';
}

module.exports = {
  codexLoginUrlFromOutput,
  isAllowedCodexLoginUrl
};
