/* global state, surface, render, ringNumberAnimations, appendLiveRate, t, document, requestAnimationFrame, MouseEvent, PointerEvent */
'use strict';
(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (surface === 'rail') {
    const cell = document.querySelector('.edge-dock-cell'); cell.tabIndex = 0; cell.focus();
    for (let i = 0; i < 2; i++) {
      state.payload.cells[0].totalTokens = 200 + i;
      render(state.payload); await settle();
      assert(document.querySelector('.edge-dock-cell') === cell, 'rail cell identity');
      assert(document.activeElement === cell, 'rail cell focus survives pushes');
    }
    const host = document.createElement('div'); document.body.append(host);
    const readout = document.createElement('span'); readout.dataset.key = 'counter'; readout.textContent = '100';
    const outlet = document.createElement('input'); outlet.value = 'draft';
    const dom = window.TokenMonitorDomReconcile.create({ nodesFor: node => node === readout ? [outlet] : [] });
    dom.reconcileChildren(host, [readout]); outlet.focus();
    for (const mode of ['count', 'roll']) {
      const from = Number(readout.textContent), to = from + 100;
      const animation = window.TokenMonitorTokenNumberAnimation;
      const done = mode === 'count' ? animation.beginCount(readout, from, to, String) : animation.beginRoll(readout, String(from), String(to), true);
      done();
      for (let push = 0; push < 2; push++) {
        const next = document.createElement('span'); next.dataset.key = 'counter'; next.textContent = String(to);
        dom.reconcileChildren(host, [next]);
        assert(readout.textContent === String(to), `${mode} settled text stays exact across unchanged pushes`);
        assert(host.firstChild === readout && outlet.value === 'draft' && document.activeElement === outlet, 'animation replacement keeps the readout and genuine plugin sibling');
      }
    }
    host.remove();
    const record = { provider: 'codex', accountKey: 'ring-loop', status: 'ok', windows: [{ kind: 'session', remainingPercent: 5, resetsAt: '2026-01-01T00:00:00Z' }] };
    const indicatorSessions = [];
    const payload = { ...state.payload, appearance: { ...state.payload.appearance, reduceMotion: 'off' } };
    const push = () => {
      payload.cells = window.TokenMonitorEdgeDockPresentation.buildEdgeDockCells({ limits: { providers: [record] } }, { items: [{ type: 'limit', provider: 'codex' }] });
      payload.cells[0].sessions = indicatorSessions;
      render(payload);
    };
    push(); await settle();
    record.windows[0].remainingPercent = 100; record.windows[0].resetsAt = '2026-01-02T00:00:00Z'; push(); await settle();
    const value = document.querySelector('.edge-dock-value');
    assert(ringNumberAnimations.has(value), 'actual rail reset starts a percentage loop');
    const ring = document.querySelector('.edge-dock-ring');
    assert(ring.querySelectorAll('.edge-dock-ring-complete').length === 1, 'actual rail refill has one completion effect');
    push(); await settle();
    assert(document.querySelector('.edge-dock-ring') === ring && ring.querySelectorAll('.edge-dock-ring-complete').length === 1, 'unchanged rail refresh retains the ring without stacking flares');
    record.windows[0].remainingPercent = 20; push(); await settle();
    assert(document.querySelector('.edge-dock-value') === value && !ringNumberAnimations.has(value), 'actual non-reset rail render cancels the old percentage loop');
    assert(!document.querySelector('.edge-dock-ring-fill').getAnimations().some(animation => animation.constructor.name === 'Animation' && animation.playState === 'running'), 'non-reset rail render cancels the superseded refill arc');
    assert(!ring.querySelector('.edge-dock-ring-complete'), 'non-reset rail render removes the superseded completion flare');
    await new Promise(resolve => setTimeout(resolve, 1800));
    assert(value.textContent === '20%', 'superseded rail loop cannot overwrite the settled current reading');
    for (const activity of ['waiting', 'running']) {
      indicatorSessions.splice(0, indicatorSessions.length, { key: 'codex:indicator', client: 'codex', sessionId: 'indicator', totalTokens: 1, lastUsedAt: new Date().toISOString(), liveActivity: { state: activity, observedAt: new Date().toISOString() } });
      push(); await settle();
      const selector = activity === 'waiting' ? '.edge-dock-ring-waiting' : '.edge-dock-ring-spinner';
      const indicator = ring.querySelector(selector), animation = indicator.getAnimations().find(animation => animation.animationName);
      assert(animation?.playState === 'running', `${activity} indicator really animates`);
      for (let i = 0; i < 2; i++) {
        push(); await settle();
        assert(ring.querySelector(selector) === indicator && indicator.getAnimations().includes(animation) && animation.playState === 'running', `${activity} CSS animation survives two rail pushes`);
      }
    }
    return 'PASS actual rail cell identity and focus';
  }
  const row = { key: 'codex:dom-proof', client: 'codex', sessionId: 'dom-proof', title: 'An intentionally long ongoing engineering task title for reading across updates',
    totalTokens: 100, models: { 'gpt-5': 70, 'gpt-5-mini': 30 }, lastUsedAt: new Date().toISOString(), liveActivity: { state: 'running', observedAt: new Date().toISOString() } };
  const rows = [row];
  const next = { ...state.payload, appearance: { ...state.payload.appearance, reduceMotion: 'off' } };
  if (surface === 'bubble') next.cell = { ...next.cell, metric: 'sessions', sessions: rows };
  else next.cells = [{ id: 'stat:today', kind: 'stat', metric: 'tokens', available: true, totalTokens: 100, clients: [], models: [] }, { id: 'stat:sessions', kind: 'stat', metric: 'sessions', sessions: rows }];
  render(next); await settle();
  if (surface === 'notch') {
    document.querySelector('.notch-tab[data-page="sessions"]').click(); await settle();
  }
  const titleSelector = surface === 'bubble' ? '.edge-dock-session-title' : '.notch-active-title';
  const title = document.querySelector(titleSelector);
  assert(title, `${surface} session title exists`);
  const model = title.closest(surface === 'bubble' ? '.edge-dock-session' : '.notch-active').querySelector('.session-models');
  assert(model, `${surface} model tooltip exists`);
  model.focus();
  const tooltip = model.querySelector('[popover]');
  assert(tooltip?.matches(':popover-open'), `${surface} model tooltip opens`);
  title.dispatchEvent(new MouseEvent('mouseenter'));
  for (let i = 0; i < 2; i++) {
    const before = tooltip.textContent;
    row.totalTokens += 100; row.models['gpt-5-mini'] += 100;
    render(next); await settle();
    assert(document.querySelector(titleSelector) === title, `${surface} title identity`);
    assert(document.querySelector(titleSelector).closest(surface === 'bubble' ? '.edge-dock-session' : '.notch-active').querySelector('.session-models') === model, `${surface} model identity`);
    assert(document.activeElement === model && tooltip.matches(':popover-open'), `${surface} focused tooltip retained`);
    assert(tooltip.textContent !== before, `${surface} focused tooltip receives live readings`);
  }
  assert(title.classList.contains('is-hover-reading'), `${surface} marquee retained`);
  rows.unshift({ ...row, key: 'codex:inserted', sessionId: 'inserted', title: 'Inserted session' });
  render(next); await settle();
  assert(title.isConnected && document.activeElement === model, `${surface} focused session survives insertion before it`);
  rows.reverse(); render(next); await settle();
  assert(title.isConnected && document.activeElement === model, `${surface} focused session survives reorder`);
  if (surface === 'notch') {
    document.querySelector('.notch-tab[data-page="home"]').click(); await settle();
    const day = document.querySelector('.notch-day');
    if (day) {
      day.dispatchEvent(new PointerEvent('pointerenter'));
      const main = document.querySelector('.notch-home-main');
      render(next); await settle();
      assert(document.querySelector('.notch-home-main') === main, 'Notch Home updates without replacing a scrubbed page');
    }
    next.appearance = { ...next.appearance, reduceMotion: 'on' };
    next.cells.find(cell => cell.id === 'stat:sessions').sessions = [
      ...Array.from({ length: 12 }, (_, index) => ({ ...row, key: `active-${index}`, sessionId: `active-${index}` })),
      ...Array.from({ length: 12 }, (_, index) => ({ ...row, key: `recent-${index}`, sessionId: `recent-${index}`, liveActivity: null, lastUsedAt: '2026-10-01T00:00:00Z' }))
    ];
    render(next); document.querySelector('.notch-tab[data-page="sessions"]').click(); await settle();
    const active = document.querySelector('.notch-active-list'), recent = document.querySelector('.notch-recent-list');
    assert(active.scrollHeight > active.clientHeight && recent.scrollHeight > recent.clientHeight, 'both session lists really overflow');
    active.scrollTop = 100; recent.scrollTop = 75;
    document.querySelector('.notch-tab[data-page="home"]').click(); await settle();
    next.expanded = false; render(next); await settle();
    next.expanded = true; render(next); await settle();
    assert(!active.isConnected && !recent.isConnected, 'reopen retires the hidden Sessions tree');
    document.querySelector('.notch-tab[data-page="sessions"]').click(); await settle();
    assert(document.querySelector('.notch-active-list').scrollTop === 100 && document.querySelector('.notch-recent-list').scrollTop === 75, 'retired session lists regain saved scroll after mounting');
  }
  if (surface === 'notch') {
    next.cells.push({ id: 'stat:month', available: true, totalTokens: 200, clients: [], models: [] });
    render(next); document.querySelector('.notch-tab[data-page="breakdown"]').click(); await settle();
    const group = document.querySelector('.notch-page-breakdown .notch-segmented');
    const pill = group.querySelector('.notch-segmented-pill');
    const before = pill.style.transform;
    const button = group.querySelectorAll('button')[1]; button.focus(); button.click(); await settle();
    assert(document.activeElement === button, 'Notch segmented control retains focus on selection');
    assert(pill.style.transform !== before, 'Notch segment pill measures retained live controls');
    const figure = document.querySelector('.notch-breakdown-tokens');
    figure.closest('.notch-breakdown-total').style.maxWidth = '180px';
    next.cells.find(cell => cell.id === 'stat:month').totalTokens = 123456789012;
    render(next); await settle();
    assert(document.querySelector('.notch-breakdown-tokens') === figure, 'Notch Breakdown figure retained');
    assert(figure.clientWidth > 0 && parseFloat(figure.style.fontSize) < 30, `Notch Breakdown fits its mounted figure: ${JSON.stringify({ width: figure.clientWidth, scroll: figure.scrollWidth, size: figure.style.fontSize, text: figure.textContent, connected: figure.isConnected })}`);
  }
  if (surface === 'bubble') {
    const dom = window.TokenMonitorDomReconcile.create();
    const build = rateMode => {
      const card = document.createElement('section'), head = document.createElement('header'); card.append(head);
      appendLiveRate(card, head, { rateMode, rate: 12, speed: 12, burn: 24, deviceCount: 1, rateDevices: [], rateHistory: [] });
      return card;
    };
    const card = dom.reconcile(null, build('speed')); document.body.append(card);
    const figure = card.querySelector('.edge-dock-rate-figure');
    for (const mode of ['burn', 'speed']) {
      dom.reconcile(card, build(mode));
      figure.click();
      assert(figure.querySelector('.edge-dock-rate-unit').textContent === t(mode === 'burn' ? 'edgeDock.rate.speedUnit' : 'edgeDock.rate.burnUnit'), 'retained rate toggle uses the current mode');
    }
    card.remove();
  }
  return `PASS actual ${surface} title, model tooltip, focus and live pushes`;
})()
