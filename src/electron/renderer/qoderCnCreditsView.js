'use strict';

(function exposeQoderCnCreditsView(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorQoderCnCreditsView = api;
})(typeof window !== 'undefined' ? window : null, function createQoderCnCreditsViewApi() {
  function renderQoderCnCredits(summary, { document, t, formatNumber, formatCredits }) {
    if (!summary?.available) return null;
    const section = document.createElement('section');
    section.className = 'home-module home-module-credits';
    const heading = document.createElement('h3');
    heading.className = 'home-module-label';
    heading.textContent = t('qoderCnCredits.title');
    const total = document.createElement('div');
    total.className = 'qodercn-credits-total';
    total.textContent = `${summary.hasData ? formatCredits(summary.credits) : '—'} credits`;
    const requests = document.createElement('div');
    requests.className = 'home-module-meta';
    requests.textContent = summary.hasData ? t('qoderCnCredits.requests', { n: formatNumber(summary.requests) }) : '';
    const body = document.createElement('div');
    body.className = 'home-module-body';
    for (const row of summary.models) {
      const item = document.createElement('div');
      item.className = 'home-list-row qodercn-credit-model';
      const name = document.createElement('span');
      name.className = 'home-list-name';
      name.textContent = row.model;
      const value = document.createElement('span');
      value.className = 'home-list-value';
      value.textContent = formatCredits(row.credits);
      value.title = t('qoderCnCredits.requests', { n: formatNumber(row.requests) });
      item.append(name, value);
      body.append(item);
    }
    const note = document.createElement('p');
    note.className = 'qodercn-credits-note';
    note.textContent = t(summary.failed ? 'qoderCnCredits.failed' : summary.requests ? 'qoderCnCredits.source' : 'qoderCnCredits.empty');
    if (summary.failed) {
      note.className += ' is-error';
      note.setAttribute('role', 'status');
    }
    section.append(heading, total, requests, body, note);
    return section;
  }

  return { renderQoderCnCredits };
});
