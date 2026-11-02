'use strict';
const { ID_RE } = require('../../shared/plugins/manifest');
const { isRef } = require('../../shared/plugins/placements');
const { PLACEMENT_SURFACES, placementPatch } = require('./placementSettings');
const { prepareSkinSettings } = require('./skinSettings');
const MAX_CHOICES = 1024;
const placementKey = (ref, surface) => `placement:${ref}:${surface}`;
const contentKey = target => `content:${target}`;
const contentSelection = (selections, target) => Object.hasOwn(selections || {}, target) ? selections[target] || null : null;
const refFor = (id, view) => view.ref || `${id}/${view.id}`;
const ownRecord = (settings, id) => Object.hasOwn(settings.pluginInitialSetup || {}, id)
  ? settings.pluginInitialSetup[id] : { values: {}, applied: [] };

function validValue(key, value) {
  if (key === 'background') return typeof value === 'boolean';
  if (key === 'skin' || /^content:[a-zA-Z][a-zA-Z0-9.-]{0,119}$/.test(key)) return value === null || isRef(value);
  const match = /^placement:([^:]+):([^:]+)$/.exec(key);
  return Boolean(match && isRef(match[1]) && PLACEMENT_SURFACES.includes(match[2]) && typeof value === 'boolean');
}

function normalizeInitialSetup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = [];
  for (const [id, entry] of Object.entries(value)) {
    if (!ID_RE.test(id) || !entry || !entry.values || typeof entry.values !== 'object' || Array.isArray(entry.values) || !Array.isArray(entry.applied)) continue;
    const values = Object.fromEntries(Object.entries(entry.values).filter(([key, choice]) => validValue(key, choice)).slice(0, MAX_CHOICES));
    result.push([id, { values, applied: [...new Set(entry.applied.filter(key => Object.hasOwn(values, key)))].slice(0, MAX_CHOICES) }]);
  }
  return Object.fromEntries(result);
}

function recordSetupChoice(settings, id, key, value) {
  const previous = ownRecord(settings, id);
  const values = { ...previous.values, [key]: value };
  if (Object.keys(values).length > MAX_CHOICES) throw new Error('Too many initial settings');
  return { ...settings.pluginInitialSetup, [id]: { values, applied: [...new Set([...previous.applied, key])] } };
}

function setupFields(settings, plugin, { updating = false } = {}) {
  const record = ownRecord(settings, plugin.id), applied = new Set(record.applied);
  const fields = [];
  const configured = new Set(Object.values(settings.pluginInitialSetup || {}).flatMap(entry => entry.applied));
  const views = plugin.views || [], defaults = plugin.defaults || { content: {}, background: false, skin: null };
  for (const view of views) {
    const ref = refFor(plugin.id, view);
    for (const surface of view.surfaces.filter(surface => PLACEMENT_SURFACES.includes(surface))) {
      fields.push({ key: placementKey(ref, surface), kind: 'placement', ref, surface, title: view.title, value: view.defaultSurfaces.includes(surface) });
    }
  }
  const targets = new Set(views.filter(view => view.mode === 'replace').flatMap(view => view.targets));
  for (const target of targets) {
    const options = views.filter(view => view.mode === 'replace' && view.targets.includes(target))
      .map(view => ({ value: refFor(plugin.id, view), label: view.title }));
    const current = contentSelection(settings.pluginContentSelections, target);
    if (current && !options.some(option => option.value === current)) options.push({ value: current, label: current, current: true });
    const preferred = defaults.content[target];
    const preserve = configured.has(contentKey(target)) && current === null || (updating || Object.hasOwn(settings.pluginInitialSetup || {}, plugin.id)) && current;
    const value = preserve ? current : preferred === null ? null : preferred ? `${plugin.id}/${preferred}` : options[0]?.value || null;
    fields.push({ key: contentKey(target), kind: 'content', target, options, value });
  }
  const background = plugin.background === true && Boolean(plugin.backend) || plugin.background?.supported === true;
  if (background) fields.push({ key: 'background', kind: 'background', value: defaults.background });
  if (plugin.skins?.length) fields.push({ key: 'skin', kind: 'skin', options: plugin.skins.map(skin => ({ value: skin.ref || `${plugin.id}/${skin.id}`, label: skin.name })),
    value: defaults.skin ? `${plugin.id}/${defaults.skin}` : null });
  return fields.filter(field => !applied.has(field.key)).map(field => {
    const saved = record.values[field.key];
    if (Object.hasOwn(record.values, field.key)) field.value = field.options
      ? saved === null || field.options.some(option => option.value === saved) ? saved : null : saved;
    return field;
  });
}

function initialSetupReview(settings, plugin, options = {}) {
  const fields = setupFields(settings, plugin, options);
  return { fields, values: Object.fromEntries(fields.map(field => [field.key, field.value])) };
}

function contentSelectionGuard(settings, plan, activate = true) {
  const before = settings.pluginContentSelections, after = plan.patch.pluginContentSelections;
  const targets = new Set(activate ? Object.keys(plan.values).filter(key => key.startsWith('content:')).map(key => key.slice(8)) : []);
  if (after) for (const target of new Set([...Object.keys(before || {}), ...Object.keys(after)])) {
    if (contentSelection(before, target) !== contentSelection(after, target)) targets.add(target);
  }
  const baseline = [...targets].map(target => [target, contentSelection(before, target)]);
  return current => {
    if (baseline.some(([target, value]) => contentSelection(current.pluginContentSelections, target) !== value)) throw new Error('Content selection changed; try again');
  };
}

function initialSetupPlan(settings, plugin, input, { activate = true, context = {}, updating = false } = {}) {
  const review = initialSetupReview(settings, plugin, { updating }), allowed = new Map(review.fields.map(field => [field.key, field]));
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length > MAX_CHOICES || Object.entries(input).some(([key, value]) => {
      const field = allowed.get(key);
      return !field || !validValue(key, value) || field.options && value !== null && !field.options.some(option => option.value === value);
    }))) throw new Error('Invalid initial plugin settings');
  const choices = { ...review.values, ...input };
  const previous = ownRecord(settings, plugin.id);
  const record = { values: { ...previous.values, ...choices }, applied: [...previous.applied] };
  const patch = {};
  const targets = new Set((plugin.views || []).filter(view => view.mode === 'replace').flatMap(view => view.targets));
  const retained = Object.entries(settings.pluginContentSelections || {}).filter(([target, ref]) => !ref.startsWith(`${plugin.id}/`) || targets.has(target));
  if (updating && retained.length !== Object.keys(settings.pluginContentSelections || {}).length) patch.pluginContentSelections = Object.fromEntries(retained);
  if (activate) for (const field of review.fields) {
    const value = choices[field.key], current = { ...settings, ...patch };
    if (field.kind === 'placement' && value) {
      try { Object.assign(patch, placementPatch(current, { ref: field.ref, surface: field.surface, placed: true }, context)); }
      catch (error) { if (!['page-full', 'edgeDock-full', 'tray-full', 'Notch page storage limit exceeded'].includes(error.message)) throw error; }
    } else if (field.kind === 'content') {
      const selections = { ...current.pluginContentSelections };
      if (value === null) delete selections[field.target]; else selections[field.target] = value;
      if (Object.keys(selections).length > 128) throw new Error('Too many content selections');
      patch.pluginContentSelections = selections;
    } else if (field.kind === 'background') {
      patch.pluginStates = { ...current.pluginStates, [plugin.id]: { ...current.pluginStates?.[plugin.id], background: value } };
    } else if (field.kind === 'skin' && value !== null) {
      const skin = plugin.skins.find(skin => (skin.ref || `${plugin.id}/${skin.id}`) === value);
      const prepared = prepareSkinSettings(current, { ...skin, ref: value });
      Object.assign(patch, prepared.patch, { pluginAuthorSkin: prepared.authorSkin });
    }
    record.applied.push(field.key);
  }
  if (Object.keys(record.values).length > MAX_CHOICES) throw new Error('Too many initial settings');
  if (review.fields.length) patch.pluginInitialSetup = { ...settings.pluginInitialSetup, [plugin.id]: record };
  // Preserve the user's chosen plugin when an update removes only its view.
  for (const target of targets) {
    const selected = contentSelection(patch.pluginContentSelections || settings.pluginContentSelections, target);
    const options = plugin.views.filter(view => view.mode === 'replace' && view.targets.includes(target)).map(view => refFor(plugin.id, view));
    if (activate && selected?.startsWith(`${plugin.id}/`) && !options.includes(selected)) {
      patch.pluginContentSelections = { ...(patch.pluginContentSelections || settings.pluginContentSelections), [target]: options[0] };
    }
  }
  return { patch, values: choices };
}

module.exports = { normalizeInitialSetup, recordSetupChoice, placementKey, contentKey, contentSelectionGuard, initialSetupReview, initialSetupPlan };
