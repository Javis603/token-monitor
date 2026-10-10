'use strict';
(function (root) {
  function createPanel({ container, t, fetchStats, getSessions, visible, formatTokens }) {
    let scope = 'session';
    let selected = '';
    let data = null;
    let busy = false;
    let lastFetch = 0;
    let timer = null;
    let error = false;
    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const speed = value => value === null || value === undefined ? '— tok/s'
      : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })} tok/s`;
    const duration = value => {
      if (value === null || value === undefined) return '—';
      const seconds = Math.floor(Math.max(0, value) / 1000);
      return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
        : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    };
    function choose(key) { selected = key; scope = 'session'; draw(); }
    function rowNode(title, subtitle, value, callback, focusKey) {
      const row = el('div', 'detail-exchange task-speed-row');
      const label = el('div', 'detail-ex-label');
      label.append(el('span', 'detail-ex-title', title), el('span', 'detail-ex-sub', subtitle));
      row.append(label, el('span', 'detail-ex-value', speed(value)));
      if (callback) {
        row.dataset.taskSpeedFocus = focusKey;
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.addEventListener('click', callback);
        row.addEventListener('keydown', event => { if (event.key === 'Enter') callback(); });
      }
      return row;
    }
    function draw() {
      if (!visible() || container.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
      const focusKey = container.contains(document.activeElement) ? document.activeElement.dataset.taskSpeedFocus : '';
      drawContents();
      if (focusKey) {
        const controls = [...container.querySelectorAll('[data-task-speed-focus]')];
        const target = controls.find(node => node.dataset.taskSpeedFocus === focusKey)
          || controls.find(node => node.dataset.taskSpeedFocus === `scope:${scope}`);
        target?.focus({ preventScroll: true });
      }
    }
    function drawContents() {
      container.replaceChildren();
      const tabs = el('div', 'task-speed-tabs');
      for (const [id, key] of [['task', 'currentTask'], ['session', 'currentSession'], ['all', 'allSessions']]) {
        const button = el('button', `task-speed-tab${scope === id ? ' is-active' : ''}`, t(`taskSpeed.${key}`));
        button.type = 'button';
        button.dataset.taskSpeedFocus = `scope:${id}`;
        button.setAttribute('aria-pressed', String(scope === id));
        button.addEventListener('click', () => { scope = id; draw(); });
        tabs.append(button);
      }
      container.append(tabs);
      if (!data) { container.append(el('div', 'detail-note', t(error ? 'taskSpeed.failed' : 'detailLoading'))); return; }
      const sessions = data.sessions;
      if (!sessions.some(session => session.key === selected)) selected = sessions[0]?.key || '';
      const session = sessions.find(session => session.key === selected);
      if (scope !== 'all') {
        const picker = el('select', 'task-speed-select');
        picker.setAttribute('aria-label', t('taskSpeed.currentSession'));
        for (const entry of sessions) {
          const option = el('option', '', `${entry.client === 'codex' ? 'Codex' : 'Antigravity'} · ${entry.title || t('taskSpeed.untitled')}`);
          option.value = entry.key;
          option.selected = entry.key === selected;
          picker.append(option);
        }
        picker.addEventListener('change', () => { selected = picker.value; picker.blur(); draw(); });
        container.append(picker);
      }
      const tasks = [...(session?.tasks || [])].sort((a, b) => b.startedAt - a.startedAt);
      const current = tasks[0];
      const summary = scope === 'all' ? data.overall : scope === 'session' ? session
        : current ? { speed: current.speed, durationMs: current.durationMs, outputTokens: current.outputTokens,
            taskCount: 1, measuredCount: current.speed === null ? 0 : 1 } : null;
      if (!summary) { container.append(el('div', 'detail-note', t('detailEmpty'))); return; }
      const headline = el('div', 'task-speed-headline');
      headline.append(el('strong', '', speed(summary.speed)), el('span', 'detail-ex-sub', t('taskSpeed.average')));
      container.append(headline);
      const stats = el('div', 'trends-stats task-speed-stats');
      for (const [label, value] of [
        [t('taskSpeed.output'), summary.measuredCount > 0 ? formatTokens(summary.outputTokens || 0) : '—'],
        [t('taskSpeed.elapsed'), duration(summary.durationMs)],
        [t('taskSpeed.tasks'), `${summary.measuredCount || 0}/${summary.taskCount || 0}`]
      ]) {
        const card = el('div', 'trends-stat');
        card.append(el('span', 'trends-stat-v', value), el('span', 'trends-stat-k', label));
        stats.append(card);
      }
      container.append(stats, el('div', 'task-speed-note', t('taskSpeed.note')));
      const list = el('div', 'task-speed-list');
      if (scope === 'all') {
        for (const entry of sessions) list.append(rowNode(entry.title || t('taskSpeed.untitled'),
          `${entry.client === 'codex' ? 'Codex' : 'Antigravity'} · ${entry.taskCount > 0 ? `${entry.taskCount} ${t('taskSpeed.tasks')}` : t('detailNotFound')}`,
          entry.speed, () => choose(entry.key), `session:${entry.key}`));
      } else {
        for (const [index, task] of (scope === 'task' ? current ? [current] : [] : tasks).entries()) {
          const date = task.startedAt ? new Date(task.startedAt).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
          const status = t(`taskSpeed.${task.status === 'running' ? 'running' : task.status === 'failed' ? 'failedTask' : task.status === 'interrupted' ? 'interrupted' : 'recorded'}`);
          list.append(rowNode(task.title || `${t('taskSpeed.currentTask')} ${index + 1}`,
            `${date} · ${status} · ${duration(task.durationMs)} · ${task.tokensAvailable ? formatTokens(task.outputTokens) : '—'} tok`, task.speed));
        }
      }
      container.append(list);
    }
    async function refresh(force = false) {
      if (!visible() || busy || !force && Date.now() - lastFetch < 5000) return;
      const sessions = getSessions();
      if (!sessions.length) {
        if (!data) { data = { sessions: [], overall: null }; error = false; draw(); }
        return;
      }
      busy = true;
      lastFetch = Date.now();
      try { data = await fetchStats({ sessions }); error = false; }
      catch (_) { error = true; }
      finally { busy = false; draw(); }
    }
    function render() {
      draw();
      void refresh();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { if (visible()) render(); }, 5000);
    }
    return { render, choose, refresh };
  }
  root.TokenMonitorTaskSpeed = { createPanel };
})(window);
