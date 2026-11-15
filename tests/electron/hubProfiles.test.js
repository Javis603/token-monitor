'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initializeHubProfiles, hubProfilesForRenderer, prepareHubProfilePatch } = require('../../src/electron/hubProfiles');
const { CredentialStore, credentialSettingsForRenderer, persistSettingsAndCredentials } = require('../../src/shared/credentialStore');

function legacy() {
  const settings = { hubMode: 'client', hubUrl: 'https://worker.example', secret: 'worker-secret', deviceId: 'laptop' };
  return { ...settings, ...initializeHubProfiles(settings) };
}

function addHome(settings) {
  return { ...settings, ...prepareHubProfilePatch(settings, { hubProfileAction: { type: 'add', name: 'Home' },
    hubUrl: 'http://home.tail.example:17321', secret: 'home-secret', deviceId: 'home-laptop' }) };
}

test('an existing Hub survives adding, switching and renaming another Hub', () => {
  let settings = legacy();
  const originalId = settings.activeHubProfileId;
  settings = addHome(settings);
  const homeId = settings.activeHubProfileId;
  assert.equal(settings.hubProfiles.length, 2);
  settings = { ...settings, ...prepareHubProfilePatch(settings, { hubProfileAction: { type: 'select', id: originalId } }) };
  assert.equal(settings.hubUrl, 'https://worker.example');
  assert.equal(settings.secret, 'worker-secret');
  assert.equal(settings.deviceId, 'laptop');
  settings = { ...settings, ...prepareHubProfilePatch(settings, { hubProfileAction: { type: 'select', id: homeId } }) };
  settings = { ...settings, ...prepareHubProfilePatch(settings, { hubProfileAction: { type: 'save', name: 'Tailscale' }, secret: 'updated-home' }) };
  assert.equal(settings.hubProfiles.length, 2);
  assert.equal(settings.hubProfiles[1].name, 'Tailscale');
  assert.equal(settings.hubProfiles[0].secret, 'worker-secret');
  assert.equal(settings.secret, 'updated-home');
  assert.equal(settings.deviceId, 'home-laptop');
});

test('profiles survive restart in the credential store and expose only safe metadata', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-hub-profiles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, 'settings.json');
  const store = new CredentialStore(dir);
  const settings = addHome(legacy());
  settings.hubProfiles[1].hubUrl = 'https://user:private@home.example/path?token=hidden#fragment';
  persistSettingsAndCredentials({ store, settingsPath, settings, previousSettings: {} });
  const preferences = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(preferences.hubProfiles, undefined);
  assert.equal(preferences.secret, undefined);
  const reloaded = { ...preferences, ...store.settingsCredentials() };
  Object.assign(reloaded, initializeHubProfiles(reloaded));
  assert.deepEqual(reloaded.hubProfiles, settings.hubProfiles);
  assert.equal(reloaded.activeHubProfileId, settings.activeHubProfileId);
  assert.equal(credentialSettingsForRenderer(reloaded).hubProfiles, '');
  const visible = hubProfilesForRenderer(reloaded);
  assert.deepEqual(Object.keys(visible[1]), ['id', 'name', 'endpoint']);
  assert.equal(visible[1].endpoint, 'home.example');
  assert.doesNotMatch(JSON.stringify(visible), /private|hidden|fragment|home-secret/);
});

test('failed profile persistence rolls back both the profiles and the active credential', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-hub-rollback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CredentialStore(dir);
  const settingsPath = path.join(dir, 'settings.json');
  const previous = legacy();
  persistSettingsAndCredentials({ store, settingsPath, settings: previous, previousSettings: {} });
  assert.throws(() => persistSettingsAndCredentials({ store, settingsPath, settings: addHome(previous),
    previousSettings: previous, writeSettings: () => { throw new Error('disk full'); } }), /disk full/);
  assert.deepEqual(store.settingsCredentials().hubProfiles, previous.hubProfiles);
  assert.equal(store.settingsCredentials().secret, previous.secret);
  assert.equal(JSON.parse(fs.readFileSync(settingsPath)).activeHubProfileId, previous.activeHubProfileId);
});

test('removal selects the remaining Hub and removing the last disconnects without reseeding', () => {
  let settings = addHome(legacy());
  settings = { ...settings, ...prepareHubProfilePatch(settings, { hubProfileAction: { type: 'delete', id: settings.activeHubProfileId } }) };
  assert.equal(settings.hubUrl, 'https://worker.example');
  assert.equal(settings.secret, 'worker-secret');
  settings = { ...settings, ...prepareHubProfilePatch(settings, { hubProfileAction: { type: 'delete', id: settings.activeHubProfileId } }) };
  assert.equal(settings.hubUrl, '');
  assert.equal(settings.secret, '');
  assert.deepEqual(initializeHubProfiles(settings), { hubProfiles: [], activeHubProfileId: '' });
});

test('invalid actions cannot replace the profile list or mutate the current credentials', () => {
  const settings = legacy();
  const before = JSON.stringify(settings);
  assert.throws(() => prepareHubProfilePatch(settings, { hubProfileAction: { type: 'select', id: 'missing' } }), /hub_profile_not_found/);
  assert.throws(() => prepareHubProfilePatch(settings, { hubProfileAction: { type: 'add' }, hubUrl: 'file:///tmp/private' }), /invalid_hub_url/);
  assert.equal(JSON.stringify(settings), before);
  assert.deepEqual(prepareHubProfilePatch(settings, { hubProfiles: [], activeHubProfileId: 'forged', language: 'en' }), { language: 'en' });
});

test('a patch that does not touch the Hub connection passes through unchanged', () => {
  const settings = legacy();
  const skinOnly = { pluginSkin: { pluginId: 'fixture', skinId: 'dark' } };
  assert.deepEqual(prepareHubProfilePatch(settings, skinOnly), skinOnly);
});

test('a stale active id is repaired from the live connection', () => {
  const settings = addHome(legacy());
  const homeId = settings.activeHubProfileId;
  assert.equal(initializeHubProfiles({ ...settings, activeHubProfileId: 'missing' }).activeHubProfileId, homeId);
  const moved = initializeHubProfiles({ ...settings, activeHubProfileId: '', hubUrl: 'https://other.example' });
  assert.equal(moved.hubProfiles.length, 3);
  assert.equal(moved.hubProfiles.find(profile => profile.id === moved.activeHubProfileId).hubUrl, 'https://other.example');
});

test('switching Hubs drops the previous Hub\'s device cleanup, editing in place keeps it', () => {
  const settings = { ...addHome(legacy()), lastPostedDeviceId: 'home-laptop' };
  const worker = settings.hubProfiles.find(profile => profile.hubUrl === 'https://worker.example');
  assert.equal(prepareHubProfilePatch(settings, { hubProfileAction: { type: 'select', id: worker.id } }).lastPostedDeviceId, '');
  assert.equal(Object.hasOwn(prepareHubProfilePatch(settings, { deviceId: 'renamed-laptop' }), 'lastPostedDeviceId'), false);
  assert.equal(Object.hasOwn(prepareHubProfilePatch(settings,
    { hubUrl: 'http://home.tail.example:17321/', deviceId: 'renamed-laptop' }), 'lastPostedDeviceId'), false);
});

test('returning to client mode reconnects as the active Hub after another mode changed the Device ID', () => {
  const home = addHome(legacy());
  const hosted = { ...home, hubMode: 'host', deviceId: 'host-laptop', lastPostedDeviceId: 'host-laptop' };
  const patch = prepareHubProfilePatch(hosted, { hubMode: 'client' });
  assert.equal(patch.hubUrl, 'http://home.tail.example:17321');
  assert.equal(patch.secret, 'home-secret');
  assert.equal(patch.deviceId, 'home-laptop');
  assert.equal(patch.activeHubProfileId, home.activeHubProfileId);
  assert.equal(patch.lastPostedDeviceId, '');
  assert.equal(prepareHubProfilePatch({ ...home, lastPostedDeviceId: 'home-laptop' }, { hubMode: 'host' }).lastPostedDeviceId, '');
});

test('equivalent Hub URLs keep the Device ID cleanup', () => {
  const settings = { ...addHome(legacy()), lastPostedDeviceId: 'home-laptop' };
  const patch = prepareHubProfilePatch(settings, { hubUrl: 'HTTP://HOME.TAIL.EXAMPLE:17321/', deviceId: 'renamed-laptop' });
  assert.equal(Object.hasOwn(patch, 'lastPostedDeviceId'), false);
  const https = { ...legacy(), lastPostedDeviceId: 'laptop' };
  assert.equal(Object.hasOwn(prepareHubProfilePatch(https, { hubUrl: 'https://WORKER.example:443/', deviceId: 'x' }), 'lastPostedDeviceId'), false);
});
