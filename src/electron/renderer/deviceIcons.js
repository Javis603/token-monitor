'use strict';

(function exposeDeviceIcons(root, factory) {
  const kinds = typeof module === 'object' && module.exports ? require('../../shared/deviceKind') : root.TokenMonitorDeviceKind;
  const control = typeof module === 'object' && module.exports ? require('./selectControl') : root.TokenMonitorSelectControl;
  const api = factory(kinds, control);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorDeviceIcons = api;
})(typeof window !== 'undefined' ? window : null, function createDeviceIconsApi({ DEVICE_KINDS, normalizeDeviceKind }, selectControl) {
  const controls = new WeakMap();
  const choices = ['desktop', 'laptop', 'mini', 'workstation', 'linux', 'server', 'cloud'];
  const icons = Object.fromEntries(DEVICE_KINDS.map(kind => [kind, document => deviceIconNode(document, kind)]));
  function normalizeDeviceIconOverrides(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    return Object.fromEntries(Object.entries(input).slice(0, 128).map(([scope, values]) => [scope,
      Object.fromEntries(Object.entries(values && typeof values === 'object' && !Array.isArray(values) ? values : {})
        .filter(([id, kind]) => id.length <= 256 && DEVICE_KINDS.includes(kind)).slice(0, 256))
    ]));
  }
  function deviceIconOverride(settings, deviceId) {
    const scopes = settings?.deviceIconOverrides;
    const scope = settings?.deviceIconScope || 'local';
    const values = scopes && Object.hasOwn(scopes, scope) ? scopes[scope] : null;
    return values && Object.hasOwn(values, deviceId) ? values[deviceId] : 'auto';
  }
  function deviceIconKind(settings, device) {
    const override = deviceIconOverride(settings, device?.deviceId);
    const kind = normalizeDeviceKind(override === 'auto' ? device?.deviceKind : override);
    return kind === 'computer' ? 'desktop' : kind;
  }
  function deviceIconPatch(settings, deviceId, kind, detectedKind) {
    const scope = settings.deviceIconScope || 'local';
    let values = { ...settings.deviceIconOverrides?.[scope] };
    const detected = normalizeDeviceKind(detectedKind);
    if (kind === 'auto' || kind === (detected === 'computer' ? 'desktop' : detected)) delete values[deviceId];
    else values = { ...values, [deviceId]: normalizeDeviceKind(kind) };
    return { deviceIconOverrides: { ...settings.deviceIconOverrides, [scope]: values } };
  }
  function deviceIconNode(document, kind) {
    const node = document.createElement('span');
    node.className = `device-kind-icon device-kind-${normalizeDeviceKind(kind)}`;
    node.setAttribute('aria-hidden', 'true');
    return node;
  }
  function populateDeviceIconSelect(select, translate, detectedKind) {
    select.dataset.detectedKind = normalizeDeviceKind(detectedKind);
    select.replaceChildren(...choices.map(kind => {
      const option = select.ownerDocument.createElement('option');
      option.value = kind;
      option.textContent = translate(`devices.kind.${kind}`);
      return option;
    }));
    let control = controls.get(select);
    if (!control) {
      control = selectControl?.enhance(select, {
        minPopupWidth: 180,
        align: 'end',
        getOptionMeta: option => ({
          icon: icons[option.value],
          annotation: select.dataset.detectedKind === 'computer'
            ? option.value === 'desktop' ? translate('devices.icon.default') : ''
            : option.value === select.dataset.detectedKind ? translate('devices.icon.detected') : ''
        })
      });
      if (control) controls.set(select, control);
    }
    control?.sync();
  }
  function syncDeviceIconSelect(select) { controls.get(select)?.sync(); }
  function destroyDeviceIconSelect(select) {
    controls.get(select)?.destroy();
    controls.delete(select);
  }
  return { normalizeDeviceIconOverrides, deviceIconOverride, deviceIconKind, deviceIconPatch, deviceIconNode,
    populateDeviceIconSelect, syncDeviceIconSelect, destroyDeviceIconSelect };
});
