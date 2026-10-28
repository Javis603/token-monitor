'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('semver');
const { ID_RE, MAX_PACKAGE_BYTES, contentDigest, readBounded, parsePackage, packageDirectory, unpackPackage, describePackage } = require('./package');
const { removePluginPlacements, initialPlacements, initializePlacementPatch } = require('./placementSettings');
const SETTING_KEYS = ['pluginStates', 'pluginPlacementDefaults', 'trayContent', 'homeModuleOrder', 'hiddenHomeModules', 'edgeDockItems', 'trayCustomLayout', 'floatingBubbleCustomLayout', 'notchCustomLayout', 'notchPageOrder', 'notchPluginPages', 'pluginMainPages', 'pluginContentSelections', 'pluginContentOrder'];
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
function boundedJson(value, limit) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > limit) throw new Error(`plugin metadata exceeds ${limit} bytes`);
  return json;
}
function atomicJson(file, value, limit = Infinity) {
  const json = boundedJson(value, limit);
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, json); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
// One transaction at a time. A prepared journal always rolls back;
// only a persisted committed journal permits removal of the recovery copies.
function createManagedPlugins({ root, userDir, dataDir, settingsDir = null, manager, getSettings, saveSettings, getLocale = () => 'en', placementContext = () => ({}), now = Date.now, fault = () => {} }) {
  const registryFile = path.join(root, 'installed.json');
  const journalFile = path.join(root, 'transaction.json');
  const txDir = path.join(root, 'transaction');
  const historyDir = path.join(root, 'previous');
  let registry = Object.create(null), busy = false, available = false;
  const unavailableMessage = 'Plugin management unavailable: installed metadata or transaction recovery could not be read safely. Package changes are blocked; existing files are preserved.';
  function assertAvailable() {
    if (!available) throw Object.assign(new Error(unavailableMessage), { code: 'management-unavailable' });
  }
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function validateRegistry(data) {
    if (!isRecord(data) || Object.entries(data).some(([id, item]) => !ID_RE.test(id) || !isRecord(item)
      || !semver.valid(item.version) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
      || (typeof item.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.contentSha256))
      || !isRecord(item.origin) || typeof item.origin.id !== 'string' || !item.origin.id
      || !Number.isFinite(item.installedAt))) throw new Error('invalid installed plugin registry');
    return Object.assign(Object.create(null), data);
  }
  const previews = new Map();
  function readRegistry() {
    if (!fs.existsSync(registryFile)) return Object.create(null);
    const data = JSON.parse(readBounded(registryFile, MAX_REGISTRY_BYTES));
    return validateRegistry(data);
  }
  function settingsSnapshot() {
    const settings = getSettings();
    return Object.fromEntries(SETTING_KEYS.filter(key => settings[key] !== undefined).map(key => [key, structuredClone(settings[key])]));
  }
  function cleanup() {
    // Remove the journal last: a committed transaction can repeat cleanup.
    fs.rmSync(txDir, { recursive: true, force: true });
    fs.rmSync(journalFile, { force: true });
  }
  function recover() {
    available = false;
    previews.clear();
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
      recoverTransaction();
      available = true;
    } catch (error) {
      registry = Object.create(null);
      throw error;
    }
  }
  function recoverTransaction() {
    if (!fs.existsSync(journalFile)) { registry = readRegistry(); return; }
    const j = JSON.parse(readBounded(journalFile, MAX_JOURNAL_BYTES));
    if (!isRecord(j) || typeof j.id !== 'string' || !ID_RE.test(j.id) || !['prepared', 'committed'].includes(j.phase)
      || !['install', 'update', 'rollback', 'uninstall'].includes(j.operation)
      || typeof j.hadTarget !== 'boolean' || typeof j.hadPrevious !== 'boolean'
      || !isRecord(j.settings) || Object.keys(j.settings).some(key => !SETTING_KEYS.includes(key))) throw new Error('invalid plugin recovery journal');
    validateRegistry(j.registry);
    // Validate all metadata before recovery can delete or replace any files.
    // A prepared journal owns the rollback baseline; a committed one uses disk.
    if (j.phase === 'committed') readRegistry();
    if (j.phase === 'prepared') {
      const target = path.join(userDir, j.id), old = path.join(txDir, 'old'), stage = path.join(txDir, 'stage');
      if (fs.existsSync(old)) {
        fs.rmSync(target, { recursive: true, force: true }); fs.renameSync(old, target);
      } else if (!j.hadTarget && !fs.existsSync(stage) && j.operation !== 'uninstall') fs.rmSync(target, { recursive: true, force: true });
      const directoryBackup = path.join(txDir, 'plugin-data');
      if (fs.existsSync(directoryBackup)) { fs.mkdirSync(dataDir, { recursive: true }); fs.renameSync(directoryBackup, path.join(dataDir, j.id)); }
      const settingsBackup = path.join(txDir, 'author-settings.json');
      if (settingsDir && fs.existsSync(settingsBackup)) { fs.mkdirSync(settingsDir, { recursive: true }); fs.renameSync(settingsBackup, path.join(settingsDir, `${j.id}.json`)); }
      const previous = path.join(historyDir, `${j.id}.tmplugin`), previousBackup = path.join(txDir, 'previous.tmplugin');
      if (j.hadPrevious) fs.copyFileSync(previousBackup, previous);
      else fs.rmSync(previous, { force: true });
      atomicJson(registryFile, j.registry, MAX_REGISTRY_BYTES);
      saveSettings(j.settings);
      atomicJson(journalFile, { ...j, phase: 'committed' }, MAX_JOURNAL_BYTES);
    }
    cleanup(); registry = readRegistry();
  }
  function hasTarget(target) {
    let stat;
    try { stat = fs.lstatSync(target); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    // lstat distinguishes genuine absence from a dangling symlink. Neither
    // links nor other replacement file types may become transaction targets.
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('managed plugin directory is missing or replaced');
    return true;
  }
  function managed(id) {
    assertAvailable();
    if (typeof id !== 'string' || !ID_RE.test(id) || !registry[id]) throw new Error('plugin is not a managed installation');
    hasTarget(path.join(userDir, id));
    return registry[id];
  }
  function describe(id) {
    const item = registry[id];
    if (!item) return null;
    // Registry metadata is a management DTO, never a manifest or capability.
    const origin = { id: item.origin.id, kind: ['local', 'official', 'community'].includes(item.origin.kind) ? item.origin.kind : 'local' };
    for (const key of ['label', 'url', 'packageUrl']) if (typeof item.origin[key] === 'string') origin[key] = item.origin[key].slice(0, 2048);
    return { version: item.version, sha256: item.sha256, installedAt: item.installedAt, origin,
      previousVersion: semver.valid(item.previousVersion) || null,
      previousSha256: typeof item.previousSha256 === 'string' && /^[a-f0-9]{64}$/.test(item.previousSha256) ? item.previousSha256 : null };
  }
  function list() {
    if (!available) return [];
    return Object.keys(registry).map(id => {
      let missing = false;
      try { missing = !hasTarget(path.join(userDir, id)); } catch { /* Replaced/unreadable is invalid, never missing. */ }
      return { id, missing, installation: describe(id) };
    });
  }
  function currentPackage(id) {
    try {
      const pkg = packageDirectory(path.join(userDir, id), { checkCompatibility: false });
      if (pkg.manifest.id !== id || pkg.manifest.version !== registry[id].version
        || !registry[id].contentSha256 || contentDigest(pkg) !== registry[id].contentSha256) {
        throw new Error('installed package content is changed or has no trusted fingerprint');
      }
      return pkg;
    } catch (cause) {
      throw Object.assign(new Error('installed-package-invalid: installed package needs rollback or uninstall and reinstall', { cause }), { code: 'installed-package-invalid' });
    }
  }
  function assertInstallable(pkg, origin) {
    assertAvailable();
    const id = pkg.manifest.id, installed = manager.list().plugins.find(p => p.id === id);
    if (!registry[id] && (installed || fs.existsSync(path.join(userDir, id)))) throw new Error('a development plugin already uses this id; remove or rename that folder first');
    if (registry[id]) {
      managed(id);
      if (registry[id].origin.id !== origin.id) throw new Error('update source differs from the installed source; uninstall first to switch sources');
      if (!semver.gt(pkg.manifest.version, registry[id].version)) throw new Error('update must have a newer version; use Roll back for the saved previous version');
    }
    if (!registry[id] && manager.list().plugins.length >= 64) throw new Error('plugin limit reached');
  }
  function preview(pkg, origin = { id: 'local', kind: 'local', label: 'Local package' }) {
    assertInstallable(pkg, origin);
    if (registry[pkg.manifest.id] && hasTarget(path.join(userDir, pkg.manifest.id))) currentPackage(pkg.manifest.id);
    const token = crypto.randomUUID();
    for (const [key, item] of previews) if (item.expires < now()) previews.delete(key);
    if (previews.size >= 8) previews.delete(previews.keys().next().value);
    previews.set(token, { pkg, origin: structuredClone(origin), expires: now() + 10 * 60 * 1000, baseline: JSON.stringify(registry[pkg.manifest.id] || null) });
    return { ...describePackage(pkg, { locale: getLocale() }), token,
      placementsRetained: Object.hasOwn(getSettings().pluginPlacementDefaults || {}, pkg.manifest.id),
      operation: registry[pkg.manifest.id] ? 'update' : 'install', installedVersion: registry[pkg.manifest.id]?.version || null, origin };
  }
  async function transact(id, operation, pkg, origin, options = {}) {
    assertAvailable();
    if (busy) throw new Error('another plugin operation is in progress');
    if (fs.existsSync(journalFile)) throw new Error('plugin recovery is pending; restart the application before changing plugins');
    busy = true;
    let prepared = false, began = false, committed = false, recovered = true;
    try {
      await manager.beginMutation(id); began = true;
      const target = path.join(userDir, id), stage = path.join(txDir, 'stage');
      const hadTarget = hasTarget(target);
      let current = null;
      // A missing directory has no current package to retain. Errors within an
      // existing package still follow the normal update/rollback policy.
      if (hadTarget && (operation === 'update' || operation === 'rollback')) {
        try {
          current = currentPackage(id);
        } catch (error) {
          if (operation !== 'rollback') throw error;
          // Rescue may discard an unreadable current version. The saved target
          // was independently checked; never advertise corrupt code as a backup.
          current = null;
        }
      }
      fs.rmSync(txDir, { recursive: true, force: true }); fs.mkdirSync(txDir, { mode: 0o700 });
      if (pkg) unpackPackage(pkg, stage);
      const previous = path.join(historyDir, `${id}.tmplugin`), hadPrevious = fs.existsSync(previous);
      if (hadPrevious) fs.copyFileSync(previous, path.join(txDir, 'previous.tmplugin'));
      const next = Object.assign(Object.create(null), registry);
      if (operation === 'uninstall') delete next[id];
      else next[id] = { version: pkg.manifest.version, sha256: pkg.hash, contentSha256: contentDigest(pkg), origin, installedAt: now(), previousVersion: current?.manifest.version || null, previousSha256: current?.hash || null };
      boundedJson(next, MAX_REGISTRY_BYTES);
      const before = settingsSnapshot();
      const j = { id, operation, phase: 'prepared', hadTarget, hadPrevious, registry, settings: before };
      boundedJson({ ...j, phase: 'committed' }, MAX_JOURNAL_BYTES);
      atomicJson(journalFile, j, MAX_JOURNAL_BYTES); prepared = true; fault('prepared');
      if (j.hadTarget) fs.renameSync(target, path.join(txDir, 'old'));
      fault('old-moved');
      if (pkg) fs.renameSync(stage, target);
      fault('new-moved');
      const patch = settingsSnapshot();
      patch.pluginStates = { ...(patch.pluginStates || {}) };
      if (operation === 'uninstall') {
        delete patch.pluginStates[id];
        if (!options.keepPlacements) {
          Object.assign(patch, removePluginPlacements(getSettings(), id));
          patch.pluginPlacementDefaults = { ...patch.pluginPlacementDefaults }; delete patch.pluginPlacementDefaults[id];
        }
        if (!options.keepData && fs.existsSync(path.join(dataDir, id))) fs.renameSync(path.join(dataDir, id), path.join(txDir, 'plugin-data'));
        if (!options.keepData && settingsDir && fs.existsSync(path.join(settingsDir, `${id}.json`))) fs.renameSync(path.join(settingsDir, `${id}.json`), path.join(txDir, 'author-settings.json'));
        fs.rmSync(previous, { force: true });
      } else {
        if (current) fs.writeFileSync(previous, current.bytes, { mode: 0o600 });
        else fs.rmSync(previous, { force: true });
        if (operation === 'install') {
          const enabled = options.trustInstall === true && manager.list().enabled === true;
          patch.pluginStates[id] = { enabled, background: false, trustedRevision: enabled ? contentDigest(pkg) : null };
          if (!Object.hasOwn(patch.pluginPlacementDefaults || {}, id)) patch.pluginPlacementDefaults = { ...patch.pluginPlacementDefaults, [id]: { applied: false, placements: initialPlacements(pkg.manifest, options.placements) } };
          if (enabled) Object.assign(patch, initializePlacementPatch({ ...getSettings(), ...patch }, id, placementContext(), pkg.manifest.views));
        }
        // Consent applies only to the exact package held by this preview token.
        if (operation === 'update' && options.trustUpdate) {
          patch.pluginStates[id] = { ...patch.pluginStates[id], trustedRevision: contentDigest(pkg) };
        }
      }
      atomicJson(registryFile, next, MAX_REGISTRY_BYTES); fault('registry-written');
      saveSettings(patch); fault('settings-written');
      await manager.reload(id); fault('reloaded');
      atomicJson(journalFile, { ...j, phase: 'committed' }, MAX_JOURNAL_BYTES); committed = true; registry = next;
      cleanup();
      return describe(id);
    } catch (error) {
      if (prepared && !committed) {
        try { recover(); await manager.reload(id); } catch (recoveryError) { recovered = false; throw new Error(`${error.message}; recovery pending: ${recoveryError.message}`, { cause: recoveryError }); }
      }
      throw error;
    } finally {
      if (began && recovered) manager.endMutation(id);
      busy = false;
    }
  }
  return {
    recover, describe, list, assertAvailable,
    status: () => ({ available, error: available ? null : { code: 'management-unavailable', message: unavailableMessage } }),
    preview,
    previewFile(file) { assertAvailable(); return preview(parsePackage(readBounded(file, MAX_PACKAGE_BYTES))); },
    previewDirectory(dir) { assertAvailable(); return preview(packageDirectory(dir)); },
    previewId: token => previews.get(token)?.pkg.manifest.id,
    cancel(token) { previews.delete(token); },
    cancelSource(id) { for (const [token, preview] of previews) if (preview.origin.id === id) previews.delete(token); },
    async install(token, options = {}) {
      assertAvailable();
      const item = previews.get(token); previews.delete(token);
      if (!item || item.expires < now()) throw new Error('package preview expired; select the package again');
      if (item.baseline !== JSON.stringify(registry[item.pkg.manifest.id] || null)) throw new Error('installed version changed; preview again');
      assertInstallable(item.pkg, item.origin);
      return transact(item.pkg.manifest.id, registry[item.pkg.manifest.id] ? 'update' : 'install', item.pkg, item.origin, { trustUpdate: options.trustUpdate === true, trustInstall: options.trustInstall === true, placements: options.placements });
    },
    async rollback(id) {
      const old = managed(id);
      if (!old.previousVersion) throw new Error('no previous version is available');
      const pkg = parsePackage(readBounded(path.join(historyDir, `${id}.tmplugin`), MAX_PACKAGE_BYTES));
      if (pkg.manifest.id !== id || pkg.manifest.version !== old.previousVersion || pkg.hash !== old.previousSha256) throw new Error('previous package identity mismatch');
      return transact(id, 'rollback', pkg, old.origin);
    },
    uninstall(id, options = {}) { managed(id); return transact(id, 'uninstall', null, null, { keepData: options.keepData !== false, keepPlacements: options.keepPlacements === true }); },
    dispose() { previews.clear(); }
  };
}
module.exports = { createManagedPlugins, atomicJson, MAX_REGISTRY_BYTES, MAX_JOURNAL_BYTES };
