'use strict';

const { randomUUID } = require('node:crypto');

function endpoint(url) {
  try { return new URL(url).host; } catch (_) { return ''; }
}

function initializeHubProfiles(settings) {
  const hubProfiles = Array.isArray(settings.hubProfiles) ? settings.hubProfiles.filter(profile =>
    profile && typeof profile.id === 'string' && typeof profile.name === 'string'
    && typeof profile.hubUrl === 'string' && typeof profile.secret === 'string'
    && typeof profile.deviceId === 'string') : [];
  let activeHubProfileId = hubProfiles.some(profile => profile.id === settings.activeHubProfileId)
    ? settings.activeHubProfileId : '';
  // Preserve the existing connection on upgrade, including env-configured Hubs.
  if (!hubProfiles.length && String(settings.hubUrl || '').trim()) {
    const id = randomUUID();
    hubProfiles.push({ id, name: endpoint(settings.hubUrl), hubUrl: settings.hubUrl,
      secret: settings.secret || '', deviceId: settings.deviceId });
    activeHubProfileId = id;
  }
  return { hubProfiles, activeHubProfileId };
}

function hubProfilesForRenderer(settings) {
  return (settings.hubProfiles || []).map(({ id, name, hubUrl }) => ({ id, name, endpoint: endpoint(hubUrl) }));
}

// Resolve commands in main so inactive credentials never cross renderer IPC.
// The resulting connection fields use the normal settings/consent transition.
function prepareHubProfilePatch(settings, input) {
  const patch = { ...input };
  delete patch.hubProfiles;
  delete patch.activeHubProfileId;
  delete patch.hubProfileAction;
  const action = input.hubProfileAction;
  const profiles = (settings.hubProfiles || []).map(profile => ({ ...profile }));
  let activeId = settings.activeHubProfileId || '';
  let touched = false;
  if (action && !['save', 'add', 'select', 'delete'].includes(action.type)) throw new Error('invalid_hub_profile_action');
  if (action?.type === 'select' || action?.type === 'delete') {
    const index = profiles.findIndex(profile => profile.id === action.id);
    if (index < 0) throw new Error('hub_profile_not_found');
    let selected = profiles[index];
    touched = true;
    if (action.type === 'delete') {
      profiles.splice(index, 1);
      if (selected.id !== activeId) selected = null;
      else selected = profiles[0] || { id: '', hubUrl: '', secret: '', deviceId: settings.deviceId };
    }
    if (selected) {
      activeId = selected.id;
      Object.assign(patch, { hubMode: 'client', hubUrl: selected.hubUrl, secret: selected.secret, deviceId: selected.deviceId });
    }
  } else if (action || ((patch.hubMode ?? settings.hubMode) === 'client'
    && ['hubUrl', 'secret', 'deviceId'].some(key => Object.hasOwn(patch, key)))) {
    const hubUrl = String(patch.hubUrl ?? settings.hubUrl ?? '').trim();
    if (action || hubUrl) {
      touched = true;
      let parsed;
      try { parsed = new URL(hubUrl); } catch (cause) { throw new Error('invalid_hub_url', { cause }); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid_hub_url');
      const existing = action?.type === 'add' ? null : profiles.find(profile => profile.id === activeId);
      const profile = { id: existing?.id || randomUUID(),
        name: String(action?.name ?? existing?.name ?? parsed.host).trim().slice(0, 120) || parsed.host,
        hubUrl, secret: String(patch.secret ?? settings.secret ?? ''),
        deviceId: String(patch.deviceId ?? settings.deviceId).trim() || settings.deviceId };
      if (existing) profiles[profiles.indexOf(existing)] = profile;
      else profiles.push(profile);
      activeId = profile.id;
      Object.assign(patch, { hubUrl, secret: profile.secret, deviceId: profile.deviceId });
    }
  }
  // Untouched patches stay as sent: some settings commands (plugin skins) must
  // arrive as standalone patches.
  return touched ? { ...patch, hubProfiles: profiles, activeHubProfileId: activeId } : patch;
}

module.exports = { initializeHubProfiles, hubProfilesForRenderer, prepareHubProfilePatch };
