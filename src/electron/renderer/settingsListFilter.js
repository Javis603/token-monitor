'use strict';

// Text filter shared by the settings lists that are long enough to need one
// (tracked tools, limit providers). The lists differ in every other respect —
// row shape, ordering setting, drag commit — so only the matching rule is
// factored out, deliberately matching the tray composer's picker search:
// one case-insensitive substring over the row's searchable text, no token
// splitting and no fuzzy matching, so a query means the same thing everywhere
// in the app.
(function exposeSettingsListFilter(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorSettingsListFilter = api;
})(typeof window !== 'undefined' ? window : null, function createSettingsListFilterApi() {
  // `toLocaleLowerCase` rather than `toLowerCase`: the labels are localized and
  // the query is typed in the same locale, so folding must follow it too.
  function normalizeListQuery(value) {
    return String(value ?? '').trim().toLocaleLowerCase();
  }

  function listTextMatches(text, query) {
    const normalized = normalizeListQuery(query);
    if (!normalized) return true;
    return String(text ?? '').toLocaleLowerCase().includes(normalized);
  }

  // `toText` returns the row's searchable text. Both call sites include the
  // client/provider id next to the label so a query still lands when the two
  // disagree (`zai` vs "z.ai") or when the UI is running in a locale whose
  // label is not what the user thinks of the tool as.
  function filterListItems(items, query, toText) {
    const normalized = normalizeListQuery(query);
    if (!normalized) return Array.isArray(items) ? items : [];
    return (items || []).filter((item) => listTextMatches(toText(item), normalized));
  }

  return { normalizeListQuery, listTextMatches, filterListItems };
});
