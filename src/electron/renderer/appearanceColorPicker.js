// @ts-check
'use strict';

(function expose(root, factory) {
  const browser = /** @type {(Window & {TokenMonitorSelectControl: typeof import('./selectControl'), TokenMonitorAppearanceColorPicker?: unknown}) | null} */ (root);
  const positionApi = browser ? browser.TokenMonitorSelectControl : require('./selectControl');
  const api = factory(positionApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (browser) browser.TokenMonitorAppearanceColorPicker = api;
})(typeof window !== 'undefined' ? window : null, /** @param {typeof import('./selectControl')} positionApi */ function createAppearanceColorPickerApi(positionApi) {
  /** @param {number} value */
  const clamp = value => Math.max(0, Math.min(1, value));

  /** @param {string} text */
  function parseHex(text) {
    const value = text.trim().replace(/^#/, '');
    return /^[0-9a-f]{6}$/i.test(value) ? `#${value.toLowerCase()}` : null;
  }

  /** @param {string} hex */
  function hexToRgb(hex) {
    return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  }

  /** @param {string} hex */
  function hexToHsv(hex) {
    const [red, green, blue] = hexToRgb(hex).map(channel => channel / 255);
    const value = Math.max(red, green, blue);
    const delta = value - Math.min(red, green, blue);
    let sector = 0;
    if (delta) {
      if (value === red) sector = (green - blue) / delta;
      else if (value === green) sector = (blue - red) / delta + 2;
      else sector = (red - green) / delta + 4;
    }
    return { hue: (sector * 60 + 360) % 360, saturation: value ? delta / value : 0, value };
  }

  /** @param {{hue: number, saturation: number, value: number}} hsv */
  function hsvToHex({ hue, saturation, value }) {
    const chroma = value * saturation;
    const secondary = chroma * (1 - Math.abs(hue / 60 % 2 - 1));
    const offset = value - chroma;
    const colors = [[chroma, secondary, 0], [secondary, chroma, 0], [0, chroma, secondary],
      [0, secondary, chroma], [secondary, 0, chroma], [chroma, 0, secondary]];
    const rgb = colors[Math.floor(hue / 60)];
    return `#${rgb.map(channel => Math.round((channel + offset) * 255).toString(16).padStart(2, '0')).join('')}`;
  }

  /**
   * @typedef {{button: HTMLButtonElement, name: string, preview: (value: string) => void,
   *   save: (value: string) => Promise<void>}} Target
   */

  /** @param {{document: Document, window: Window, t: (key: string) => string}} options */
  function create({ document, window, t }) {
    const popover = document.createElement('div');
    popover.id = 'appearanceColorPicker';
    popover.className = 'appearance-color-picker';
    popover.setAttribute('popover', 'manual');
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-labelledby', 'appearanceColorPickerTitle');
    popover.innerHTML = [
      '<div class="appearance-color-picker-heading"><strong id="appearanceColorPickerTitle"></strong><span aria-hidden="true"></span></div>',
      '<div class="appearance-color-plane" tabindex="0" role="group"><span aria-hidden="true"></span></div>',
      '<input class="appearance-color-hue" type="range" min="0" max="359" step="1">',
      '<div class="appearance-color-values"><label>HEX<input type="text" maxlength="7" spellcheck="false" autocomplete="off" aria-describedby="appearanceColorError"></label>',
      '<label>RGB<input type="text" readonly></label></div>',
      '<p id="appearanceColorError" role="status" hidden></p>'
    ].join('');
    const title = /** @type {HTMLElement} */ (popover.querySelector('strong'));
    const plane = /** @type {HTMLElement} */ (popover.querySelector('.appearance-color-plane'));
    const hue = /** @type {HTMLInputElement} */ (popover.querySelector('[type=range]'));
    const hex = /** @type {HTMLInputElement} */ (popover.querySelector('[maxlength]'));
    const rgb = /** @type {HTMLInputElement} */ (popover.querySelector('[readonly]'));
    const error = /** @type {HTMLElement} */ (popover.querySelector('p'));
    document.body.append(popover);

    /** @type {Target | null} */
    let target = null;
    let hsv = hexToHsv('#000000');
    let draft = '#000000';
    let committed = draft;
    let pointer = -1;
    let pending = Promise.resolve();
    /** @type {WeakMap<HTMLButtonElement, {value: string}>} */
    const queued = new WeakMap();

    /** @param {HTMLButtonElement} button */
    function swatchValue(button) {
      return queued.get(button)?.value || button.dataset.color || '#000000';
    }

    /** @param {HTMLButtonElement} button @param {string} value */
    function setSwatch(button, value) {
      const long = value.length === 4 ? '#' + [...value.slice(1)].map(digit => digit + digit).join('') : value;
      button.dataset.color = parseHex(long) || '#000000';
      if (target?.button !== button) button.style.setProperty('--swatch-color', swatchValue(button));
    }

    /** @param {boolean} [updateHex] */
    function paint(updateHex = true) {
      popover.style.setProperty('--picker-hue', String(hsv.hue));
      popover.style.setProperty('--picker-x', `${hsv.saturation * 100}%`);
      popover.style.setProperty('--picker-y', `${(1 - hsv.value) * 100}%`);
      popover.style.setProperty('--swatch-color', draft);
      target?.button.style.setProperty('--swatch-color', draft);
      hue.value = String(Math.floor(hsv.hue));
      if (updateHex) hex.value = draft.toUpperCase();
      rgb.value = hexToRgb(draft).join(', ');
      error.hidden = true;
      hex.removeAttribute('aria-invalid');
    }

    /** @param {() => Promise<void>} write */
    function enqueue(write) {
      const result = pending.then(write);
      pending = result.catch(() => {});
      return result;
    }

    function commit() {
      const current = target;
      if (!current || draft === committed) return;
      const write = { value: draft };
      committed = draft;
      queued.set(current.button, write);
      void enqueue(async () => {
        try {
          await current.save(write.value);
        } catch (_) {
          // saveSettings restores the persisted form before rejecting.
          if (target?.button === current.button && draft === write.value && queued.get(current.button) === write) {
            committed = draft = current.button.dataset.color || '#000000';
            hsv = hexToHsv(draft);
            paint();
          }
        } finally {
          if (queued.get(current.button) === write) queued.delete(current.button);
          if (target?.button !== current.button) current.button.style.setProperty('--swatch-color', swatchValue(current.button));
        }
      });
    }

    function position() {
      if (!target || !popover.matches(':popover-open')) return;
      const bounds = target.button.getBoundingClientRect();
      const panel = target.button.closest('.settings-panel')?.getBoundingClientRect();
      if (!bounds.width || !bounds.height || target.button.closest('[hidden], [inert], .hidden')
        || (panel && (bounds.bottom <= panel.top || bounds.top >= panel.bottom))) {
        popover.hidePopover();
        return;
      }
      const width = Math.min(292, window.innerWidth - 16);
      popover.style.width = `${width}px`;
      popover.style.maxHeight = '';
      const result = positionApi.popupPosition(bounds, { width: window.innerWidth, height: window.innerHeight }, {
        width, height: popover.offsetHeight, align: 'end', heightLimit: window.innerHeight
      });
      Object.assign(popover.style, { left: `${result.left}px`, top: `${result.top}px`, maxHeight: `${result.maxHeight}px` });
    }

    function close() {
      if (popover.matches(':popover-open')) popover.hidePopover();
    }

    /** @param {Target} next @param {boolean} [keyboard] */
    function open(next, keyboard = false) {
      if (target?.button === next.button) { close(); return; }
      close();
      target = next;
      committed = draft = swatchValue(next.button);
      hsv = hexToHsv(draft);
      title.textContent = next.name;
      plane.setAttribute('aria-label', t('settings.appearance.colorPlane'));
      hue.setAttribute('aria-label', t('settings.appearance.colorHue'));
      error.textContent = t('settings.appearance.invalidHex');
      paint();
      next.button.setAttribute('aria-expanded', 'true');
      popover.showPopover({ source: next.button });
      position();
      (keyboard ? plane : next.button).focus({ preventScroll: true });
    }

    popover.addEventListener('beforetoggle', event => {
      if (event.newState !== 'closed' || !target) return;
      commit();
      target.button.setAttribute('aria-expanded', 'false');
      target.button.style.setProperty('--swatch-color', swatchValue(target.button));
      target = null;
      pointer = -1;
    });

    function preview() {
      draft = hsvToHex(hsv);
      paint();
      target?.preview(draft);
    }

    /** @param {PointerEvent} event */
    function move(event) {
      const bounds = plane.getBoundingClientRect();
      hsv.saturation = clamp((event.clientX - bounds.left) / bounds.width);
      hsv.value = 1 - clamp((event.clientY - bounds.top) / bounds.height);
      preview();
    }

    plane.addEventListener('pointerdown', event => {
      if (event.button !== 0 || pointer !== -1) return;
      pointer = event.pointerId;
      plane.setPointerCapture(pointer);
      move(event);
    });
    plane.addEventListener('pointermove', event => {
      if (event.pointerId === pointer) move(event);
    });
    plane.addEventListener('lostpointercapture', event => {
      if (event.pointerId !== pointer) return;
      pointer = -1;
      commit();
    });
    plane.addEventListener('keydown', event => {
      /** @type {Partial<Record<string, [number, number]>>} */
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      const delta = moves[event.key];
      if (!delta) return;
      event.preventDefault();
      const step = event.shiftKey ? 0.1 : 0.025;
      hsv.saturation = clamp(hsv.saturation + delta[0] * step);
      hsv.value = clamp(hsv.value + delta[1] * step);
      preview();
    });
    plane.addEventListener('keyup', event => {
      if (event.key.startsWith('Arrow')) commit();
    });
    hue.addEventListener('input', () => {
      hsv.hue = Number(hue.value);
      preview();
    });
    hue.addEventListener('change', commit);
    hex.addEventListener('input', () => {
      const value = parseHex(hex.value);
      if (!value) {
        error.hidden = false;
        hex.setAttribute('aria-invalid', 'true');
        position();
        return;
      }
      draft = value;
      hsv = hexToHsv(draft);
      paint(false);
      commit();
      position();
    });
    // Keep the active swatch outside light-dismiss so its click can toggle.
    document.addEventListener('pointerdown', event => {
      const node = /** @type {Node | null} */ (event.target);
      if (target && !target.button.contains(node) && !popover.contains(node)) close();
    }, true);
    document.addEventListener('keydown', event => {
      if (!target || event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      const trigger = target?.button;
      close();
      trigger?.focus({ preventScroll: true });
    }, true);
    window.addEventListener('scroll', event => { if (event.target !== popover) position(); }, true);
    window.addEventListener('resize', position);
    return { open, close, setSwatch, enqueue };
  }

  return { create, parseHex, hexToHsv, hsvToHex };
});
