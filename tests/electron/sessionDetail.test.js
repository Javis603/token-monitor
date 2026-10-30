'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { exchangeRows, formatToolList } = require('../../src/electron/renderer/sessionDetail');
const { translate } = require('../../src/electron/renderer/i18n');

const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

test('session detail renders its heading before loading, errors and empty results, and keeps it when sorting', async () => {
  const timers = [];
  const frames = [];
  let reducedMotion = false;
  function element() {
    const classes = new Set();
    return {
      children: [], isConnected: true, scrollLeft: 0, scrollWidth: 600, clientWidth: 200,
      style: {}, dataset: {}, getBoundingClientRect: () => ({ width: 600 }),
      get childNodes() { return this.children.length ? this.children : [{ textContent: this._text || '' }]; },
      get textContent() { return this.children.length ? this.children.map(node => node.textContent).join('') : this._text || ''; },
      set textContent(value) { this.children = []; this._text = value; },
      closest: () => ({}),
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value), toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value) },
      append(...nodes) { this.children.push(...nodes); nodes.forEach(node => { node.parentElement = this; }); },
      replaceChildren(...nodes) { this.children = nodes; },
      setAttribute(name, value) { (this.attributes ||= {})[name] = value; },
      removeAttribute(name) { delete this[name]; },
      addEventListener(type, handler) { if (type === 'click') this.clickHandler = handler; else this[type] = handler; },
      click() { this.clickHandler?.(); this.parentElement?.click(); },
      querySelector(selector) {
        for (const child of this.children) {
          if (`.${child.className}` === selector) return child;
          const found = child.querySelector?.(selector);
          if (found) return found;
        }
        return null;
      },
      querySelectorAll(selector) {
        return this.children.flatMap(child => [
          ...(`.${child.className}` === selector ? [child] : []),
          ...(child.querySelectorAll?.(selector) || [])
        ]);
      }
    };
  }
  const els = { breakdown: element(), sessionDetail: element(), sessionDetailHead: element() };
  const state = { detailSort: 'tokens', openSession: null };
  const start = rendererSource.indexOf('function renderSessionDetail(');
  const end = rendererSource.indexOf('function sessionGroupRunNode(', start);
  let render;
  const context = {
    els, state, document: { createElement: element, querySelectorAll: () => [els.sessionDetailHead.querySelector('.detail-heading')].filter(Boolean) }, window: { addEventListener() {} }, t: (key, params) => translate('en', key, params),
    sessionDetailBack() { state.backClicked = true; },
    detailNote: text => ({ textContent: text }),
    sessionDetailApi: { exchangeRows: detail => detail?.exchanges || [] },
    sessionRowsApi: require('../../src/electron/renderer/sessionRows'),
    copyToClipboard: (text) => { state.copied = text; },
    exchangeNode: (row, max, expanded) => {
      state.expands = [...(state.expands || []), expanded === true];
      return { textContent: row.title, dataset: { exchangeKey: row.key }, querySelector: () => null };
    },
    prefersReducedMotion: () => reducedMotion,
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout() {},
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {},
    performance: { now: () => 0 },
    toggleDetailSort() {
      state.detailSort = 'time';
      render({ detail: state.openSession.detail });
    }
  };
  const overflowText = require('../../src/electron/renderer/overflowText').create({
    document: context.document,
    window: { ...context, addEventListener() {} },
    prefersReducedMotion: context.prefersReducedMotion
  });
  context.bindHoverMarquee = overflowText.bind;
  vm.runInNewContext(`${rendererSource.slice(start, end)}\nglobalThis.render = renderSessionDetail;`, context);
  render = context.render;
  for (const [options, expected] of [
    [{ error: true }, 'Could not read the transcript. Please try again.'],
    [{ detail: { found: false, error: 'read-failed' } }, 'Could not read the transcript. Please try again.'],
    [{ detail: { found: false, error: 'line-too-large' } }, 'A transcript entry exceeds the 16 MiB limit. Session details cannot be loaded.'],
    [{ detail: { found: false } }, 'Transcript not found on this machine.']
  ]) {
    render(options);
    assert.equal(els.sessionDetail.textContent, expected);
  }
  for (const title of ['gpt-5.6-sol · 12:34', 'A long ordinary session title that exceeds the available header width']) {
    state.openSession = { title, detail: { exchanges: [{ title: 'Reply', value: 10 }] } };
    for (const options of [{ loading: true }, { error: true }, { detail: { found: false } },
      { detail: { exchanges: [] } }, { detail: state.openSession.detail }]) {
      render(options);
      const heading = els.sessionDetailHead.querySelector('.detail-heading');
      assert.equal(heading.textContent, title);
      assert.equal(heading.title, undefined);
      const back = els.sessionDetailHead.children[0];
      assert.equal(back.className, 'detail-back detail-back-titled');
      assert.equal(back.type, 'button');
      assert.equal(back.title, undefined, 'the parent button does not reintroduce a native tooltip');
      assert.equal(back.textContent, `‹${title}`);
      assert.equal(back.querySelector('.detail-back-arrow').textContent, '‹');
      assert.equal(back.querySelector('.detail-back-arrow').attributes['aria-hidden'], 'true');
      assert.equal(heading.parentElement, back);
      assert.equal(back.attributes['aria-label'], `${title} — Back to sessions`);
      heading.click();
      assert.equal(state.backClicked, true);
      state.backClicked = false;
    }
    els.sessionDetailHead.querySelector('.detail-sort').click();
    const heading = els.sessionDetailHead.querySelector('.detail-heading');
    assert.equal(heading.textContent, title);
    while (frames.length) frames.shift()(0);
    assert.equal(heading.classList.contains('has-overflow-fade'), true);
    heading.mouseenter();
    timers.pop()();
    frames.pop()(4000);
    assert.equal(heading.children[0].style.transform, 'translate3d(-400px, 0, 0)', 'hover reveals the clipped title');
    assert.equal(heading.classList.contains('has-overflow-fade'), false, 'the end stays readable after scrolling');
    assert.equal(heading.classList.contains('is-hover-scrolling'), true);
    heading.mouseleave();
    assert.equal(heading.scrollLeft, 0);
    assert.equal(heading.classList.contains('has-overflow-fade'), true);
    assert.equal(heading.classList.contains('is-hover-scrolling'), false);
    reducedMotion = true;
    heading.mouseenter();
    assert.equal(heading.scrollLeft, 0);
    assert.equal(heading.textContent, title, 'full text remains available for manual scrolling');
    assert.equal(heading.title, undefined);
    assert.equal(heading.classList.contains('is-overflow-static'), true);
    reducedMotion = false;
    heading.children[0].getBoundingClientRect = () => ({ width: heading.clientWidth });
    overflowText.update(heading);
    assert.equal(heading.classList.contains('has-overflow-fade'), false, 'fitting text stays opaque');
  }
  // Display preference changes replace only the back/heading node. The loaded body and
  // sort control survive, and a later detail response respects the new policy.
  context.window.TokenMonitorSessionTitleDisplay = require('../../src/electron/sessionTitleDisplay');
  let invalidations = 0;
  let pulls = 0;
  context.tokenNumberAnimationApi = require('../../src/electron/tokenNumberAnimation');
  context.allTimeSessions = { invalidate: () => { invalidations += 1; }, ensure: () => { pulls += 1; } };
  const settingsStart = rendererSource.indexOf('let localSessionActivity = null;');
  const settingsEnd = rendererSource.indexOf('\nfunction render()', settingsStart);
  assert.ok(settingsStart >= 0 && settingsEnd > settingsStart, 'renderer title settings helpers should be present');
  vm.runInNewContext(`${rendererSource.slice(settingsStart, settingsEnd)}\nglobalThis.setSettings = setRendererSettings;`, context);
  state.openSession = { kind: 'session', title: 'PRIVATE TITLE', detail: { exchanges: [{ title: 'Reply', value: 10 }] } };
  state.stats = { periods: { today: { sessions: { s: { title: 'PRIVATE TITLE', totalTokens: 10 } } } } };
  render({ detail: state.openSession.detail });
  const body = els.sessionDetail.children[0];
  const sort = els.sessionDetailHead.querySelector('.detail-sort');
  context.setSettings({ sessionTitlesEnabled: false });
  assert.equal(els.sessionDetailHead.querySelector('.detail-heading'), null);
  assert.equal(els.sessionDetailHead.children[0].attributes['aria-label'], 'Back to sessions');
  assert.strictEqual(els.sessionDetail.children[0], body);
  assert.strictEqual(els.sessionDetailHead.querySelector('.detail-sort'), sort);
  assert.equal(state.stats.periods.today.sessions.s.title, undefined);
  for (const options of [{ loading: true }, { error: true }, { detail: state.openSession.detail }]) {
    render(options);
    assert.doesNotMatch(els.sessionDetailHead.textContent, /PRIVATE/);
    assert.equal(els.sessionDetailHead.querySelector('.detail-heading'), null);
  }
  context.setSettings({ sessionTitlesEnabled: true });
  assert.equal(invalidations, 2, 'both policy changes invalidate the old pull');
  assert.equal(pulls, 2, 're-enabling requests titles without waiting for a stats push');
  const adoptedStats = state.stats;
  context.setSettings({ sessionTitlesEnabled: true });
  assert.strictEqual(state.stats, adoptedStats, 'unrelated settings do not re-project stats');
  assert.equal(pulls, 2);
  assert.equal(els.sessionDetailHead.querySelector('.detail-heading').textContent, 'PRIVATE TITLE');

  // Open real Details while hidden, rather than pre-seeding a cached title.
  const openStart = rendererSource.indexOf('function applySessionDetailResult(');
  const openEnd = rendererSource.indexOf('\nfunction toggleDetailSort', openStart);
  assert.ok(openStart >= 0 && openEnd > openStart, 'detail navigation should be present');
  context.visibleStatsSurface = () => 'main';
  context.renderSessionDetail = render;
  const detailRequest = deferred();
  context.window.tokenMonitor = { getSessionDetail: () => detailRequest.promise };
  vm.runInNewContext(`${rendererSource.slice(openStart, openEnd)}\nglobalThis.open = openSessionDetail;`, context);
  state.period = 'today';
  context.setSettings({ sessionTitlesEnabled: false });
  state.stats = { periods: { today: { sessions: { 'codex:s': { client: 'codex', totalTokens: 10 } } } } };
  const opening = context.open({ client: 'codex', sessionId: 's', title: 'Codex · gpt-5' });
  assert.equal(state.openSession.title, '', 'hidden row text is not stored as a session title');
  assert.equal(els.sessionDetailHead.querySelector('.detail-heading'), null);
  context.setSettings({ sessionTitlesEnabled: true });
  assert.equal(els.sessionDetailHead.querySelector('.detail-heading'), null, 'wait for title-bearing presentation stats');
  state.stats = { periods: { today: { sessions: {
    'claude:s': { title: 'Wrong client' },
    'codex:s': { title: 'Review PR 920', totalTokens: 10 }
  } } } };
  context.refreshSessionDetailHeading();
  assert.equal(els.sessionDetailHead.querySelector('.detail-heading').textContent, 'Review PR 920');
  const loadingBody = els.sessionDetail.children[0];
  const restoredHeading = els.sessionDetailHead.children[0];
  context.refreshSessionDetailHeading();
  assert.strictEqual(els.sessionDetailHead.children[0], restoredHeading, 'unchanged stats preserve heading motion');
  assert.strictEqual(els.sessionDetail.children[0], loadingBody, 'title arrival keeps the loading body');
  detailRequest.resolve({ exchanges: [{ title: 'Reply', value: 10 }] });
  await opening;
  const loadedBody = els.sessionDetail.children[0];
  const restoredSort = els.sessionDetailHead.querySelector('.detail-sort');
  state.stats.periods.today.sessions['codex:s'].title = 'Renamed session';
  context.refreshSessionDetailHeading();
  assert.equal(els.sessionDetailHead.querySelector('.detail-heading').textContent, 'Renamed session');
  assert.strictEqual(els.sessionDetail.children[0], loadedBody);
  assert.strictEqual(els.sessionDetailHead.querySelector('.detail-sort'), restoredSort);
  assert.match(rendererSource, /refreshSessionDetailHeading\(\);\s*if \(state\.openSession\.renderOptions\)/,
    'ordinary Details refresh the heading in the normal render path');

  // A live re-read re-inserts every row, so it has to reopen the exchange the
  // reader had open and keep the reading position.
  state.openSession.detail = { exchanges: [{ key: 'first', title: 'Reply', value: 10, startTime: 111 }] };
  const expandedExchange = element();
  expandedExchange.classList.add('expanded');
  expandedExchange.dataset.exchangeKey = 'first';
  els.sessionDetail.children = [expandedExchange];
  els.sessionDetail.scrollTop = 40;
  els.sessionDetail.scrollHeight = 100;
  state.expands = [];
  render({ detail: state.openSession.detail, preserveScroll: true });
  assert.deepEqual(state.expands, [true], 'a refresh keeps the open exchange expanded');
  assert.equal(els.sessionDetail.scrollTop, 40, 'a refresh keeps the reading position');
  state.openSession.detail = { exchanges: [{ key: 'second', title: 'Reply', value: 10, startTime: 222 }] };
  els.sessionDetail.children = [expandedExchange];
  state.expands = [];
  render({ detail: state.openSession.detail, preserveScroll: true });
  assert.deepEqual(state.expands, [false], 'an exchange the reader never opened stays collapsed');

  state.openSession = { kind: 'session', client: 'reasonix', sessionId: 'reasonix:n', period: 'month', title: '' };
  state.stats = { nativeSessions: { today: { 'reasonix:n': { title: 'Wrong period' } },
    month: { 'reasonix:n': { title: 'Native session' } } } };
  context.refreshSessionDetailHeading();
  assert.equal(els.sessionDetailHead.querySelector('.detail-heading').textContent, 'Native session');
  context.setSettings({ sessionTitlesEnabled: false });
  const groupOpening = context.open({ client: 'codex', sessionId: 's', title: 'gpt-5 · 12:00',
    returnTo: { kind: 'session-group' } });
  assert.equal(els.sessionDetailHead.querySelector('.detail-heading').textContent, 'gpt-5 · 12:00',
    'model/time is not a session title and remains visible while titles are hidden');
  const reviewHeading = els.sessionDetailHead.children[0];
  context.setSettings({ sessionTitlesEnabled: true });
  assert.strictEqual(els.sessionDetailHead.children[0], reviewHeading);
  context.setSettings({ sessionTitlesEnabled: false });
  assert.strictEqual(els.sessionDetailHead.children[0], reviewHeading, 'title toggles preserve the review heading');
  await groupOpening;
  assert.equal(els.sessionDetailHead.querySelector('.detail-heading').textContent, 'gpt-5 · 12:00');
  context.setSettings({ sessionTitlesEnabled: true });

  // A subagent run is headed by its own session title and returns to a group
  // named after the parent's title, so both follow title display.
  const subagentGroup = { kind: 'session-group', period: 'today',
    summary: { key: 'session-group:subagents:codex:parent', name: 'Parent title', subagentGroup: true } };
  context.sessionRowsForPeriod = () => [{ key: subagentGroup.summary.key,
    name: state.settings?.sessionTitlesEnabled === false ? 'Codex · gpt-5' : 'Parent title',
    groupRows: [{ key: 'session:codex:parent' }, { key: 'session:codex:child' }] }];
  state.stats = { periods: { today: { sessions: { 'codex:child': { client: 'codex', title: 'Child title', totalTokens: 3 } } } } };
  const childOpening = context.open({ client: 'codex', sessionId: 'child', title: 'Child title',
    returnTo: subagentGroup, titleFollowsSession: true });
  assert.equal(els.sessionDetailHead.querySelector('.detail-heading').textContent, 'Child title');
  assert.match(els.sessionDetailHead.children[0].attributes['aria-label'], /Back to Parent title/);
  context.setSettings({ sessionTitlesEnabled: false });
  assert.equal(els.sessionDetailHead.querySelector('.detail-heading'), null, 'the child title hides with titles');
  assert.equal(els.sessionDetailHead.children[0].textContent, '‹ Codex · gpt-5');
  assert.doesNotMatch(JSON.stringify(els.sessionDetailHead.children[0].attributes), /Parent title|Child title/);
  assert.equal(subagentGroup.summary.name, 'Codex · gpt-5', 'returning to the group shows the titleless parent name');
  await childOpening;
  assert.equal(els.sessionDetailHead.querySelector('.detail-heading'), null, 'a late detail response keeps it hidden');
  const opened = context.open({ client: 'codex', sessionId: 'child', title: 'Child title',
    returnTo: subagentGroup, titleFollowsSession: true });
  assert.equal(state.openSession.title, '', 'a run opened while hidden stores no title');
  assert.equal(els.sessionDetailHead.querySelector('.detail-heading'), null);
  await opened;
  context.setSettings({ sessionTitlesEnabled: true });

  // The group can vanish while a member's Details stay open: its parent leaves
  // the list, or the session is regrouped under another parent. The cached
  // summary must not keep quoting the old parent title once titles hide.
  const titleless = () => state.settings?.sessionTitlesEnabled === false;
  for (const regrouped of [false, true, 'old group stays']) {
    const staleGroup = { kind: 'session-group', period: 'today',
      summary: { key: 'session-group:subagents:codex:parent', name: 'Parent title', subagentGroup: true,
        groupRows: [{ key: 'session:codex:parent', name: 'Parent title' }, { key: 'session:codex:child', name: 'Child title' }] } };
    context.sessionRowsForPeriod = () => [{ key: subagentGroup.summary.key, name: titleless() ? 'Codex · gpt-5' : 'Parent title',
      groupRows: [{ key: 'session:codex:parent' }, { key: 'session:codex:child' }] }];
    state.stats = { periods: { today: { sessions: { 'codex:child': { client: 'codex', title: 'Child title', totalTokens: 3 } } } } };
    const opening = context.open({ client: 'codex', sessionId: 'child', title: 'Child title',
      returnTo: staleGroup, titleFollowsSession: true });
    assert.match(els.sessionDetailHead.children[0].attributes['aria-label'], /Back to Parent title/);
    const newGroup = { key: 'session-group:subagents:codex:other', subagentGroup: true,
      get name() { return titleless() ? 'Codex · gpt-5.6' : 'Other parent'; },
      groupRows: [{ key: 'session:codex:other' }, { key: 'session:codex:child' }] };
    // 'old group stays': the old parent still has another child, so its group
    // exists under the same key without this session.
    const oldGroupWithoutChild = { key: staleGroup.summary.key, name: 'Codex · gpt-5', subagentGroup: true,
      groupRows: [{ key: 'session:codex:parent' }, { key: 'session:codex:sibling' }] };
    context.sessionRowsForPeriod = () => (regrouped === 'old group stays' ? [oldGroupWithoutChild, newGroup]
      : regrouped ? [newGroup] : [{ key: 'session:codex:child', name: 'Child title' }]);
    context.setSettings({ sessionTitlesEnabled: false });
    const back = els.sessionDetailHead.children[0];
    assert.equal(els.sessionDetailHead.querySelector('.detail-heading'), null);
    assert.doesNotMatch(`${back.textContent} ${JSON.stringify(back.attributes)}`, /Parent title|Child title|Other parent/);
    if (regrouped) {
      assert.equal(state.openSession.returnTo.summary.key, newGroup.key, 'Back returns to the group that holds the session now');
      assert.equal(back.textContent, '‹ Codex · gpt-5.6');
    } else {
      assert.equal(state.openSession.returnTo, null, 'with no group left, Back returns to Sessions');
      assert.equal(back.textContent, '‹ sessions');
    }
    assert.doesNotMatch(JSON.stringify(state.openSession.returnTo || {}), /Parent title|Child title/,
      'no cached member keeps the old titles');
    await opening;
    context.setSettings({ sessionTitlesEnabled: true });
  }

  // The id the Sessions list no longer prints opens the detail body, copyable,
  // in every state the body can be in.
  for (const options of [{ loading: true }, { error: true }, { detail: { exchanges: [{ title: 'Reply', value: 10 }] } }]) {
    state.openSession = { client: 'codex', title: 'Review PR 906', sessionId: 'rollout-2026-09-18T11-44-50-019e76fc-dddd-eeee-ffff-222222222222' };
    render(options);
    const idLine = els.sessionDetail.children[0];
    assert.equal(idLine.className, 'detail-session-id');
    assert.equal(idLine.querySelector('.detail-session-id-text').textContent, '019e76fc-dddd-eeee-ffff-222222222222');
    idLine.querySelector('.detail-session-id-copy').click();
    assert.equal(state.copied, '019e76fc-dddd-eeee-ffff-222222222222');
  }
  const rolloutIds = ['01a084ff-20ff-7563-beb4-045b31e5a47a', '01a0876b-d178-7be2-a485-529a745ea1b0'];
  state.openSession = {
    client: 'codex', title: 'Multi-UUID Codex rollout',
    sessionId: `rollout-2026-09-10T02-33-00-${rolloutIds[0]}_${rolloutIds[1]}`
  };
  for (const options of [{ loading: true }, { error: true }, { detail: { found: false } },
    { detail: { found: true, exchanges: [] } }]) {
    render(options);
    assert.equal(els.sessionDetail.children.filter(node => node.className === 'detail-session-id').length, 0,
      'no copyable identity is guessed before metadata is available');
  }
  for (const canonicalSessionId of rolloutIds) {
    for (const exchanges of [[], [{ title: 'Reply', value: 10 }]]) {
      render({ detail: { found: true, canonicalSessionId, exchanges } });
      const idLines = els.sessionDetail.children.filter(node => node.className === 'detail-session-id');
      assert.equal(idLines.length, 1);
      assert.equal(idLines[0].querySelector('.detail-session-id-text').textContent, canonicalSessionId);
      const copy = idLines[0].querySelector('.detail-session-id-copy');
      assert.equal(copy.attributes['aria-label'], translate('en', 'session.copyId'));
      copy.click();
      assert.equal(state.copied, canonicalSessionId, 'copy metadata identity regardless of filename position');
    }
  }
  state.openSession = {};
  render({ loading: true });
  assert.equal(els.sessionDetail.children[0].className, undefined, 'no id, no line');
  assert.equal(els.sessionDetailHead.querySelector('.detail-heading'), null);
  assert.equal(els.sessionDetailHead.children[0].textContent, '‹ sessions');
  assert.equal(els.sessionDetailHead.children[0].attributes['aria-label'], 'Back to sessions');
  state.openSession = { title: 'gpt-5.6-sol · 12:34', returnTo: { kind: 'session-group' } };
  render({ loading: true });
  assert.equal(els.sessionDetailHead.children[0].attributes['aria-label'], 'gpt-5.6-sol · 12:34 — Back to Codex Auto Review');
  context.closeSessionDetail = () => { state.backClicked = true; };
  const groupStart = rendererSource.indexOf('function renderSessionGroupDetail(');
  const groupEnd = rendererSource.indexOf('function detailNote(', groupStart);
  vm.runInNewContext(`${rendererSource.slice(groupStart, groupEnd)}\nglobalThis.renderGroup = renderSessionGroupDetail;`, context);
  context.renderGroup({ summary: { groupRows: [] } });
  const groupBack = els.sessionDetailHead.children[0];
  assert.equal(groupBack.textContent, '‹Codex Auto Review');
  assert.equal(groupBack.attributes['aria-label'], 'Codex Auto Review — Back to sessions');
  const groupHeading = els.sessionDetailHead.querySelector('.detail-heading');
  assert.equal(groupHeading.textContent, 'Codex Auto Review');
  assert.equal(groupHeading.title, undefined);
  assert.equal(groupBack.title, undefined);
  assert.equal(groupHeading.parentElement, groupBack);
  groupHeading.click();
  assert.equal(state.backClicked, true);
  for (const locale of ['en', 'zh-TW', 'zh-CN', 'ko', 'ja', 'pt-BR']) {
    context.t = (key, params) => translate(locale, key, params);
    for (const returnTo of [null, { kind: 'session-group' }]) {
      const title = 'Review PR 906';
      state.openSession = { title, returnTo };
      render({ loading: true });
      const destination = context.t(returnTo ? 'sessions.backgroundReviews' : 'sessions');
      const label = els.sessionDetailHead.children[0].attributes['aria-label'];
      assert.ok(label.startsWith(title), `${locale}: accessible name starts with the visible title`);
      assert.ok(label.includes(destination), `${locale}: accessible name includes the return destination`);
      assert.ok(!label.includes('{'), `${locale}: translation parameters are resolved`);
    }
    for (const key of ['sessions.backgroundReviews', 'sessions.grokBot']) {
      const name = context.t(key);
      context.renderGroup({ summary: { name, groupRows: [] } });
      const label = els.sessionDetailHead.children[0].attributes['aria-label'];
      assert.equal(els.sessionDetailHead.querySelector('.detail-heading').textContent, name);
      assert.ok(label.startsWith(name));
      assert.ok(label.includes(context.t('sessions')));
      assert.ok(!label.includes('{'));
      assert.ok(!context.t('sessions.grokBotCount', { count: 5 }).includes('{'));
    }
    state.openSession = {};
    render({ loading: true });
    assert.equal(els.sessionDetailHead.children[0].attributes['aria-label'], context.t('sessions.backTo', { destination: context.t('sessions') }));
  }
});

test('the compact detail back control returns to the review group or the session list', () => {
  const start = rendererSource.indexOf('function sessionDetailBack(');
  const end = rendererSource.indexOf('function renderSessionDetail(', start);
  const group = { kind: 'session-group', summary: {} };
  const state = { openSession: { returnTo: group } };
  let renderedGroup;
  let closed = false;
  const back = Function('state', 'renderSessionGroupDetail', 'closeSessionDetail',
    `${rendererSource.slice(start, end)}\nreturn sessionDetailBack;`
  )(state, request => { renderedGroup = request; }, () => { closed = true; state.openSession = null; });
  back();
  assert.equal(state.openSession, group);
  assert.equal(renderedGroup, group);
  assert.equal(closed, false);
  state.openSession = { title: 'Ordinary session' };
  back();
  assert.equal(closed, true);
  assert.equal(state.openSession, null);
});

function sessionDetailHarness(getSessionDetail) {
  const start = rendererSource.indexOf('function applySessionDetailResult(');
  const end = rendererSource.indexOf('\nfunction toggleDetailSort', start);
  assert.ok(start >= 0 && end > start, 'openSessionDetail should be present');
  const renders = [];
  const state = { period: 'today', openSession: null };
  const context = {
    state,
    visibleStatsSurface: () => 'main',
    isRendererWindowHidden: () => false,
    statsRenderScheduler: { request() {} },
    sessionTooltipShouldHoldRender: () => false,
    renderSessionDetail: (args) => renders.push(args),
    window: { tokenMonitor: { getSessionDetail } }
  };
  vm.runInNewContext(
    `${rendererSource.slice(start, end)}\nglobalThis.testOpenSessionDetail = openSessionDetail;\nglobalThis.testRefreshOpenSessionDetail = refreshOpenSessionDetail;`,
    context
  );
  return {
    openSessionDetail: context.testOpenSessionDetail,
    refreshOpenSessionDetail: context.testRefreshOpenSessionDetail,
    context,
    renders,
    state
  };
}

const detail = {
  found: true,
  exchanges: [
    {
      promptPreview: '重構 collector',
      startedAt: '2026-05-30T06:00:01.000Z',
      turnCount: 2,
      tools: ['Read', 'Bash'],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 150 },
      costEstimate: 0.3,
      turns: [
        { timestamp: '2026-05-30T06:00:02.000Z', tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 100 }, tools: ['Read'], costEstimate: 0.2 },
        { timestamp: '2026-05-30T06:00:03.000Z', tokens: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 50 }, tools: ['Bash'], costEstimate: 0.1 }
      ]
    },
    {
      promptPreview: '',
      startedAt: '2026-05-30T06:00:05.000Z',
      turnCount: 1,
      tools: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 20 },
      costEstimate: 0.04,
      turns: [{ timestamp: '2026-05-30T06:00:05.000Z', tokens: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 20 }, tools: [], costEstimate: 0.04 }]
    }
  ]
};

test('exchangeRows defaults to time desc (newest exchange first)', () => {
  const rows = exchangeRows(detail, { now: new Date(2026, 4, 30, 12, 0) });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, '(session start)');     // startedAt 06:00:05 — newer
  assert.equal(rows[1].title, '重構 collector');       // startedAt 06:00:01 — older
  assert.equal(rows[0].isPrompt, false);
  assert.equal(rows[1].isPrompt, true);
  assert.equal(rows[1].turnCount, 2);
  assert.match(rows[1].subtitle, /2 turns/);
  assert.match(rows[1].subtitle, /2 tools/);
  // inner turns stay chronological (oldest first), not re-sorted
  assert.equal(rows[1].turns[0].value, 100);
  assert.equal(rows[1].turns[1].value, 50);
});

test('exchangeRows sorts by tokens when sortBy=tokens', () => {
  const rows = exchangeRows(detail, { now: new Date(2026, 4, 30, 12, 0), sortBy: 'tokens' });
  assert.equal(rows[0].title, '重構 collector');
  assert.equal(rows[0].value, 150);
  assert.equal(rows[1].value, 20);
});

test('exchangeRows labels compaction usage without consuming a reply number', () => {
  const rows = exchangeRows({
    exchanges: [{
      promptPreview: 'continue',
      startedAt: '2026-05-30T06:00:01.000Z',
      turnCount: 1,
      tools: [],
      tokens: { total: 100 },
      costEstimate: 0.2,
      turns: [
        { type: 'compaction-summary', timestamp: '2026-05-30T06:00:02.000Z', tokens: { total: 30 }, tools: [], costEstimate: 0.06 },
        { type: 'reply', timestamp: '2026-05-30T06:00:03.000Z', tokens: { total: 70 }, tools: [], costEstimate: 0.14 }
      ]
    }]
  }, { now: new Date(2026, 4, 30, 12, 0) });

  assert.match(rows[0].subtitle, /1 turn/);
  assert.deepEqual(rows[0].turns.map((turn) => turn.label), ['Compaction summary', 'Reply #1']);
  assert.deepEqual(rows[0].turns.map((turn) => turn.value), [30, 70]);
});

test('exchangeRows labels model attempts without consuming a reply number', () => {
  const rows = exchangeRows({
    exchanges: [{
      promptPreview: 'retry this',
      startedAt: '2026-05-30T06:00:01.000Z',
      turnCount: 1,
      tools: [],
      tokens: { total: 100 },
      costEstimate: 0.2,
      turns: [
        { type: 'assistant-attempt', timestamp: '2026-05-30T06:00:02.000Z', tokens: { total: 30 }, tools: [], costEstimate: 0.06 },
        { type: 'reply', timestamp: '2026-05-30T06:00:03.000Z', tokens: { total: 70 }, tools: [], costEstimate: 0.14 }
      ]
    }]
  }, { now: new Date(2026, 4, 30, 12, 0) });

  assert.match(rows[0].subtitle, /1 turn/);
  assert.deepEqual(rows[0].turns.map((turn) => turn.label), ['Model attempt', 'Reply #1']);
  assert.deepEqual(rows[0].turns.map((turn) => turn.value), [30, 70]);
});

test('formatToolList dedupes and truncates', () => {
  assert.equal(formatToolList(['Read', 'Read', 'Bash']), 'Read · Bash');
  assert.equal(formatToolList([]), '');
});

test('openSessionDetail ignores a stale period result that completes last', async () => {
  const pending = [];
  const requests = [];
  const { openSessionDetail, renders, state } = sessionDetailHarness((args) => {
    const job = deferred();
    requests.push(args);
    pending.push(job);
    return job.promise;
  });
  const session = { client: 'claude', sessionId: 'same-session', sessionCost: 0.25, title: 'Session' };

  const todayRequest = openSessionDetail(session);
  state.period = 'month';
  const monthRequest = openSessionDetail(session);

  assert.equal(requests[0].period, 'today');
  assert.equal(requests[1].period, 'month');

  pending[1].resolve({ found: true, marker: 'month' });
  await monthRequest;
  pending[0].resolve({ found: true, marker: 'today' });
  await todayRequest;

  assert.equal(state.openSession.period, 'month');
  assert.equal(state.openSession.detail.marker, 'month');
  assert.deepEqual(renders.filter((render) => render.detail).map((render) => render.detail.marker), ['month']);
});

test('Reasonix rows enter the shared detail navigation path instead of a native accordion', () => {
  assert.match(rendererSource, /client !== 'claude' && client !== 'codex' && client !== 'opencode' && client !== 'reasonix'/);
  assert.match(rendererSource, /const sessionId = client === 'reasonix' \? `reasonix:\$\{match\[2\]\}` : match\[2\];/);
  assert.match(rendererSource, /state\.stats\?\.nativeSessions\?\.\[state\.period\]\?\.\[sessionId\]/);
  assert.match(rendererSource, /client === 'reasonix' && rowEl\.dataset\.detailUnavailable === 'true'/);
  assert.match(rendererSource, /sessionCost: client === 'reasonix' \? Number\(session\?\.reportedCostUsd \|\| 0\)/);
  assert.doesNotMatch(rendererSource, /nativeSessionBreakdown/);
});

for (const scenario of ['catch-up', 'hover', 'unchanged', 'hidden', 'closed', 'replaced', 'initial failure', 'initial rejection', 'catch-up failure', 'catch-up rejection']) {
  test(`first detail IPC catches the final stats push without another tick: ${scenario}`, async () => {
    const initialRead = deferred();
    let reads = 0;
    const { openSessionDetail, refreshOpenSessionDetail, context, renders, state } = sessionDetailHarness(async () => {
      reads += 1;
      if (reads === 1) return initialRead.promise;
      if (scenario === 'catch-up rejection') throw new Error('read failed');
      if (scenario === 'catch-up failure') return { found: false, error: 'read-failed' };
      return { found: true, marker: 200 };
    });
    const sessions = { 'claude:s': { totalTokens: 100, costUsd: 1 } };
    state.stats = { periods: { today: { sessions } } };
    const opening = openSessionDetail({ client: 'claude', sessionId: 's', sessionCost: 1 });
    const request = state.openSession;
    if (scenario !== 'unchanged') sessions['claude:s'] = { totalTokens: 200, costUsd: 2 };
    // The only external refresh occurs while initial detail is still null.
    await refreshOpenSessionDetail();
    assert.equal(reads, 1);
    if (scenario === 'hover') context.sessionTooltipShouldHoldRender = () => true;
    if (scenario === 'hidden') context.visibleStatsSurface = () => 'other';
    if (scenario === 'closed') state.openSession = null;
    if (scenario === 'replaced') state.openSession = { kind: 'session', detail: null };
    if (scenario === 'initial rejection') initialRead.reject(new Error('read failed'));
    else initialRead.resolve(scenario === 'initial failure' ? { found: false, error: 'read-failed' } : { found: true, marker: 100 });
    await opening;
    await new Promise(resolve => setImmediate(resolve));
    const shouldCatchUp = ['catch-up', 'catch-up failure', 'catch-up rejection'].includes(scenario);
    assert.equal(reads, shouldCatchUp ? 2 : 1);
    if (shouldCatchUp) {
      const succeeded = scenario === 'catch-up';
      assert.equal(request.detail.marker, succeeded ? 200 : 100);
      assert.equal(request.liveSignature, JSON.stringify(succeeded ? [200, 2, 0] : [100, 1, 0]));
      assert.equal(request.detailLiveBusy, false);
      assert.equal(renders.at(-1).detail.marker, succeeded ? 200 : 100);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reads, 2, 'a failed catch-up does not spin');
    }
    if (scenario === 'closed' || scenario === 'replaced') assert.equal(renders.length, 1, 'stale initial reads cannot paint');
    if (scenario === 'hover' || scenario === 'hidden') {
      context.sessionTooltipShouldHoldRender = () => false;
      context.visibleStatsSurface = () => 'main';
      await refreshOpenSessionDetail(); // Existing leave/visibility catch-up, not a stats tick.
      assert.equal(reads, 2);
      assert.equal(request.detail.marker, 200);
    }
  });
}

test('an open session detail re-reads only when its usage moved, and never mid-hover', async () => {
  const requests = [];
  const pending = [];
  let holdRead = false;              // defer the next getSessionDetail by hand
  const { openSessionDetail, refreshOpenSessionDetail, context, renders, state } = sessionDetailHarness((args) => {
    requests.push(args);
    if (!holdRead) return Promise.resolve({ found: true, marker: requests.length });
    const job = deferred();
    pending.push(job);
    return job.promise;
  });
  state.stats = { periods: { today: { sessions: { 'claude:s': { client: 'claude', totalTokens: 100, costUsd: 0.5 } } } } };

  // A stats push that lands while the first read is still in flight has to stay
  // unseen: writing it off against the older response would freeze the page.
  holdRead = true;
  const opening = openSessionDetail({ client: 'claude', sessionId: 's', sessionCost: 0.5, title: 'Session' });
  state.stats.periods.today.sessions['claude:s'] = { client: 'claude', totalTokens: 150, costUsd: 0.75 };
  holdRead = false;
  pending[0].resolve({ found: true, marker: 1 });
  await opening;
  await new Promise(resolve => setImmediate(resolve));

  // The push is re-read without another tick, priced from the live row.
  assert.equal(requests.length, 2, 'a push that landed mid-flight is re-read');
  assert.equal(requests[1].sessionCost, 0.75);
  assert.equal(state.openSession.detail.marker, 2);
  assert.equal(renders.at(-1).preserveScroll, true, 'a live re-read keeps the reading position');

  // Caught up with the row, so an idle tick reads nothing.
  await refreshOpenSessionDetail();
  assert.equal(requests.length, 2, 'unchanged usage does not re-read the transcript');

  // A rebuild replaces every row node, so a hover defers it to a later tick.
  state.stats.periods.today.sessions['claude:s'] = { client: 'claude', totalTokens: 400, costUsd: 2 };
  context.sessionTooltipShouldHoldRender = () => true;
  await refreshOpenSessionDetail();
  assert.equal(requests.length, 2, 'a held tooltip defers the rebuild');
  context.sessionTooltipShouldHoldRender = () => false;
  await refreshOpenSessionDetail();
  assert.equal(requests.length, 3);
  assert.equal(state.openSession.detail.marker, 3);

  // A hover that starts mid-flight defers only the paint, not the read.
  state.stats.periods.today.sessions['claude:s'] = { client: 'claude', totalTokens: 500, costUsd: 2.5 };
  holdRead = true;
  const inFlight = refreshOpenSessionDetail();
  context.sessionTooltipShouldHoldRender = () => true;
  pending[1].resolve({ found: true, marker: 4 });
  await inFlight;
  holdRead = false;
  assert.equal(state.openSession.detail.marker, 4, 'the read still lands');
  assert.equal(renders.at(-1).detail.marker, 3, 'but the paint waits for the hover to end');
  context.sessionTooltipShouldHoldRender = () => false;
  await refreshOpenSessionDetail();
  assert.equal(requests.length, 4, 'the deferred paint does not read again');
  assert.equal(renders.at(-1).detail.marker, 4);

  // A reply that arrives after the page is closed must not repaint it.
  state.stats.periods.today.sessions['claude:s'] = { client: 'claude', totalTokens: 600, costUsd: 3 };
  holdRead = true;
  const closing = refreshOpenSessionDetail();
  assert.equal(requests.length, 5);
  const rendersBeforeClose = renders.length;
  state.openSession = null;
  pending[2].resolve({ found: true, marker: 5 });
  await closing;
  assert.equal(renders.length, rendersBeforeClose, 'a closed page is not repainted');
});

for (const failureMode of ['resolved', 'rejected']) {
  test(`a final detail catch-up stops after a ${failureMode} failure and allows a later retry`, async () => {
    const reading = deferred();
    let reads = 0;
    const { openSessionDetail, refreshOpenSessionDetail, context, renders, state } = sessionDetailHarness(async () => {
      reads += 1;
      if (reads === 1) return { found: true, marker: 100 };
      if (reads === 2) return reading.promise;
      if (reads === 3) {
        if (failureMode === 'rejected') throw new Error('read failed');
        return { found: false, error: 'read-failed' };
      }
      return { found: true, marker: 300 };
    });
    const sessions = { 'claude:s': { totalTokens: 100, costUsd: 1 } };
    state.stats = { periods: { today: { sessions } } };
    await openSessionDetail({ client: 'claude', sessionId: 's', sessionCost: 1 });
    sessions['claude:s'] = { totalTokens: 200, costUsd: 2 };
    const inFlight = refreshOpenSessionDetail();
    context.sessionTooltipShouldHoldRender = () => true;
    sessions['claude:s'] = { totalTokens: 300, costUsd: 3 };
    await refreshOpenSessionDetail();
    context.sessionTooltipShouldHoldRender = () => false;
    await refreshOpenSessionDetail();
    assert.equal(reads, 2, 'leave while busy does not overlap reads');
    reading.resolve({ found: true, marker: 200 });
    await inFlight;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 3, 'the successful 200 read attempts the final 300 reading once');
    assert.equal(state.openSession.detail.marker, 200);
    assert.equal(state.openSession.liveSignature, JSON.stringify([200, 2, 0]));
    assert.equal(state.openSession.sessionCost, 2);
    assert.equal(state.openSession.detailLiveBusy, false);
    assert.deepEqual(renders.filter(render => render.detail).map(render => render.detail.marker), [100, 200]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 3, 'a failed catch-up must not automatically retry');
    await refreshOpenSessionDetail();
    assert.equal(reads, 4);
    assert.equal(state.openSession.detail.marker, 300);
    assert.equal(state.openSession.liveSignature, JSON.stringify([300, 3, 0]));
    assert.equal(state.openSession.sessionCost, 3);
    await refreshOpenSessionDetail();
    assert.equal(reads, 4, 'successful recovery suppresses idle reads');
  });
}

for (const [label, failure] of [
  ['read-failed', { found: false, error: 'read-failed', exchanges: [] }],
  ['line-too-large', { found: false, error: 'line-too-large', exchanges: [] }],
  ['not-found', { found: false, exchanges: [] }],
  ['empty payload', null]
]) {
  test(`live detail retains its last good reading and retries a resolved ${label}`, async () => {
    const initial = { found: true, exchanges: [], marker: 'initial' };
    const recovered = { found: true, exchanges: [], marker: 'recovered' };
    let reads = 0;
    const { openSessionDetail, refreshOpenSessionDetail, renders, state } = sessionDetailHarness(async () => {
      reads += 1;
      return [initial, failure, recovered][reads - 1];
    });
    state.stats = { periods: { today: { sessions: { 'claude:s': { totalTokens: 100, costUsd: 1 } } } } };
    await openSessionDetail({ client: 'claude', sessionId: 's', sessionCost: 1 });
    const signature = state.openSession.liveSignature;
    const paints = renders.length;
    state.stats.periods.today.sessions['claude:s'] = { totalTokens: 200, costUsd: 2 };
    await refreshOpenSessionDetail();
    assert.strictEqual(state.openSession.detail, initial);
    assert.equal(state.openSession.sessionCost, 1);
    assert.equal(state.openSession.liveSignature, signature);
    assert.equal(state.openSession.detailLiveBusy, false);
    assert.equal(renders.length, paints, 'a resolved failure must not replace the visible reading');
    await refreshOpenSessionDetail();
    assert.equal(reads, 3, 'unchanged usage still retries the failed reading');
    assert.strictEqual(state.openSession.detail, recovered, 'a successful empty exchange list is valid');
    assert.equal(state.openSession.sessionCost, 2);
    assert.notEqual(state.openSession.liveSignature, signature);
    assert.strictEqual(renders.at(-1).detail, recovered);
    await refreshOpenSessionDetail();
    assert.equal(reads, 3, 'successful recovery restores idle read suppression');
  });
}

test('live detail anchors the visible turn across growth and exchange reordering', () => {
  const container = {
    children: [], scrollTop: 0, clientTop: 0,
    classList: { add() {}, remove() {} },
    getBoundingClientRect: () => ({ top: 20 }),
    replaceChildren() { this.children = []; this.scrollTop = 0; },
    append(node) { this.children.push(node); }
  };
  function exchangeNode(row, max, expanded) {
    const headerHeight = 40;
    const turnHeights = expanded ? (row.turnHeights || row.turns.map(() => 40)) : [];
    const exchange = {
      dataset: { exchangeKey: row.key },
      classList: { contains: value => value === 'expanded' && expanded },
      height: headerHeight + turnHeights.reduce((sum, height) => sum + height, 0)
    };
    function rect(offset, height) {
      const index = container.children.indexOf(exchange);
      const above = container.children.slice(0, index).reduce((sum, node) => sum + node.height, 0);
      const top = 20 + above + offset - container.scrollTop;
      return { top, bottom: top + height };
    }
    const header = { dataset: {}, getBoundingClientRect: () => rect(0, headerHeight) };
    const turns = turnHeights.map((height, index) => ({
      dataset: { key: `turn:${index}` },
      getBoundingClientRect: () => rect(headerHeight + turnHeights.slice(0, index).reduce((sum, value) => sum + value, 0), height)
    }));
    exchange.getBoundingClientRect = () => rect(0, exchange.height);
    exchange.querySelector = () => header;
    exchange.querySelectorAll = () => turns;
    return exchange;
  }
  const context = {
    els: { breakdown: { classList: container.classList }, sessionDetail: container,
      sessionDetailHead: { classList: container.classList, replaceChildren() {}, append() {} } },
    state: { detailSort: 'time', openSession: {} },
    document: { createElement: () => ({ addEventListener() {} }) },
    t: () => '', sessionDetailBackButton: () => ({}), toggleDetailSort() {},
    sessionRowsApi: { sessionDetailIdLabel: () => '' },
    sessionDetailApi: { exchangeRows: detail => detail.exchanges }, exchangeNode
  };
  const start = rendererSource.indexOf('function renderSessionDetail(');
  const end = rendererSource.indexOf('function sessionDetailTitle(', start);
  vm.runInNewContext(`${rendererSource.slice(start, end)}\nglobalThis.render = renderSessionDetail;`, context);
  const active = { key: 'active', startTime: 111, value: 100, turnHeights: Array(10).fill(40) };
  const older = { key: 'older', startTime: 100, value: 10, turnHeights: [] };
  container.children = [exchangeNode(active, 100, true), exchangeNode(older, 100, false)];
  container.scrollTop = 160; // Inside turn #4 of the expanded exchange.

  active.turnHeights.push(80);
  context.render({ detail: { exchanges: [active, older] }, preserveScroll: true });
  assert.equal(container.scrollTop, 160, 'a reply appended below the reader does not move them');
  assert.equal(container.children[0].classList.contains('expanded'), true);

  const newer = { key: 'newer', startTime: 222, value: 200, turnHeights: [] };
  context.render({ detail: { exchanges: [newer, active, older] }, preserveScroll: true });
  assert.equal(container.scrollTop, 200, 'an exchange inserted above shifts only by its own height');

  context.state.detailSort = 'tokens';
  context.render({ detail: { exchanges: [active, newer, older] }, preserveScroll: true });
  assert.equal(container.scrollTop, 160, 'a reorder preserves the same turn even with unchanged total height');

  container.scrollTop = 15;
  context.render({ detail: { exchanges: [newer, active, older] }, preserveScroll: true });
  assert.equal(container.scrollTop, 55, 'a partially visible exchange header is also anchored');

  container.scrollTop = 0;
  context.render({ detail: { exchanges: [active, newer, older] }, preserveScroll: true });
  assert.equal(container.scrollTop, 0, 'the top stays at the top to expose incoming activity');

  context.sessionDetailApi = { exchangeRows };
  for (const startedAt of ['2026-10-13T10:00:00Z', '', 'invalid']) {
    for (const repeatedPrompt of [false, true]) {
      context.state.detailSort = 'time';
      const makeExchange = promptPreview => ({
        startedAt, promptPreview, tokens: { total: 10 }, turnCount: 10,
        turns: Array.from({ length: 10 }, () => ({ tokens: { total: 1 } }))
      });
      const detail = { exchanges: [makeExchange('First prompt'), makeExchange(repeatedPrompt ? 'First prompt' : 'Second prompt')] };
      const rows = exchangeRows(detail);
      const readingKey = rows[1].key;
      assert.notEqual(rows[0].key, readingKey, 'equal or missing times and repeated prompts still have distinct keys');
      context.render({ detail });
      container.children[1] = exchangeNode(rows[1], 10, true);
      container.scrollTop = 160;
      const reading = () => container.children.find(node => node.dataset.exchangeKey === readingKey);
      const offset = () => reading().querySelectorAll('.detail-turn')[2].getBoundingClientRect().top;
      const before = offset();
      const checkReading = () => {
        assert.deepEqual(container.children.filter(node => node.classList.contains('expanded')).map(node => node.dataset.exchangeKey), [readingKey]);
        assert.equal(offset(), before, 'the same reply remains at the same viewport position');
      };
      context.render({ detail, preserveScroll: true });
      checkReading();

      detail.exchanges[1].turns.push({ tokens: { total: 1 } });
      detail.exchanges[1].tokens.total += 1;
      context.render({ detail, preserveScroll: true });
      checkReading();

      const appended = makeExchange('First prompt');
      appended.tokens.total = 50;
      detail.exchanges.push(appended);
      context.render({ detail, preserveScroll: true });
      checkReading();
      assert.equal(new Set(exchangeRows(detail).map(row => row.key)).size, 3);

      detail.exchanges[0].tokens.total = 100;
      context.state.detailSort = 'tokens';
      context.render({ detail, preserveScroll: true });
      checkReading();
    }
  }
});
