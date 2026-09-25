'use strict';

// How each vendor mark looks: brand colour, artwork files and the macOS
// widget's variant of the colour. One entry per mark id, in the order the
// appearance picker lists them (tracked clients first, in catalog order).
//
// A mark id is a tracked client, a model vendor that modelVendorFor() resolves
// to, or a limits provider — three domains that share one string and one mark,
// which is why this is its own table rather than a field on the client catalog
// or the limits registry. Labels are not repeated here for catalog ids: the
// catalog already names them, so an entry only carries `label` for an id no
// catalog owns.
//
// Fields, all optional except `id`:
//   label        display name for an id the client catalog does not name
//   color        brand colour; an entry with one is a vendor the appearance
//                picker lists and the user can override (the override keys are
//                persisted, so removing a colour drops a user's setting)
//   icon         artwork file stem in assets/icons when it is not the id
//   mask         file the renderer masks rows with, when it is not `icon`
//                (grok and xai swap artwork between the two)
//   trayIcon     file the tray rasterizes, when it is not `icon`
//   widgetColor  the widget's colour when it differs from `color`: the widget
//                paints bars on a dark surface, so deep brand colours are lifted
//   widgetInk    the mark is near-black, so the widget draws it in the adaptive
//                light ink instead of a colour that would vanish on dark
//
// Pure data, no DOM and no Node built-ins: the renderer loads it as a plain
// <script> after clientCatalog.js, and main requires it for the widget snapshot.
(function exposeVendorPresentation(root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./clientCatalog') : root?.TokenMonitorClientCatalog);
  if (node) module.exports = api;
  if (root) root.TokenMonitorVendorPresentation = api;
})(typeof window !== 'undefined' ? window : globalThis, function createVendorPresentationApi(clientCatalog) {
  const VENDOR_PRESENTATION = Object.freeze([
    { id: 'claude', color: '#cc7c5e', trayIcon: 'tray-claude' },
    { id: 'codex', color: '#49a3b0', trayIcon: 'tray-codex' },
    { id: 'opencode', color: '#000000', widgetInk: true },
    { id: 'hermes', color: '#d4af37', icon: 'hermes-agent' },
    { id: 'openclaw', color: '#ff4d4d' },
    { id: 'cursor', color: '#000000', widgetInk: true },
    { id: 'antigravity', color: '#4285f4' },
    { id: 'cline', color: '#9D4EDD', widgetColor: '#53616D' },
    { id: 'amp', color: '#F34E3F' },
    { id: 'droid', color: '#000000', widgetInk: true },
    { id: 'kimi', color: '#16191e', widgetInk: true },
    { id: 'qwen', color: '#615ced', widgetColor: '#7771F4' },
    { id: 'grok', color: '#000000', mask: 'xai', widgetInk: true },
    { id: 'copilot', color: '#000000', widgetInk: true },
    { id: 'gcmp', color: '#3B82F6' },
    { id: 'pi', color: '#000', widgetInk: true },
    { id: 'omp', color: '#ED4ABF' },
    { id: 'zed', color: '#4173e7', widgetColor: '#5C8BFF' },
    { id: 'kilo', color: '#F8F676' },
    { id: 'commandcode', color: '#8C4EDD', widgetColor: '#9D66E7' },
    { id: 'mimo', color: '#000000', icon: 'xiaomi', widgetInk: true },
    { id: 'zcode', color: '#000000', icon: 'zai', widgetInk: true },
    { id: 'kiro', color: '#9046FF', widgetColor: '#A66AFF' },
    { id: 'codebuddy', color: '#6C4DFF', widgetColor: '#8064FF' },
    { id: 'workbuddy', color: '#0DC8A5' },
    { id: 'proma', color: '#000000', widgetInk: true },
    { id: 'qodercn', color: '#2ADB5C' },
    { id: 'reasonix', color: '#4d6bfe' },
    { id: 'dsh', color: '#4d6bfe' },
    { id: 'cherrystudio', color: '#EA5E5D' },
    { id: 'lmstudio', color: '#6C5CE7', widgetColor: '#8074E8' },
    { id: 'unsloth', color: '#40B85A' },
    { id: 'devin', color: '#000000', widgetInk: true },
    // Not tracked clients: model vendors and limits providers. A vendor shares
    // the colour of the client it names (moonshot/kimi, zai/zaiteam, xai/grok).
    { id: 'openrouter', label: 'OpenRouter', color: '#6566F1' },
    { id: 'gemini', color: '#4285f4' },
    { id: 'qoder', label: 'Qoder', color: '#2ADB5C' },
    { id: 'deepseek', label: 'DeepSeek', color: '#4d6bfe' },
    { id: 'xai', label: 'xAI', color: '#000000', mask: 'grok', widgetInk: true },
    { id: 'meta', label: 'Meta', color: '#1d65c1', widgetColor: '#4385DB' },
    { id: 'mistral', label: 'Mistral', color: '#fa520f' },
    { id: 'moonshot', label: 'Moonshot', color: '#16191e', widgetInk: true },
    { id: 'zai', label: 'GLM', color: '#000000', widgetInk: true },
    { id: 'zaiteam', label: 'GLM Team', color: '#000000', icon: 'zai', widgetInk: true },
    { id: 'cohere', label: 'Cohere', color: '#39594d', widgetColor: '#66937D' },
    { id: 'xiaomi', label: 'Xiaomi', color: '#000000', widgetInk: true },
    { id: 'minimax', label: 'MiniMax', color: '#f23f5d' },
    { id: 'doubao', label: 'Doubao', color: '#1E37FC', widgetColor: '#5064FF' },
    { id: 'hunyuan', label: 'Hunyuan', color: '#0053E0', widgetColor: '#277DE3' },
    { id: 'volcengine', label: 'Volcengine', color: '#006EFF', widgetColor: '#2A88FF' },
    { id: 'ollama', label: 'Ollama', color: '#888888', widgetInk: true },
    { id: 'trae', label: 'Trae CN', color: '#32F08C' },
    { id: 'alibaba', label: 'Alibaba Cloud', color: '#615CED', widgetColor: '#7771F4' },
    { id: 'nvidia', label: 'NVIDIA', color: '#74B71B' },
    { id: 'stepfun', label: 'StepFun', color: '#000000', widgetInk: true },
    { id: 'typesafe', label: 'TypeSafe', color: '#000000', widgetInk: true },
    { id: 'thirdparty', label: 'Third-party APIs', color: '#8090A6' },
    // Marks without a colour of their own. Factory is the limits provider for
    // the Droid client and borrows its mark; the relays only ever appear as a
    // Limits row.
    { id: 'factory', icon: 'droid', widgetInk: true },
    { id: 'newapi' },
    { id: 'sub2api' }
  ].map((entry) => Object.freeze(entry)));

  // What an id with no entry, or an unrecognised model, is painted with.
  const DEFAULT_VENDOR_COLOR = '#6ab4f0';

  const byId = new Map(VENDOR_PRESENTATION.map((entry) => [entry.id, entry]));
  const clientLabels = clientCatalog?.CLIENT_LABELS || {};

  // The vendors the appearance picker lists, in order.
  const VENDOR_IDS = Object.freeze(VENDOR_PRESENTATION.filter((entry) => entry.color).map((entry) => entry.id));

  const VENDOR_LABELS = Object.freeze({
    ...Object.fromEntries(VENDOR_IDS.map((id) => [id, byId.get(id).label || clientLabels[id]])),
    default: 'Default'
  });

  // Every id that has a mark. Limits rows can show all of them; usage rows only
  // ever carry the coloured ones.
  const MARK_IDS = Object.freeze(VENDOR_PRESENTATION.map((entry) => entry.id));

  function iconFile(entry) {
    return entry.icon || entry.id;
  }

  const ROW_ICON_MASKS = Object.freeze(Object.fromEntries(
    VENDOR_PRESENTATION.map((entry) => [entry.id, entry.mask || iconFile(entry)])
  ));

  // A fresh, mutable map: the renderers apply the user's vendor-colour
  // overrides onto it in place.
  function vendorColors() {
    return {
      ...Object.fromEntries(VENDOR_IDS.map((id) => [id, byId.get(id).color])),
      default: DEFAULT_VENDOR_COLOR
    };
  }

  function trayIconFile(id) {
    const entry = byId.get(id);
    return entry ? entry.trayIcon || iconFile(entry) : id;
  }

  // What the macOS widget needs to paint a mark, written into its snapshot so
  // the Swift side keeps no table of its own. Entries that would only restate
  // the defaults (colour `default`, artwork named after the id) are left out.
  function widgetVendorPalette() {
    const palette = { default: { color: DEFAULT_VENDOR_COLOR } };
    for (const entry of VENDOR_PRESENTATION) {
      const style = {};
      if (entry.widgetInk) style.ink = true;
      else if (entry.widgetColor || entry.color) style.color = entry.widgetColor || entry.color;
      if (iconFile(entry) !== entry.id) style.icon = iconFile(entry);
      if (Object.keys(style).length) palette[entry.id] = style;
    }
    return palette;
  }

  return {
    DEFAULT_VENDOR_COLOR,
    MARK_IDS,
    ROW_ICON_MASKS,
    VENDOR_IDS,
    VENDOR_LABELS,
    VENDOR_PRESENTATION,
    trayIconFile,
    vendorColors,
    widgetVendorPalette
  };
});
