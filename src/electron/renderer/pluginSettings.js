'use strict';

// Settings → Plugins. Lists discovered plugins, asks for consent before the
// each executable revision, places each view on
// the surfaces it supports, and shows a code plugin's process state. All
// writes go through the main-process plugin API; nothing here edits settings
// through the trusted host; this is not a same-renderer security boundary.
(function exposePluginSettings(root, factory) {
  const positionApi = typeof module === 'object' && module.exports ? require('./selectControl') : root?.TokenMonitorSelectControl;
  const api = factory(positionApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginSettings = api;
})(typeof window !== 'undefined' ? window : null, function createPluginSettingsApi(positionApi) {
  const SURFACE_ORDER = ['home', 'page', 'tray', 'edgeDock', 'notch'];

  function el(document, tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
  }



  function actionErrorMessage(error, t) {
    const message = String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    const known = /installed-package-invalid/.test(String(error?.code || '') + ' ' + message)
      ? 'plugins.package.repairRequired'
      : { 'page-full': 'settings.plugins.pageFull', 'tray-full': 'settings.plugins.trayFull', 'edgeDock-full': 'settings.plugins.edgeDockFull' }[message];
    return known ? t(known) : t('settings.plugins.actionFailed', { error: message });
  }

  function createPluginSettingsPanel({ mountSettings = null, unmountSettings = () => {}, document, container, t, api, setDetailTooltip = null, onApplySkin = () => {}, onPlaced = () => {}, onSetEnabled = null, getEnabled = null, getLocale = () => document.documentElement?.lang || 'en', onOpenExternal = () => {}, onCopyText = text => window.navigator.clipboard.writeText(text) }) {
    let list = null;
    let consentFor = '';
    let busy = false;
    let revealConsent = false;
    let packagePreview = null;
    let operation = null;
    let catalogData = null, activeTab = 'installed', query = '', sourcesOpen = false;
    let selectedPluginId = '', diagnostics = false, installedPosition = null;
    let catalogModal = null;
    let catalogReview = null, menuId = 0, aboutOpen = false;
    let actionError = null;
    const sourceDraft = { url: '', publicKey: '' };
    const chosenVersions = new Map();
    const detailState = new Map();
    const authorSettings = new Map();
    const settingsIdentities = new Map(), settingsMounts = new Map();
    function reconcileSettings() {
      const installed = new Map((list?.plugins || []).map(plugin => [plugin.id, JSON.stringify([plugin.settingsIdentity, plugin.version, plugin.source])]));
      for (const [id, identity] of settingsIdentities) {
        if (installed.get(id) !== identity) {
          authorSettings.delete(id);
        }
      }
      for (const [ref, held] of settingsMounts) {
        const plugin = list?.plugins?.find(item => item.id === held.pluginId);
        if (plugin?.status !== 'active' || !plugin.views?.some(view => view.ref === ref && view.revision === held.revision)) {
          unmountSettings(held.node); held.node.remove(); settingsMounts.delete(ref);
        }
      }
      settingsIdentities.clear();
      for (const [id, identity] of installed) settingsIdentities.set(id, identity);
    }
    let overview = null, navigation = null, tabs = null, content = null, renderedTab = 'installed';
    const overviewLabels = new Map(), guideLinks = new Map();
    const tabControls = new Map();
    const busyControls = new Set();

    // Keep navigation alive. Async actions must not insert a loading row or
    // discard the focused control before the response arrives.
    function setBusy() {
      container.setAttribute('aria-busy', String(busy));
      if (!busy) {
        for (const control of busyControls) control.disabled = false;
        busyControls.clear();
      }
      for (const control of container.querySelectorAll('button, input, select, textarea')) {
        control.setAttribute('aria-disabled', String(busy || control.disabled));
        if (busy && !control.disabled && control !== document.activeElement && !tabs?.contains(control)) {
          busyControls.add(control);
          control.disabled = true;
        }
      }
    }

    function rememberPosition() {
      const focus = document.activeElement;
      const scroll = [];
      for (let node = container.parentElement; node; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight) scroll.push([node, node.scrollTop]);
      }
      return { focus, key: focus?.dataset?.pluginFocus, scroll };
    }

    function restorePosition(saved) {
      // Don't steal focus if the user moved elsewhere during the request.
      if (document.activeElement === saved.focus || document.activeElement === document.body) {
        const target = saved.focus?.isConnected ? saved.focus : [...container.querySelectorAll('[data-plugin-focus]')].find(node => node.dataset.pluginFocus === saved.key);
        if (target && !target.disabled) target.focus({ preventScroll: true });
      }
      for (const [node, top] of saved.scroll) node.scrollTop = top;
    }

    function identifyContent() {
      const counts = new Map();
      for (const node of container.querySelectorAll('button, input, select, textarea, summary')) {
        const owner = node.closest('[data-plugin-id], [data-catalog-id]');
        const scope = owner?.dataset.pluginId || owner?.dataset.catalogId || activeTab;
        const identity = node.dataset.controlKey ? JSON.stringify([scope, node.dataset.controlKey]) : JSON.stringify([scope, node.tagName, node.type, node.dataset.styleKey, node.dataset.styleColor, node.getAttribute('aria-label'), node.dataset.controlKey || node.title, node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' ? node.className : node.textContent]);
        const count = counts.get(identity) || 0;
        counts.set(identity, count + 1); node.dataset.pluginFocus = `${identity}/${count}`;
      }
    }

    // Guard the still-focused action and persistent tabs while a write is in
    // flight. Other controls are disabled; Tab navigation remains available.
    container.addEventListener('click', event => {
      if (busy) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);

    function errorScope() {
      return JSON.stringify([activeTab, selectedPluginId, diagnostics, sourcesOpen, catalogReview?.origin?.id, catalogReview?.id, aboutOpen, packagePreview?.token, operation?.id, operation?.kind]);
    }

    function errorNotice() {
      if (!actionError || actionError.scope !== errorScope()) return null;
      const notice = el(document, 'p', 'plugin-action-error', actionErrorMessage(actionError.error, t));
      notice.id = `${container.id || 'plugin-settings'}-action-error`;
      notice.setAttribute('role', 'alert'); notice.setAttribute('aria-atomic', 'true');
      return notice;
    }

    async function run(action, target = '') {
      if (busy) return;
      actionError = null;
      container.querySelector('.plugin-action-error')?.remove();
      busy = true;
      setBusy();
      try {
        const next = await action();
        if (next) { list = next; if (catalogData) catalogData = await api.catalog(); }
      } catch (error) {
        actionError = { error, target: target || (selectedPluginId ? `plugin:${selectedPluginId}` : ''), scope: errorScope() };
      } finally {
        busy = false;
        if (revealConsent && consentFor) { selectedPluginId = consentFor; diagnostics = false; }
        render();
        if (actionError) container.querySelector('.plugin-action-error')?.scrollIntoView({ block: 'nearest' });
        if (revealConsent) {
          container.querySelector(`[data-plugin-id="${consentFor}"] .plugin-consent`)?.scrollIntoView({ block: 'nearest' });
          revealConsent = false;
        }
      }
    }

    function button(label, action, className = '') {
      const node = el(document, 'button', className, label);
      node.type = 'button'; node.disabled = busy; node.addEventListener('click', action); return node;
    }

    function identity(name, author, origin, iconName, image, official = false) {
      const group = el(document, 'div', 'plugin-identity');
      const art = el(document, 'span', 'plugin-identity-art'); art.setAttribute('aria-hidden', 'true');
      if (typeof image === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image) && image.length <= 90000) {
        const img = el(document, 'img'); img.alt = ''; img.src = image;
        img.addEventListener('error', () => { img.remove(); art.append(window.TokenMonitorPluginViews.iconNode(document, iconName || 'dot', null, 20)); }, { once: true });
        art.append(img);
      } else art.append(window.TokenMonitorPluginViews.iconNode(document, iconName || 'dot', null, 20));
      const title = el(document, 'div', 'plugin-card-title');
      const source = el(document, 'span', official ? 'plugin-source plugin-source-official' : 'plugin-source');
      if (author && !official) source.append(el(document, 'span', 'plugin-author', author));
      if (origin || official) {
        const label = el(document, 'span', `plugin-origin-label${official ? ' plugin-origin-official' : ''}`);
        if (official) {
          const shield = el(document, 'span', 'plugin-shield'); shield.setAttribute('aria-hidden', 'true');
          label.append(shield);
        }
        label.append(document.createTextNode(official ? `Token Monitor ${t('plugins.origin.official')}` : origin));
        source.append(label);
      }
      title.append(el(document, 'span', 'plugin-name', name), source);
      group.append(art, title); return group;
    }

    function actionMenu(label, entries, leadingControl = null) {
      const wrap = el(document, 'div', 'plugin-menu-wrap');
      const popover = el(document, 'div', 'plugin-menu'); popover.id = `plugin-menu-${++menuId}`; popover.setAttribute('popover', 'auto');
      const trigger = button('', () => {}, 'plugin-more'); trigger.setAttribute('aria-label', label);
      const icon = el(document, 'span', 'plugin-more-icon'); icon.setAttribute('aria-hidden', 'true'); trigger.append(icon);
      trigger.setAttribute('popovertarget', popover.id); trigger.setAttribute('aria-controls', popover.id); trigger.setAttribute('aria-expanded', 'false');
      let keyboardOpen = false, focusLast = false;
      const menuItems = () => [...popover.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
      trigger.addEventListener('click', event => { keyboardOpen = event.detail === 0; focusLast = false; });
      trigger.addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault(); keyboardOpen = true; focusLast = event.key === 'ArrowUp';
        if (popover.matches(':popover-open')) (focusLast ? menuItems().at(-1) : menuItems()[0])?.focus({ preventScroll: true });
        else popover.showPopover();
      });
      popover.addEventListener('toggle', () => {
        trigger.setAttribute('aria-expanded', String(popover.matches(':popover-open')));
        if (popover.matches(':popover-open')) {
          const rect = trigger.getBoundingClientRect();
          const position = positionApi.popupPosition(rect, { width: window.innerWidth, height: window.innerHeight }, {
            width: popover.offsetWidth, height: popover.scrollHeight + 2, align: 'end', heightLimit: window.innerHeight
          });
          Object.assign(popover.style, { left: `${position.left}px`, top: `${position.top}px`, width: `${position.width}px`, maxHeight: `${position.maxHeight}px` });
          if (keyboardOpen) (focusLast ? menuItems().at(-1) : menuItems()[0])?.focus({ preventScroll: true });
        }
      });
      popover.addEventListener('keydown', (event) => {
        const direction = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' }[event.key];
        if (direction === undefined) return;
        event.preventDefault();
        const items = menuItems();
        const next = positionApi.navigate(items, items.indexOf(document.activeElement), direction);
        items[next]?.focus();
      });
      if (leadingControl) popover.append(leadingControl);
      for (const [text, action] of entries) popover.append(button(text, () => { popover.hidePopover(); trigger.focus({ preventScroll: true }); action(); }));
      wrap.append(trigger, popover); return wrap;
    }

    // Runtime enabled also includes safe mode. The switch edits the saved
    // preference, independently of whether activation is currently allowed.
    function masterPreference() { return getEnabled ? getEnabled() : list.enabled; }

    function globalSwitch() {
      const row = el(document, 'label', 'checkbox-label plugin-global-switch');
      row.append(el(document, 'span', '', t('settings.plugins.enableAll')));
      const toggle = el(document, 'input'); toggle.type = 'checkbox'; toggle.setAttribute('role', 'switch');
      toggle.dataset.controlKey = 'plugins-enabled'; toggle.checked = masterPreference();
      toggle.disabled = busy || !onSetEnabled;
      toggle.addEventListener('change', () => {
        if (busy) { toggle.checked = masterPreference(); return; }
        const enabled = toggle.checked;
        const menu = toggle.closest('.plugin-menu');
        menu.hidePopover(); menu.parentElement.querySelector('.plugin-more').focus({ preventScroll: true });
        void run(async () => {
          try { return await onSetEnabled(enabled); }
          catch (error) { list = await api.list(); throw error; }
        });
      });
      row.append(toggle); return row;
    }

    async function previewCatalog(entry, version) {
      if (packagePreview) { const token = packagePreview.token; packagePreview = null; await api.cancelInstall(token); }
      packagePreview = await api.catalogPreview(entry.origin.id, entry.id, version);
    }

    function catalogReviewPanel() {
      const entry = catalogReview;
      const wrap = el(document, 'section', 'plugin-detail plugin-catalog-review');
      wrap.append(button(t('plugins.ui.backCatalog'), () => {
        if (packagePreview) void api.cancelInstall(packagePreview.token);
        packagePreview = null; catalogReview = null; render(); tabControls.get(activeTab)?.focus({ preventScroll: true });
      }, 'plugin-back'));
      const key = `${entry.origin.id}/${entry.id}`;
      const version = chosenVersions.get(key) || entry.version;
      if (entry.versions?.length) {
        const row = el(document, 'label', 'plugin-version-picker', t('plugins.catalog.version'));
        const select = el(document, 'select'); select.dataset.controlKey = 'review-version';
        for (const v of entry.versions) {
          const option = el(document, 'option', '', `${v.version}${v.compatible ? '' : ` · ${t('plugins.catalog.incompatible')}`}`);
          option.value = v.version; option.disabled = !v.installable; option.selected = v.version === version; select.append(option);
        }
        select.addEventListener('change', () => {
          chosenVersions.set(key, select.value);
          void run(async () => {
            // A focused native select can change again while the request is
            // pending. Drain to its latest choice before enabling installation.
            let requested;
            do {
              requested = chosenVersions.get(key);
              await previewCatalog(entry, requested);
            } while (requested !== chosenVersions.get(key));
            return null;
          });
        });
        row.append(select); wrap.append(row);
        const selected = entry.versions.find(v => v.version === version);
        if (selected?.changelog) wrap.append(el(document, 'p', 'plugin-description', selected.changelog));
      }
      if (packagePreview) wrap.append(packagePanel());
      else wrap.append(button(t('plugins.ui.previewPackage'), () => void run(async () => { await previewCatalog(entry, version); return null; })));
      return wrap;
    }

    function typeLabels(plugin) {
      const labels = el(document, 'span', 'plugin-types');
      for (const type of ['widget', 'page', 'appearance']) {
        if (!plugin.types?.includes(type)) continue;
        labels.append(el(document, 'span', `plugin-type plugin-type-${type}`, t(`plugins.type.${type}`)));
      }
      return labels;
    }

    function importPackage(kind) {
      void run(async () => {
        const preview = await api.importPackage(kind);
        if (preview) { packagePreview = preview; catalogReview = null; sourcesOpen = false; activeTab = 'installed'; selectedPluginId = ''; aboutOpen = false; }
        return null;
      });
    }

    function packagePanel() {
      const p = packagePreview;
      const panel = el(document, 'section', 'plugin-consent plugin-package-preview');
      panel.dataset.errorTarget = 'package';
      panel.setAttribute('aria-label', t('plugins.package.review'));
      panel.append(identity(p.name, p.author || p.id, t(`plugins.origin.${p.origin.kind}`), p.icon, p.identityIcon, p.origin.kind === 'official'));
      const meta = el(document, 'div', 'plugin-card-meta');
      meta.append(el(document, 'span', 'plugin-version', `${p.installedVersion ? `${p.installedVersion} → ` : ''}${p.version}`), typeLabels(p)); panel.append(meta);
      panel.append(el(document, 'p', 'plugin-description', p.description));
      if (p.origin.kind !== 'local') panel.append(el(document, 'p', 'plugin-description', p.origin.label));
      if (p.origin.url) panel.append(el(document, 'code', 'plugin-log', p.origin.url));
      if (p.origin.packageUrl) panel.append(el(document, 'code', 'plugin-log', p.origin.packageUrl));
      panel.append(el(document, 'p', 'plugin-risk', t('plugins.trusted.warning')));
      panel.append(el(document, 'p', 'settings-note', t(p.operation === 'install' ? (list.enabled ? 'plugins.package.installConsent' : 'plugins.package.enableLater') : 'plugins.package.grants')));
      if (p.operation === 'install' && !p.placementsRetained && p.views?.some(view => view.surfaces.some(surface => SURFACE_ORDER.includes(surface)))) {
        p.placements ??= p.views.flatMap(view => (view.defaultSurfaces || []).map(surface => ({ ref: view.ref, surface })));
        const locations = el(document, 'fieldset', 'plugin-default-placements');
        locations.append(el(document, 'legend', '', t('plugins.package.initialLocations')));
        locations.append(el(document, 'p', 'settings-note', t('plugins.package.initialLocationsNote')));
        for (const view of p.views) for (const surface of SURFACE_ORDER.filter(surface => view.surfaces.includes(surface))) {
          const label = el(document, 'label', 'plugin-placement-choice');
          const input = el(document, 'input'); input.type = 'checkbox'; input.dataset.ref = view.ref; input.dataset.surface = surface;
          input.checked = p.placements.some(choice => choice.ref === view.ref && choice.surface === surface);
          input.addEventListener('change', () => {
            p.placements = p.placements.filter(choice => !(choice.ref === view.ref && choice.surface === surface));
            if (input.checked) p.placements.push({ ref: view.ref, surface });
          });
          label.append(input, el(document, 'span', '', `${view.title} · ${t(`settings.plugins.surface.${surface}`)}`)); locations.append(label);
        }
        panel.append(locations);
      }
      const details = el(document, 'details', 'plugin-logs'); details.append(el(document, 'summary', '', t('plugins.package.integrity')));
      details.append(el(document, 'code', 'plugin-log', p.sha256)); panel.append(details);
      const actions = el(document, 'div', 'settings-actions plugin-consent-actions');
      const install = trustInstall => void run(async () => {
        const next = await api.install(p.token, { trustUpdate: p.operation === 'update', trustInstall, placements: p.placements });
        packagePreview = null; catalogReview = null; activeTab = 'installed';
        if (p.operation === 'update' && next.plugins.find(plugin => plugin.id === p.id)?.status === 'needsApproval') { consentFor = p.id; revealConsent = true; }
        return next;
      }, 'package');
      actions.append(button(t('settings.plugins.cancel'), () => { void api.cancelInstall(p.token); packagePreview = null; catalogReview = null; render(); }));
      if (p.operation === 'install' && list.enabled) actions.append(button(t('plugins.package.installOnly'), () => install(false)));
      actions.append(button(t(p.operation === 'update' ? 'plugins.package.trustUpdate' : list.enabled ? 'plugins.package.trustInstall' : 'plugins.package.installOnly'),
        () => install(p.operation === 'install' && list.enabled), 'plugin-allow'));
      panel.append(actions); return panel;
    }

    function operationPanel(plugin) {
      const panel = el(document, 'div', 'plugin-consent');
      panel.dataset.errorTarget = 'operation';
      const isRemove = operation.kind === 'uninstall';
      panel.append(el(document, 'strong', 'plugin-consent-title', t(isRemove ? 'plugins.package.removeTitle' : 'plugins.package.rollbackTitle', { name: plugin.name, version: plugin.installation.previousVersion })));
      if (isRemove) {
        for (const [key, label] of [['keepData', 'plugins.package.keepData'], ['keepPlacements', 'plugins.package.keepPlacements']]) {
          const row = el(document, 'label', 'checkbox-label');
          const input = el(document, 'input'); input.type = 'checkbox'; input.checked = operation[key];
          input.addEventListener('change', () => { operation[key] = input.checked; });
          row.append(input, el(document, 'span', '', t(label))); panel.append(row);
        }
        panel.append(el(document, 'p', 'settings-note', t('plugins.package.themeKept')));
      } else panel.append(el(document, 'p', 'settings-note', t('plugins.package.rollbackNote')));
      const actions = el(document, 'div', 'settings-actions plugin-consent-actions');
      actions.append(button(t('settings.plugins.cancel'), () => { operation = null; render(); }),
        button(t(isRemove ? 'plugins.package.uninstall' : 'plugins.package.rollback'), () => void run(async () => {
          const next = isRemove ? await api.uninstall(plugin.id, operation) : await api.rollback(plugin.id);
          operation = null; return next;
        }, 'operation')));
      panel.append(actions); return panel;
    }

    function authoringPanel() {
      const panel = el(document, 'section', 'plugin-about');
      panel.append(button(t('plugins.ui.back'), () => {
        aboutOpen = false; render(); container.querySelector('.plugin-toolbar .plugin-more')?.focus({ preventScroll: true });
      }, 'plugin-back'), el(document, 'h3', '', t('plugins.ui.about')),
      el(document, 'p', 'settings-note', t('plugins.authoring.intro')));
      const prompt = el(document, 'textarea', 'plugin-author-prompt');
      prompt.value = t('plugins.authoring.prompt'); prompt.readOnly = true; prompt.rows = 12; prompt.spellcheck = false;
      prompt.setAttribute('aria-label', t('plugins.authoring.label'));
      const status = el(document, 'p', 'settings-note plugin-copy-status'); status.setAttribute('role', 'status');
      const actions = el(document, 'div', 'settings-actions');
      const copy = button(t('plugins.authoring.copy'), async () => {
        copy.disabled = true; copy.setAttribute('aria-busy', 'true'); status.textContent = '';
        try { await onCopyText(prompt.value); status.textContent = t('plugins.authoring.copied'); }
        catch (_) { prompt.focus({ preventScroll: true }); prompt.select(); status.textContent = t('plugins.authoring.copyFallback'); }
        finally { copy.disabled = busy; copy.removeAttribute('aria-busy'); }
      }, 'plugin-copy-prompt');
      const guide = el(document, 'a', 'plugin-guide-link', t('plugins.authoring.guide'));
      guide.href = `https://javis-ai.com/token-monitor/docs/plugin-quickstart.html?lang=${encodeURIComponent(getLocale())}`;
      guide.rel = 'noopener noreferrer';
      guide.addEventListener('click', event => { event.preventDefault(); void run(async () => { await onOpenExternal(guide.href); return null; }); });
      actions.append(copy, guide); panel.append(actions, prompt, status); return panel;
    }

    function catalogDialog(entry) {
      catalogModal?.close();
      const previousFocus = document.activeElement;
      const dialog = el(document, 'dialog', 'plugin-catalog-dialog');
      catalogModal = dialog;
      const heading = el(document, 'header', 'plugin-catalog-dialog-head');
      heading.append(identity(entry.name, entry.author,
        entry.origin.id === 'github-discovery' ? '' : t(`plugins.origin.${entry.origin.kind}`), entry.icon, entry.identityIcon, entry.origin.kind === 'official'));
      const close = button('×', () => dialog.close(), 'plugin-dialog-close');
      close.setAttribute('aria-label', t('settings.plugins.cancel')); heading.append(close);
      const body = el(document, 'div', 'plugin-catalog-dialog-body');
      body.append(el(document, 'p', 'plugin-description', entry.description));
      const meta = el(document, 'div', 'plugin-card-meta');
      if (entry.version) meta.append(el(document, 'span', 'plugin-version', `v${entry.version}`));
      meta.append(typeLabels(entry));
      if (Number.isSafeInteger(entry.stars)) {
        const stars = el(document, 'span', 'plugin-stars', `☆ ${entry.stars.toLocaleString(getLocale())}`);
        stars.setAttribute('aria-label', `${t('plugins.catalog.stars')}: ${entry.stars}`); meta.append(stars);
      }
      body.append(meta);
      if (entry.repository) body.append(button(t('plugins.catalog.openRepository'), () => void onOpenExternal(entry.repository), 'plugin-inline-action'));
      if (entry.origin.kind !== 'official') body.append(el(document, 'p', 'settings-note', t('plugins.catalog.unreviewed')));
      const selected = entry.versions?.find(v => v.version === entry.version);
      if (selected?.changelog) body.append(el(document, 'h3', 'plugin-detail-heading', t('plugins.catalog.changelog')), el(document, 'p', 'plugin-description', selected.changelog));
      const readme = el(document, 'div', 'plugin-catalog-readme', t('plugins.view.loading'));
      body.append(readme);
      void api.catalogDetails(entry.origin.id, entry.id).then(result => {
        if (!dialog.isConnected) return;
        // Main supplies Markdown-generated markup with author HTML disabled.
        readme.innerHTML = result.html || '';
        if (!result.html) readme.textContent = t('plugins.catalog.noReadme');
        for (const link of readme.querySelectorAll('a[href]')) {
          link.addEventListener('click', event => {
            event.preventDefault();
            void Promise.resolve(onOpenExternal(link.href)).catch(() => {});
          });
        }
        if (!result.imageCount) return;
        const loadImages = button(t('plugins.catalog.loadImages'), async () => {
          loadImages.disabled = true; loadImages.textContent = t('plugins.view.loading');
          for (const slot of readme.querySelectorAll('[data-readme-image]')) {
            if (!dialog.isConnected) return;
            const index = Number(slot.dataset.readmeImage);
            try {
              const data = await api.catalogReadmeImage(result.documentId, index);
              if (!dialog.isConnected) return;
              const image = el(document, 'img'); image.src = data; image.alt = slot.getAttribute('aria-label') || t('plugins.catalog.screenshot', { index: index + 1 });
              const zoom = button('', event => {
                event.preventDefault(); event.stopPropagation();
                const lightbox = el(document, 'dialog', 'plugin-catalog-dialog plugin-image-dialog');
                const bar = el(document, 'header', 'plugin-catalog-dialog-head');
                const exit = button('×', () => lightbox.close(), 'plugin-dialog-close'); exit.setAttribute('aria-label', t('settings.plugins.cancel')); bar.append(exit);
                const imageBody = el(document, 'div', 'plugin-catalog-dialog-body');
                const large = el(document, 'img'); large.src = data; large.alt = image.alt; imageBody.append(large);
                lightbox.append(bar, imageBody); dialog.append(lightbox);
                dismissOnOutside(lightbox);
                lightbox.addEventListener('close', () => { lightbox.remove(); if (zoom.isConnected) zoom.focus({ preventScroll: true }); });
                lightbox.showModal();
              }, 'plugin-screenshot'); zoom.setAttribute('aria-label', image.alt); zoom.append(image); slot.replaceWith(zoom);
            } catch { if (dialog.isConnected) slot.textContent = t('plugins.catalog.imageUnavailable'); }
          }
          loadImages.remove();
        }, 'plugin-inline-action plugin-readme-load');
        readme.before(loadImages);
      }).catch(() => { if (dialog.isConnected) readme.textContent = t('plugins.catalog.noReadme'); });
      const footer = el(document, 'footer', 'plugin-catalog-dialog-footer');
      if (selected ? selected.installable : ['available', 'update'].includes(entry.status)) {
        footer.append(button(t(entry.installedVersion ? 'plugins.package.update' : 'plugins.package.install'), () => {
          dialog.close();
          void run(async () => { activeTab = 'discover'; sourcesOpen = false; catalogReview = entry; await previewCatalog(entry, entry.version); return null; });
        }, 'plugin-allow'));
      } else if (entry.status === 'repository') footer.append(el(document, 'span', 'settings-note', t('plugins.catalog.repositoryOnly')));
      footer.append(button(t('settings.plugins.cancel'), () => dialog.close()));
      dialog.append(heading, body, footer); container.append(dialog);
      dialog.setAttribute('aria-label', entry.name);
      dismissOnOutside(dialog);
      dialog.addEventListener('close', () => {
        dialog.remove(); if (catalogModal === dialog) {
          catalogModal = null; void Promise.resolve(api.closeCatalogDetails?.()).catch(() => {});
        }
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      });
      dialog.showModal();
    }

    function dismissOnOutside(dialog) {
      // Chromium may group programmatically opened close watchers. Handle the
      // key on the focused dialog so one Escape cannot close both layers.
      dialog.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.target.closest('dialog') !== dialog) return;
        event.preventDefault(); event.stopPropagation(); dialog.close();
      });
      let startedOutside = false;
      const outside = event => {
        const rect = dialog.getBoundingClientRect();
        return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
      };
      dialog.addEventListener('pointerdown', event => { startedOutside = outside(event); });
      dialog.addEventListener('click', event => { if (startedOutside && outside(event)) dialog.close(); startedOutside = false; });
    }

    function catalogPanel() {
      const wrap = el(document, 'div', 'plugin-catalog');
      if (!catalogData) { wrap.append(el(document, 'p', 'settings-note', t('plugins.view.loading'))); return wrap; }
      if (catalogData.error) wrap.append(el(document, 'p', 'plugin-risk', catalogData.error));
      const search = el(document, 'input', 'plugin-catalog-search');
      search.type = 'search'; search.value = query;
      search.placeholder = t('plugins.catalog.search'); search.setAttribute('aria-label', t('plugins.catalog.search'));
      const results = el(document, 'div', 'plugin-catalog-results');
      function renderResults() {
        const matches = p => `${p.name} ${p.description} ${p.author || ''} ${p.id}`.toLowerCase().includes(query.toLowerCase());
        const sections = [];
        const groups = [
          ['plugins.catalog.official', catalogData.entries.filter(p => p.origin.kind === 'official')],
          ['plugins.catalog.github', catalogData.github?.entries || []],
          ['plugins.catalog.custom', catalogData.entries.filter(p => p.origin.kind !== 'official')]
        ];
        for (const [label, all] of groups) {
          if (label === 'plugins.catalog.custom' && !all.length) continue;
          const section = el(document, 'section', 'plugin-catalog-group');
          section.append(el(document, 'h3', 'plugin-detail-heading', t(label)));
          if (label === 'plugins.catalog.github') {
            section.append(el(document, 'p', 'settings-note', t('plugins.catalog.githubNote')));
            if (catalogData.github?.error) section.append(el(document, 'p', 'settings-note', t('plugins.catalog.githubFailed', { error: catalogData.github.error })));
            if (catalogData.github?.limited) section.append(el(document, 'p', 'settings-note', t('plugins.catalog.githubLimited')));
          }
          const grid = el(document, 'div', 'plugin-catalog-grid');
          for (const entry of all.filter(matches)) {
            const card = el(document, 'article', 'plugin-card'); card.dataset.catalogId = entry.id;
            const head = el(document, 'div', 'plugin-card-head');
            const title = button('', () => catalogDialog(entry), 'plugin-catalog-title');
            title.append(identity(entry.name, entry.author, '', entry.icon, entry.identityIcon, entry.origin.kind === 'official'));
            head.append(title);
            const actions = el(document, 'div', 'settings-actions');
            const available = entry.versions?.find(v => v.version === entry.version)?.installable ?? ['available', 'update'].includes(entry.status);
            if (available) actions.append(button(t(entry.installedVersion ? 'plugins.package.update' : 'plugins.package.install'), () => void run(async () => { catalogReview = entry; await previewCatalog(entry, entry.version); return null; })));
            else actions.append(button(t('plugins.catalog.details'), () => catalogDialog(entry)));
            if (entry.installedVersion) actions.append(button(t('plugins.catalog.installed'), () => { activeTab = 'installed'; selectedPluginId = ''; diagnostics = false; render(); container.querySelector(`[data-plugin-id="${entry.id}"]`)?.scrollIntoView({ block: 'nearest' }); }, 'plugin-installed-link plugin-installed-check'));
            head.append(actions);
            card.append(head, el(document, 'p', 'plugin-description', entry.description));
            const meta = el(document, 'div', 'plugin-card-meta');
            if (entry.version) meta.append(el(document, 'span', 'plugin-version', `v${entry.version}`));
            meta.append(typeLabels(entry));
            if (Number.isSafeInteger(entry.stars)) {
              const stars = el(document, 'span', 'plugin-stars', `☆ ${entry.stars.toLocaleString(getLocale())}`);
              stars.setAttribute('aria-label', `${t('plugins.catalog.stars')}: ${entry.stars}`); meta.append(stars);
            } else if (entry.origin.kind === 'community' && entry.origin.id !== 'github-discovery') meta.append(el(document, 'span', 'plugin-origin-note', entry.origin.label));
            card.append(meta);
            card.addEventListener('click', event => { if (!event.target.closest('button')) catalogDialog(entry); });
            grid.append(card);
          }
          if (!grid.children.length) grid.append(el(document, 'p', 'settings-note', t('plugins.catalog.noResults')));
          section.append(grid); sections.push(section);
        }
        results.replaceChildren(...sections);
        if (content?.contains(results)) identifyContent();
      }
      search.addEventListener('input', () => { query = search.value; renderResults(); });
      wrap.append(search, results);
      const refresh = el(document, 'div', 'settings-actions plugin-catalog-refresh');
      refresh.append(button(t('plugins.catalog.refresh'), () => void run(async () => {
        for (const source of catalogData.sources.filter(source => source.kind === 'community')) await api.refreshSource(source.id);
        catalogData = api.discoverCatalog ? await api.discoverCatalog(true) : await api.catalog(); return null;
      })));
      if (catalogData.github?.lastFetched) refresh.append(el(document, 'span', 'settings-note', t('plugins.catalog.lastChecked', { time: new Date(catalogData.github.lastFetched).toLocaleString(getLocale()) })));
      wrap.append(refresh); renderResults(); return wrap;
    }

    function sourcesPanel() {
      const details = el(document, 'section', 'plugin-detail plugin-sources');
      details.append(button(t('plugins.ui.backCatalog'), () => { sourcesOpen = false; render(); navigation.querySelector('.plugin-more')?.focus({ preventScroll: true }); }, 'plugin-back'));
        details.append(el(document, 'h3', '', t('plugins.catalog.sources')), el(document, 'p', 'settings-note', t('plugins.catalog.sourceNote')));
        for (const source of catalogData.sources.filter(s => s.kind === 'community')) {
          const row = el(document, 'section', 'plugin-source-row'); row.append(el(document, 'strong', 'plugin-consent-title', source.label), el(document, 'code', 'plugin-log', source.url));
          row.dataset.errorTarget = `source:${source.id}`;
          row.append(el(document, 'p', 'settings-note', source.lastFetched ? t('plugins.catalog.cached', { time: new Date(source.lastFetched).toLocaleString() }) : t('plugins.catalog.notFetched')));
          if (source.signed) row.append(el(document, 'p', 'settings-note', t('plugins.catalog.signed')));
          if (source.fingerprint) row.append(el(document, 'code', 'plugin-log', source.fingerprint));
          if (source.error) row.append(el(document, 'p', 'plugin-risk', source.error));
          const actions = el(document, 'div', 'settings-actions');
          actions.append(button(t('plugins.catalog.refresh'), () => void run(async () => { catalogData = await api.refreshSource(source.id); return null; }, `source:${source.id}`)),
            button(t('plugins.catalog.removeSource'), () => void run(async () => { catalogData = await api.removeSource(source.id); return null; }, `source:${source.id}`)));
          row.append(actions); details.append(row);
        }
        const form = el(document, 'form', 'plugin-source-form');
        form.dataset.errorTarget = 'source-form';
        const urlLabel = el(document, 'label', '', t('plugins.catalog.url'));
        const url = el(document, 'input'); url.type = 'url'; url.required = true; url.placeholder = 'https://'; url.value = sourceDraft.url;
        url.addEventListener('input', () => { sourceDraft.url = url.value; }); urlLabel.append(url);
        const advanced = el(document, 'div', 'plugin-source-optional');
        const keyLabel = el(document, 'label', '', t('plugins.catalog.optionalKey'));
        const key = el(document, 'textarea'); key.rows = 3; key.value = sourceDraft.publicKey;
        key.addEventListener('input', () => { sourceDraft.publicKey = key.value; }); keyLabel.append(key); advanced.append(keyLabel);
        const actions = el(document, 'div', 'settings-actions'); const submit = button(t('plugins.catalog.addSource'), () => {}); submit.type = 'submit'; actions.append(submit);
        form.append(urlLabel, advanced, actions);
        form.addEventListener('submit', event => { event.preventDefault(); void run(async () => {
          catalogData = await api.addSource({ ...sourceDraft }); sourceDraft.url = ''; sourceDraft.publicKey = ''; return null;
        }, 'source-form'); });
        details.append(form);
      return details;
    }

    function statusChip(plugin) {
      const status = plugin.status;
      const chip = el(document, 'span', `plugin-status plugin-status-${status}`, t(`settings.plugins.status.${status}`));
      if (status === 'active' && plugin.runtime?.state === 'running') chip.classList.add('is-live');
      return chip;
    }

    function consentPanel(plugin) {
      const panel = el(document, 'div', 'plugin-consent');
      panel.append(el(document, 'div', 'plugin-consent-title', t('settings.plugins.consentTitle', { name: plugin.name })));
      panel.append(el(document, 'p', 'plugin-risk', t('plugins.trusted.warning')));
      const actions = el(document, 'div', 'settings-actions plugin-consent-actions');
      const cancel = el(document, 'button', '', t('settings.plugins.cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', () => { consentFor = ''; render(); });
      const allow = el(document, 'button', 'plugin-allow', t('settings.plugins.allow'));
      allow.type = 'button';
      allow.addEventListener('click', () => {
        consentFor = '';
        void run(() => api.setEnabled(plugin.id, true), `plugin:${plugin.id}`);
      });
      actions.append(cancel, allow);
      panel.append(actions);
      return panel;
    }

    function viewRows(plugin) {
      const wrap = el(document, 'div', 'plugin-views');
      wrap.append(el(document, 'div', 'plugin-subhead', t('settings.plugins.views')));
      for (const view of plugin.views.filter(view => view.surfaces.some(surface => SURFACE_ORDER.includes(surface)))) {
        const row = el(document, 'div', 'plugin-view-row');
        row.dataset.errorTarget = `view:${view.ref}`;
        row.append(el(document, 'span', 'plugin-view-title', view.title));
        const chips = el(document, 'div', 'plugin-surface-chips');
        for (const surface of SURFACE_ORDER.filter((name) => view.surfaces.includes(name))) {
          const placed = view.placements?.[surface] === true;
          const chip = el(document, 'button', `plugin-surface-chip${placed ? ' is-on' : ''}`, t(`settings.plugins.surface.${surface}`));
          chip.type = 'button';
          chip.dataset.controlKey = `place/${view.ref}/${surface}`;
          chip.setAttribute('aria-pressed', String(placed));
          chip.setAttribute('aria-label', t(placed ? 'settings.plugins.unplace' : 'settings.plugins.place', { view: view.title, surface: t(`settings.plugins.surface.${surface}`) }));
          chip.addEventListener('click', () => void run(async () => {
            const next = await api.place(view.ref, surface, !placed);
            onPlaced(surface, view.ref, !placed);
            return next;
          }, `view:${view.ref}`));
          chips.append(chip);
        }
        row.append(chips);
        wrap.append(row);
      }
      return wrap;
    }

    function runtimeRow(plugin) {
      const runtime = plugin.runtime;
      const row = el(document, 'div', 'plugin-runtime');
      const parts = [t(`settings.plugins.runtimeState.${runtime.state}`)];
      if (runtime.mode) parts.push(t(`settings.plugins.mode.${runtime.mode}`));
      if (runtime.cpuPercent !== null && runtime.state === 'running') parts.push(`CPU ${runtime.cpuPercent}%`);
      if (runtime.memoryMB !== null && runtime.state === 'running') parts.push(`${Math.round(runtime.memoryMB)} MB`);
      row.append(el(document, 'span', 'plugin-runtime-text', parts.join(' · ')));
      if (runtime.lastError) row.append(el(document, 'span', 'plugin-runtime-error', runtime.lastError));
      const restartWrap = el(document, 'div', 'settings-actions');
      const restart = el(document, 'button', 'plugin-restart', t('settings.plugins.restart'));
      restart.type = 'button';
      restart.addEventListener('click', () => void run(() => api.restart(plugin.id)));
      restartWrap.append(restart);
      row.append(restartWrap);
      return row;
    }

    function openPlugin(id, placements = false) {
      if (!selectedPluginId) installedPosition = rememberPosition();
      selectedPluginId = id; diagnostics = false; render();
      const target = (placements && content.querySelector('.plugin-views')) || content.querySelector('.plugin-back');
      if (placements && target?.classList.contains('plugin-views')) target.tabIndex = -1;
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest' });
    }

    function closePlugin() {
      const saved = installedPosition;
      selectedPluginId = ''; diagnostics = false; installedPosition = null;
      render();
      const target = saved && [...content.querySelectorAll('[data-plugin-focus]')].find(node => node.dataset.pluginFocus === saved.key);
      (target || tabControls.get('installed'))?.focus({ preventScroll: true });
      if (saved) for (const [node, top] of saved.scroll) node.scrollTop = top;
    }

    function pluginIdentity(plugin) {
      const head = el(document, 'div', 'plugin-card-head');
      head.append(identity(plugin.name, plugin.author, t(plugin.installation ? `plugins.origin.${plugin.installation.origin.kind}` : `settings.plugins.source.${plugin.source}`), plugin.views?.[0]?.icon, plugin.identityIcon, plugin.installation?.origin.kind === 'official'));
      if (!plugin.managementOnly && !['invalid', 'missing'].includes(plugin.status)) {
        const toggle = el(document, 'input', 'plugin-enable');
        toggle.type = 'checkbox'; toggle.checked = plugin.enabled; toggle.disabled = !list?.enabled;
        toggle.setAttribute('aria-label', t('settings.plugins.enable', { name: plugin.name }));
        toggle.addEventListener('change', () => {
          if (toggle.checked && !plugin.trusted) { consentFor = plugin.id; openPlugin(plugin.id); }
          else void run(() => api.setEnabled(plugin.id, toggle.checked), `plugin:${plugin.id}`);
        });
        const label = el(document, 'label', 'checkbox-label plugin-toggle'); label.append(toggle); head.append(label);
      }
      return head;
    }

    function pluginProblems(plugin) {
      const wrap = el(document, 'div', 'plugin-errors');
      for (const error of plugin.errors || []) wrap.append(el(document, 'code', 'plugin-error', error));
      return wrap;
    }

    function pluginCard(plugin) {
      const card = el(document, 'section', `plugin-card plugin-installed-card plugin-card-${plugin.status}`);
      card.dataset.pluginId = plugin.id;
      card.append(pluginIdentity(plugin));
      if (plugin.description) card.append(el(document, 'p', 'plugin-description', plugin.description));
      if (plugin.version) {
        const meta = el(document, 'div', 'plugin-card-meta');
        meta.append(el(document, 'span', 'plugin-version', `v${plugin.version}`), typeLabels(plugin)); card.append(meta);
      }
      const footer = el(document, 'div', 'plugin-card-footer');
      const surfaces = SURFACE_ORDER.filter(surface => plugin.views?.some(view => view.placements?.[surface]));
      const exceptional = !['active', 'disabled'].includes(plugin.status);
      if (exceptional) footer.append(statusChip(plugin));
      else {
        const summary = el(document, 'span', 'plugin-placement-summary');
        const count = button(t('plugins.ui.locationCount', { count: surfaces.length }), () => openPlugin(plugin.id, true), 'plugin-location-count');
        count.dataset.controlKey = 'placements';
        const details = surfaces.length
          ? [{ full: t('plugins.ui.selectedLocations'), heading: true }, ...surfaces.map(surface => ({ full: t(`settings.plugins.surface.${surface}`) }))]
          : [{ full: t('plugins.ui.noPlacements') }];
        if (setDetailTooltip) {
          setDetailTooltip(count, details, { centered: true });
          const tooltip = count.querySelector('[role="tooltip"]');
          if (tooltip) { tooltip.id = `plugin-placements-${++menuId}`; count.setAttribute('aria-describedby', tooltip.id); }
        } else {
          count.setAttribute('aria-description', details.map(entry => entry.full).join(', '));
        }
        count.setAttribute('aria-label', `${t('settings.plugins.views')}: ${t('plugins.ui.locationCount', { count: surfaces.length })}`);
        summary.append(count); footer.append(summary);
      }
      const manage = button(t(plugin.status === 'needsApproval' ? 'settings.plugins.reapprove' : 'plugins.ui.manage'), () => {
        if (plugin.status === 'needsApproval') consentFor = plugin.id;
        openPlugin(plugin.id);
      }, 'plugin-manage');
      manage.setAttribute('aria-label', t('plugins.ui.manageNamed', { name: plugin.name }));
      if (plugin.status === 'crashed') footer.append(button(t('settings.plugins.restart'), () => void run(() => api.restart(plugin.id)), 'plugin-restart plugin-inline-action'));
      const update = catalogData?.entries.find(entry => entry.id === plugin.id && entry.status === 'update' && entry.origin.id === plugin.installation?.origin.id);
      if (update) footer.append(button(t('plugins.catalog.updateTo', { version: update.version }), () => catalogDialog(update), 'plugin-update-action'));
      footer.append(manage); card.append(footer);
      return card;
    }

    function detailSection(title, ...children) {
      const section = el(document, 'section', 'plugin-detail-section');
      section.append(el(document, 'h3', 'plugin-detail-heading', title), ...children);
      return section;
    }

    function authorText(value) {
      if (typeof value === 'string') return value;
      const locale = document.documentElement.lang || 'en';
      return window.TokenMonitorPluginLocalized?.localize(value, locale)
        || value?.[locale] || value?.[locale.split('-')[0]] || value?.en || value?.[''] || Object.values(value || {})[0] || '';
    }

    async function loadAuthorSettings(plugin, state) {
      try {
        const snapshot = await api.getSettings(plugin.id);
        if (authorSettings.get(plugin.id) !== state) return;
        state.snapshot = snapshot; state.draft = { ...snapshot.values }; state.errors = { ...snapshot.errors };
        state.message = ''; state.dirty = false;
      } catch {
        state.message = 'loadFailed';
      } finally {
        state.loading = false;
        if (authorSettings.get(plugin.id) === state && selectedPluginId === plugin.id) render();
      }
    }

    function authorSettingsSection(plugin) {
      const section = detailSection(t('plugins.authorSettings.title'));
      section.classList.add('plugin-author-settings');
      let state = authorSettings.get(plugin.id);
      if (!state) {
        state = { loading: true, snapshot: null, draft: {}, errors: {}, message: '', dirty: false };
        authorSettings.set(plugin.id, state);
        // The static form never enables a plugin or requests display demand.
        void Promise.resolve().then(() => loadAuthorSettings(plugin, state));
      }
      const status = el(document, 'p', 'settings-note plugin-author-status');
      status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const refresh = () => {
        if (busy || state.loading) return;
        state.loading = true; render(); void loadAuthorSettings(plugin, state);
      };
      if (state.loading || !state.snapshot) {
        section.setAttribute('aria-busy', String(state.loading));
        status.textContent = t(`plugins.authorSettings.${state.loading ? 'loading' : 'loadFailed'}`);
        section.append(status);
        if (!state.loading) section.append(button(t('plugins.authorSettings.reload'), refresh));
        return section;
      }
      const snapshot = state.snapshot;
      section.append(el(document, 'p', 'settings-note', t('plugins.authorSettings.note')));
      if (!plugin.enabled || !list.enabled) section.append(el(document, 'p', 'settings-note', t('plugins.authorSettings.disabledNote')));
      const form = el(document, 'form', 'plugin-author-form'); form.noValidate = true;
      for (const field of snapshot.schema.fields) {
        const row = el(document, 'div', 'plugin-author-field');
        const id = `${container.id || 'plugin-settings'}-author-${plugin.id}-${field.id}`;
        const label = el(document, 'label', 'plugin-author-label', authorText(field.label)); label.htmlFor = id;
        const input = el(document, field.type === 'select' ? 'select' : 'input', 'plugin-author-input');
        input.id = id; input.dataset.controlKey = `author-${field.id}`; input.disabled = busy || snapshot.readOnly;
        if (field.type === 'select') {
          for (const option of field.options) {
            const node = el(document, 'option', '', authorText(option.label)); node.value = option.value; input.append(node);
          }
          input.value = state.draft[field.id] ?? '';
        } else if (field.type === 'boolean') {
          input.type = 'checkbox'; input.checked = state.draft[field.id] === true;
          row.classList.add('plugin-author-checkbox');
        } else {
          input.type = field.type === 'number' ? 'number' : 'text'; input.value = state.draft[field.id] ?? '';
          if (field.type === 'number') {
            input.step = field.integer ? '1' : 'any';
            if (field.min !== undefined) input.min = String(field.min);
            if (field.max !== undefined) input.max = String(field.max);
          } else { input.minLength = field.minLength; input.maxLength = field.maxLength; }
        }
        const describedBy = [];
        row.append(label, input);
        if (field.description) {
          const description = el(document, 'p', 'settings-note', authorText(field.description));
          description.id = `${id}-description`; describedBy.push(description.id); row.append(description);
        }
        const error = el(document, 'p', 'plugin-author-error', t('plugins.authorSettings.invalidField'));
        error.id = `${id}-error`; error.hidden = !state.errors[field.id]; describedBy.push(error.id); row.append(error);
        input.setAttribute('aria-describedby', describedBy.join(' '));
        input.setAttribute('aria-invalid', String(Boolean(state.errors[field.id])));
        input.addEventListener(field.type === 'boolean' || field.type === 'select' ? 'change' : 'input', () => {
          if (busy || snapshot.readOnly) return;
          state.draft[field.id] = field.type === 'boolean' ? input.checked
            : field.type === 'number' ? (input.value === '' ? null : input.valueAsNumber) : input.value;
          delete state.errors[field.id]; error.hidden = true; input.setAttribute('aria-invalid', 'false');
          state.dirty = true; state.message = ''; status.textContent = ''; save.disabled = false;
        });
        form.append(row);
      }
      async function commit() {
        if (busy || snapshot.readOnly || !state.dirty) return;
        const patch = { ...state.draft };
        const hadFocus = form.contains(document.activeElement);
        state.message = 'saving'; status.textContent = t('plugins.authorSettings.saving');
        await run(async () => {
          try {
            const next = await api.updateSettings(plugin.id, { schemaVersion: snapshot.schemaVersion, expectedRevision: snapshot.revision, patch });
            state.snapshot = next; state.draft = { ...next.values }; state.errors = { ...next.errors };
            state.dirty = false; state.message = 'saved';
          } catch (error) {
            state.errors = error.fields || {};
            state.message = error.code === 'settings-conflict' || String(error.message).includes('settings-conflict') ? 'conflict'
              : Object.keys(state.errors).length ? 'invalid' : 'saveFailed';
          }
          return null;
        });
        if (hadFocus && document.activeElement === document.body && selectedPluginId === plugin.id) {
          const feedback = content.querySelector('.plugin-author-status');
          if (feedback) { feedback.tabIndex = -1; feedback.focus({ preventScroll: true }); }
        }
      }
      form.addEventListener('submit', event => { event.preventDefault(); void commit(); });
      const actions = el(document, 'div', 'settings-actions plugin-author-actions');
      const save = button(t('plugins.authorSettings.save'), () => void commit());
      save.dataset.controlKey = 'author-save'; save.disabled = busy || snapshot.readOnly || !state.dirty;
      const defaults = button(t('plugins.authorSettings.defaults'), () => {
        if (busy || snapshot.readOnly) return;
        state.draft = Object.fromEntries(snapshot.schema.fields.map(field => [field.id, field.default]));
        state.dirty = true; state.errors = {}; state.message = 'defaultsNote'; render();
      });
      defaults.dataset.controlKey = 'author-defaults'; defaults.disabled = busy || snapshot.readOnly;
      const reload = button(t('plugins.authorSettings.reload'), refresh); reload.dataset.controlKey = 'author-reload';
      actions.append(save, defaults, reload); form.append(actions);
      status.textContent = state.message ? t(`plugins.authorSettings.${state.message}`)
        : snapshot.readOnly ? t('plugins.authorSettings.newerSchema')
          : Object.keys(state.errors).length ? t('plugins.authorSettings.invalid') : '';
      section.append(form, status);
      return section;
    }

    function pluginDetail(plugin) {
      const wrap = el(document, 'section', 'plugin-detail'); wrap.dataset.pluginId = plugin.id;
      const toolbar = el(document, 'div', 'plugin-detail-toolbar');
      const back = button(t('plugins.ui.back'), closePlugin, 'plugin-back');
      toolbar.append(back); wrap.append(toolbar, pluginIdentity(plugin));
      if (plugin.version) {
        const meta = el(document, 'div', 'plugin-card-meta');
        meta.append(el(document, 'span', 'plugin-version', `v${plugin.version}`), typeLabels(plugin)); wrap.append(meta);
      }
      if (!['active', 'disabled'].includes(plugin.status)) wrap.append(statusChip(plugin));
      if (plugin.description) wrap.append(el(document, 'p', 'plugin-description', plugin.description));
      if (plugin.author) wrap.append(el(document, 'p', 'settings-note', plugin.author));
      if (consentFor === plugin.id && !plugin.managementOnly && !['invalid', 'missing'].includes(plugin.status)) wrap.append(consentPanel(plugin));
      else if (plugin.status === 'needsApproval') {
        const actions = el(document, 'div', 'settings-actions');
        actions.append(button(t('settings.plugins.reapprove'), () => { consentFor = plugin.id; diagnostics = false; render(); })); wrap.append(actions);
      }
      if (plugin.installation && ['invalid', 'missing'].includes(plugin.status)) {
        const note = el(document, 'p', 'plugin-risk', t(plugin.status === 'missing' ? 'plugins.package.missingNote' : 'plugins.package.repairRequired'));
        note.setAttribute('role', 'status'); wrap.append(note);
      }
      if (plugin.errors?.length) wrap.append(pluginProblems(plugin));
      if (diagnostics) {
        const actions = el(document, 'div', 'settings-actions');
        actions.append(button(t('plugins.ui.toSettings'), () => { diagnostics = false; render(); content.querySelector('.plugin-diagnostics')?.focus({ preventScroll: true }); }));
        wrap.append(actions);
        if (plugin.runtime) wrap.append(detailSection(t('plugins.ui.diagnostics'), runtimeRow(plugin)));
        if (plugin.logs?.length) {
          const lines = el(document, 'div', 'plugin-log-lines');
          for (const entry of plugin.logs.slice(-12)) lines.append(el(document, 'code', `plugin-log plugin-log-${entry.level}`, `${new Date(entry.at).toLocaleTimeString()} ${entry.text}`));
          wrap.append(detailSection(t('settings.plugins.logs', { count: plugin.logs.length }), lines));
        }
        return wrap;
      }
      if (plugin.settings && api.getSettings && api.updateSettings) wrap.append(authorSettingsSection(plugin));
      // Disabled plugins keep their saved placements visible, without offering
      // mutations until enabled. The count is a selection, not runtime activity.
      if (plugin.status === 'disabled') {
        const selected = SURFACE_ORDER.filter(surface => plugin.views?.some(view => view.placements?.[surface]));
        const placements = el(document, 'div', 'plugin-views');
        placements.append(el(document, 'div', 'plugin-subhead', t('plugins.ui.selectedLocations')));
        for (const surface of selected) placements.append(el(document, 'span', 'settings-note', t(`settings.plugins.surface.${surface}`)));
        if (!selected.length) placements.append(el(document, 'span', 'settings-note', t('plugins.ui.noPlacements')));
        wrap.append(placements);
      }
      if (plugin.status === 'active') {
        for (const view of plugin.views || []) if (mountSettings && view.surfaces.includes('settings')) {
          if (!settingsMounts.has(view.ref)) settingsMounts.set(view.ref, { node: el(document, 'div', 'plugin-author-settings'), pluginId: plugin.id, revision: view.revision });
          const custom = settingsMounts.get(view.ref).node;
          wrap.append(custom); mountSettings(custom, view);
        }
        if (plugin.views?.some(view => view.surfaces.some(surface => SURFACE_ORDER.includes(surface)))) wrap.append(viewRows(plugin));
        if (plugin.background?.supported) {
          const label = el(document, 'label', 'checkbox-label settings-item plugin-background');
          const text = el(document, 'span', 'settings-item-text'); text.append(el(document, 'span', 'settings-item-title', t('settings.plugins.background')));
          const input = el(document, 'input'); input.type = 'checkbox'; input.checked = plugin.background.enabled;
          input.addEventListener('change', () => void run(() => api.setBackground(plugin.id, input.checked)));
          label.append(text, input, el(document, 'span', 'settings-note settings-item-desc', t('settings.plugins.backgroundNote'))); wrap.append(label);
        }
        if (plugin.skins?.length) {
          const skins = el(document, 'div', 'plugin-skins');
          skins.dataset.errorTarget = `skins:${plugin.id}`;
          for (const skin of plugin.skins) {
            const chip = button('', () => void run(async () => { await onApplySkin(skin); }, `skins:${plugin.id}`), 'theme-preset-chip plugin-skin-chip');
            chip.dataset.controlKey = `skin/${skin.ref}`;
            const dot = el(document, 'span', 'theme-preset-dot'); dot.style.background = skin.colors.accent || skin.colors.chart || 'currentColor';
            chip.append(dot, el(document, 'span', '', skin.name)); chip.setAttribute('aria-label', t('settings.plugins.applySkin', { name: skin.name })); skins.append(chip);
          }
          wrap.append(detailSection(t('settings.plugins.skins'), skins));
        }
        const pages = (plugin.views || []).filter(view => view.surfaces.includes('page'));
        if (pages.length) {
          const actions = el(document, 'div', 'settings-actions plugin-page-actions');
          for (const page of pages) {
            const open = button(t('plugins.page.open', { name: page.title }), () => void run(async () => { await api.openPage(page.ref); return null; }));
            open.disabled = busy || !page.placements?.page;
            if (!page.placements?.page) open.setAttribute('aria-description', t('plugins.page.enableFirst'));
            actions.append(open);
          }
          wrap.append(detailSection(t('plugins.ui.pages'), el(document, 'p', 'settings-note', t('plugins.ui.pagesNote')), actions));
        }
      }
      for (const view of plugin.status === 'active' ? plugin.views || [] : []) {
        for (const target of view.mode === 'replace' ? view.targets || [] : []) {
          const selected = list.contentSelections?.[target] === view.ref;
          const row = el(document, 'div', 'settings-actions');
          row.append(el(document, 'span', 'settings-note', target), button(t(selected ? 'plugins.trusted.restore' : 'plugins.trusted.useContent'), () => void run(() => api.selectContent(target, selected ? null : view.ref))));
          wrap.append(row);
        }
      }
      for (const target of new Set((plugin.status === 'active' ? plugin.views || [] : []).filter(view => view.mode !== 'replace').flatMap(view => view.targets || []))) {
        const views = (list.plugins || []).flatMap(item => (item.views || []).filter(view => view.mode !== 'replace' && view.targets?.includes(target)))
          .sort((a, b) => (a.contentOrder?.[target] ?? Number.MAX_SAFE_INTEGER) - (b.contentOrder?.[target] ?? Number.MAX_SAFE_INTEGER));
        if (views.length < 2) continue;
        const rows = el(document, 'div', 'plugin-content-order');
        for (const [index, view] of views.entries()) {
          const row = el(document, 'div', 'settings-actions');
          row.append(el(document, 'span', 'settings-note', view.title));
          for (const direction of [-1, 1]) {
            const move = button(direction < 0 ? '↑' : '↓', () => void run(() => {
              const refs = views.map(item => item.ref);
              [refs[index], refs[index + direction]] = [refs[index + direction], refs[index]];
              return api.orderContent(target, refs);
            }));
            move.disabled = busy || index + direction < 0 || index + direction >= views.length;
            move.setAttribute('aria-label', t(direction < 0 ? 'settings.limits.moveUp' : 'settings.limits.moveDown', { name: view.title }));
            row.append(move);
          }
          rows.append(row);
        }
        wrap.append(detailSection(target, rows));
      }
      const utility = el(document, 'div', 'settings-actions plugin-detail-utilities');
      if (plugin.runtime || plugin.logs?.length) utility.append(button(t('plugins.ui.diagnostics'), () => { diagnostics = true; render(); content.querySelector('.plugin-back')?.focus({ preventScroll: true }); }, 'plugin-diagnostics'));
      if (plugin.installation) {
        if (plugin.installation.previousVersion) utility.append(button(t('plugins.package.rollback'), () => { operation = { id: plugin.id, kind: 'rollback' }; render(); }));
        utility.append(button(t('plugins.package.uninstall'), () => { operation = { id: plugin.id, kind: 'uninstall', keepData: true, keepPlacements: false }; render(); }));
      }
      if (utility.childElementCount) wrap.append(utility);
      if (operation?.id === plugin.id) wrap.append(operationPanel(plugin));
      return wrap;
    }

    function replaceContent(nodes, saved) {
      for (const detail of content.querySelectorAll('details')) {
        const key = detail.dataset.detailKey || `${renderedTab}/${detail.className}/${detail.querySelector('summary')?.textContent}`;
        detailState.set(key, detail.open);
      }
      // Keep the current scroll range while swapping, then release all space
      // beyond what the current ancestor scroll positions actually require.
      const previousHeight = content.getBoundingClientRect().height;
      content.style.minHeight = `${Math.ceil(previousHeight)}px`;
      content.replaceChildren(...nodes);
      const notice = errorNotice();
      if (notice) {
        const target = [...content.querySelectorAll('[data-error-target], [data-plugin-id]')].find(node =>
          node.dataset.errorTarget === actionError.target || `plugin:${node.dataset.pluginId}` === actionError.target);
        const anchor = target || content.querySelector('.plugin-catalog-review, .plugin-sources');
        if (anchor) {
          const actions = anchor.querySelector('.plugin-consent-actions, .plugin-detail-utilities');
          if (actions?.parentElement === anchor) actions.before(notice);
          else anchor.append(notice);
          for (const control of anchor.querySelectorAll('button, input, select, textarea')) {
            control.setAttribute('aria-describedby', [control.getAttribute('aria-describedby'), notice.id].filter(Boolean).join(' '));
          }
        } else content.prepend(notice);
      }
      const spareScroll = saved.scroll.length ? Math.min(...saved.scroll.map(([node, top]) => Math.max(0, node.scrollHeight - node.clientHeight - top))) : previousHeight;
      content.style.minHeight = `${Math.max(0, Math.ceil(previousHeight - spareScroll + (saved.scroll.length ? 1 : 0)))}px`;
      renderedTab = activeTab;
      for (const detail of content.querySelectorAll('details')) {
        const key = detail.dataset.detailKey || `${activeTab}/${detail.className}/${detail.querySelector('summary')?.textContent}`;
        if (detailState.has(key)) detail.open = detailState.get(key);
      }
      identifyContent();
      for (const [tab, control] of tabControls) {
        control.textContent = t(`plugins.catalog.${tab}`);
        if (tab === 'installed') {
          const count = el(document, 'span', 'plugin-tab-count', list.plugins.length);
          count.classList.toggle('is-paused', !list.enabled);
          control.append(count);
          control.setAttribute('aria-label', `${t('plugins.catalog.installed')} · ${t('plugins.ui.count', { count: list.plugins.length })}${list.enabled ? '' : ` · ${t('plugins.ui.paused')}`}`);
        }
        control.setAttribute('aria-selected', String(activeTab === tab));
        control.tabIndex = activeTab === tab ? 0 : -1;
      }
      content.setAttribute('aria-labelledby', tabControls.get(activeTab).id);
      setBusy();
      restorePosition(saved);
    }

    function render() {
      if (!container) return;
      if (actionError && actionError.scope !== errorScope()) actionError = null;
      const saved = rememberPosition();
      reconcileSettings();
      const nodes = [];
      if (!list) {
        const notice = errorNotice();
        container.replaceChildren(...(notice
          ? [notice, button(t('settings.plugins.reload'), () => void run(() => api.list()))]
          : [el(document, 'p', 'settings-note', t('plugins.view.loading'))]));
        return;
      }
      if (!tabs) {
        overview = el(document, 'section', 'plugin-overview');
        const heading = el(document, 'div', 'plugin-overview-heading');
        for (const [tag, className, key] of [
          ['p', 'plugin-overview-summary', 'settings.plugins.overview']
        ]) {
          const node = el(document, tag, className); overviewLabels.set(key, node); heading.append(node);
        }
        const description = el(document, 'p', 'plugin-overview-note');
        overviewLabels.set('settings.plugins.overviewDescription', description);
        const guides = el(document, 'div', 'plugin-guide-links');
        for (const [page, key] of [['plugins', 'settings.plugins.guide'], ['plugin-quickstart', 'settings.plugins.authorGuide']]) {
          const link = el(document, 'a', 'plugin-guide-link');
          link.rel = 'noopener noreferrer';
          link.addEventListener('click', event => {
            event.preventDefault();
            void run(async () => { await onOpenExternal(link.href); return null; });
          });
          overviewLabels.set(key, link); guideLinks.set(page, link); guides.append(link);
        }
        overview.append(heading, description, guides);
        tabs = el(document, 'nav', 'plugin-catalog-tabs');
        tabs.setAttribute('aria-label', t('settings.plugins.title'));
        tabs.setAttribute('role', 'tablist');
        for (const tab of ['installed', 'discover']) {
          const control = button(t(`plugins.catalog.${tab}`), () => {
            if (tab === activeTab) { if (tab === 'installed' && selectedPluginId) closePlugin(); return; }
            void run(async () => {
              // Only switch after the new page is ready; failed loads leave
              // the current page and its drafts intact.
              if (tab !== 'installed') catalogData = api.discoverCatalog ? await api.discoverCatalog() : await api.catalog();
              activeTab = tab; query = ''; sourcesOpen = false; if (tab === 'installed') { selectedPluginId = ''; diagnostics = false; } return null;
            });
          });
          control.dataset.tab = tab;
          control.id = `${container.id || 'plugin-settings'}-tab-${tab}`;
          control.setAttribute('role', 'tab');
          control.setAttribute('aria-controls', `${container.id || 'plugin-settings'}-page`);
          control.addEventListener('keydown', event => {
            const order = [...tabControls.values()], index = order.indexOf(control);
            const target = event.key === 'Home' ? order[0] : event.key === 'End' ? order.at(-1)
              : event.key === 'ArrowRight' ? order[(index + 1) % order.length]
                : event.key === 'ArrowLeft' ? order[(index + order.length - 1) % order.length] : null;
            if (target) { event.preventDefault(); for (const item of order) item.tabIndex = item === target ? 0 : -1; target.focus({ preventScroll: true }); }
          });
          tabControls.set(tab, control); tabs.append(control);
        }
        content = el(document, 'div', 'plugin-settings-content');
        content.id = `${container.id || 'plugin-settings'}-page`;
        content.setAttribute('role', 'tabpanel');
        navigation = el(document, 'div', 'plugin-navigation');
        navigation.append(tabs);
        container.replaceChildren(overview, navigation, content);
      }
      for (const [key, node] of overviewLabels) {
        const label = t(key); if (node.textContent !== label) node.textContent = label;
      }
      const sectionToggle = document.querySelector('[data-settings-section="plugins"]');
      const experimentalBadge = sectionToggle?.querySelector('.plugin-section-experimental');
      if (experimentalBadge && setDetailTooltip) {
        let trigger = sectionToggle.querySelector('.plugin-experimental-tooltip');
        if (!trigger) {
          trigger = el(document, 'span', 'plugin-experimental-tooltip');
          experimentalBadge.before(trigger);
          trigger.append(experimentalBadge);
          // The disclosure remains the sole keyboard stop; only the badge is a hover target.
          sectionToggle.addEventListener('focus', () => trigger.dispatchEvent(new Event('focusin')));
          sectionToggle.addEventListener('blur', () => trigger.dispatchEvent(new Event('focusout')));
          sectionToggle.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
          });
        }
        setDetailTooltip(trigger, [{ full: t('settings.plugins.experimentalNote') }], { centered: true });
        trigger.removeAttribute('tabindex');
        const tooltip = trigger.querySelector('[role="tooltip"]');
        if (tooltip) { tooltip.id = 'plugin-experimental-tip'; sectionToggle.setAttribute('aria-describedby', tooltip.id); }
      }
      for (const [page, link] of guideLinks) link.href = `https://javis-ai.com/token-monitor/docs/${page}.html?lang=${encodeURIComponent(getLocale())}`;
      overview.hidden = activeTab === 'installed' && Boolean(selectedPluginId || aboutOpen);
      // Retain the action slot's geometry across tabs so a shorter catalog
      // cannot clamp scroll and move the tab the user just selected.
      const previousToolbar = navigation.querySelector('.plugin-toolbar');
      if (previousToolbar) {
        previousToolbar.classList.add('is-inactive');
        previousToolbar.setAttribute('inert', '');
        previousToolbar.setAttribute('aria-hidden', 'true');
      }
      if (activeTab !== 'installed') {
        const actions = el(document, 'div', 'plugin-toolbar');
        actions.append(button(t('plugins.package.import'), () => importPackage('file'), 'plugin-inline-action'),
          actionMenu(t('plugins.catalog.advanced'), [[t('plugins.catalog.sources'), () => {
            sourcesOpen = true; render(); content.querySelector('.plugin-back')?.focus({ preventScroll: true });
          }]]));
        if (sourcesOpen || catalogReview) { actions.classList.add('is-inactive'); actions.setAttribute('inert', ''); actions.setAttribute('aria-hidden', 'true'); }
        if (previousToolbar) previousToolbar.replaceWith(actions); else navigation.append(actions);
        if (sourcesOpen) nodes.push(sourcesPanel());
        else if (catalogReview) nodes.push(catalogReviewPanel());
        else nodes.push(catalogPanel());
        replaceContent(nodes, saved); return;
      }
      if (aboutOpen) {
        nodes.push(authoringPanel()); replaceContent(nodes, saved); return;
      }
      if (selectedPluginId) {
        const plugin = list.plugins.find(item => item.id === selectedPluginId);
        if (plugin) {
          if (packagePreview) nodes.push(packagePanel());
          nodes.push(pluginDetail(plugin)); replaceContent(nodes, saved); return;
        }
        selectedPluginId = ''; diagnostics = false;
      }
      if (list.safeMode) nodes.push(el(document, 'p', 'plugin-banner', t('settings.plugins.safeMode')));
      const actions = el(document, 'div', 'plugin-toolbar');
      const countText = t('plugins.ui.count', { count: list.plugins.length });
      const count = el(document, 'span', 'plugin-toolbar-count', countText);
      count.setAttribute('role', 'status'); count.setAttribute('aria-atomic', 'true');
      if (!list.enabled) {
        count.append(document.createTextNode(' · '), el(document, 'span', 'plugin-paused', t('plugins.ui.pausedShort')));
        count.setAttribute('aria-label', `${countText} · ${t('plugins.ui.paused')}`);
      }
      actions.append(count,
        button(t('plugins.package.import'), () => importPackage('file'), 'plugin-inline-action'),
        actionMenu(t('plugins.ui.more'), [
          [t('plugins.package.importFolder'), () => importPackage('directory')],
          [t('settings.plugins.openFolder'), () => void run(async () => { await api.openFolder(); return null; })],
          [t('settings.plugins.reload'), () => void run(() => api.reload())],
          [t('plugins.ui.about'), () => { aboutOpen = true; render(); content.querySelector('.plugin-back')?.focus({ preventScroll: true }); }]
        ], globalSwitch()));
      if (previousToolbar) previousToolbar.replaceWith(actions);
      else navigation.append(actions);
      if (packagePreview) nodes.push(packagePanel());
      if (!list.plugins.length) nodes.push(el(document, 'p', 'settings-note', t('settings.plugins.empty')));
      for (const plugin of [...list.plugins].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
        nodes.push(pluginCard(plugin));
      }
      replaceContent(nodes, saved);
    }

    return {
      async refresh() {
        try {
          list = await api.list();
          if (api.catalog) catalogData = await api.catalog();
          if (actionError?.load) actionError = null;
        } catch (error) {
          actionError = { error, target: '', scope: errorScope(), load: true };
        }
        render();
      },
      render,
      dispose() { catalogModal?.close(); authorSettings.clear(); for (const held of settingsMounts.values()) unmountSettings(held.node); settingsMounts.clear(); },
      summary() {
        if (!list) return '';
        const active = list.plugins.filter((plugin) => plugin.status === 'active').length;
        return list.enabled ? t('settings.summary.plugins', { active, total: list.plugins.length }) : t('settings.summary.off');
      },
      list: () => list,
      // Consent and logs are interaction state: a background push must not
      // close an open consent panel the user is reading.
      isInteracting: () => activeTab === 'style' || Boolean(catalogModal || consentFor || packagePreview || operation || selectedPluginId || aboutOpen) || busy || Boolean(container.querySelector('.plugin-menu:popover-open, .plugin-location-count [role="tooltip"]:popover-open')) || container.contains(document.activeElement)
    };
  }

  return { SURFACE_ORDER, actionErrorMessage, createPluginSettingsPanel };
});
