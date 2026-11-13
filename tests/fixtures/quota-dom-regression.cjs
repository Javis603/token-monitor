/* global state, surface, render, document, requestAnimationFrame, WheelEvent */
'use strict';
(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const payload = state.payload;
  if (surface === 'notch') {
    const entry = payload.cells.find(cell => cell.kind === 'provider');
    const accounts = entry.accounts;
    entry.accounts = accounts.slice(0, 1); render(payload);
    document.querySelector('.notch-tab[data-page="limits"]').click(); await settle();
    const strip = document.querySelector('.notch-limits');
    assert(!document.querySelector('.notch-pager'), 'one quota page needs no pager');
    entry.accounts = accounts; render(payload); await settle();
    assert(document.querySelector('.notch-limits') === strip, 'single to multiple quota pages retain the strip');
    const wheel = new WheelEvent('wheel', { deltaY: 30, cancelable: true });
    strip.dispatchEvent(wheel); await settle();
    assert(wheel.defaultPrevented && strip.scrollLeft > 0, 'retained quota strip handles a vertical wheel after accounts arrive');
    strip.scrollLeft = 0; strip.dispatchEvent(new Event('scroll')); await settle();
    assert(document.querySelector('.notch-pager button').getAttribute('aria-pressed') === 'true', 'retained quota strip synchronizes its pager on native scroll');
  }
  const selector = surface === 'bubble' ? '.limit-row' : '.notch-limit';
  const account = document.querySelector(selector); assert(account, `${surface} quota account exists`);
  const records = surface === 'bubble' ? payload.cell.accounts : payload.cells.find(cell => cell.kind === 'provider').accounts;
  const focus = surface === 'bubble' ? account.querySelector('.limit-detail-tooltip-trigger') : document.querySelector('.notch-window-page');
  assert(focus, `${surface} quota control exists`); focus.focus();
  const tooltip = surface === 'bubble' ? focus.parentNode.querySelector('[popover]') : null;
  const lists = surface === 'bubble' ? [...document.querySelectorAll('.edge-dock-accounts, .edge-dock-session-list')] : [document.querySelector('.notch-limits')];
  for (const list of lists) if (list.scrollHeight > list.clientHeight) list.scrollTop = 25;
  const positions = lists.map(list => list.scrollTop);
  if (surface === 'bubble') assert(positions.filter(value => value > 0).length >= 2, 'independent account and session lists really overflow');
  for (let i = 2; i < 4; i++) {
    records[0].record.windows[0].remainingPercent--;
    records[0].record.resetCredits.expirations = [new Date(Date.now() + i * 86400000).toISOString()];
    render(payload); await settle();
    assert(document.querySelector(selector) === account, `${surface} quota account retained`);
    assert(document.activeElement === focus, `${surface} quota focus retained`);
    if (tooltip) assert(tooltip.matches(':popover-open'), 'Dock quota tooltip stays open');
    lists.forEach((list, index) => assert(list.scrollTop === positions[index], `${surface} nested scroll retained: ${JSON.stringify({index, before:positions[index], after:list.scrollTop, height:list.clientHeight, extent:list.scrollHeight, connected:list.isConnected})}`));
  }
  if (surface === 'notch') {
    const before = focus.textContent; focus.click(); await settle();
    assert(focus.textContent !== before, 'retained quota page button advances');
    focus.click(); await settle(); assert(focus.textContent === before, 'retained quota page button wraps using the current page');
    document.querySelectorAll('.notch-pager button')[1].click(); await settle();
    const oldStrip = document.querySelector('.notch-limits'), savedLeft = oldStrip.scrollLeft;
    assert(savedLeft > 0, 'Limits account page really scrolled');
    document.querySelector('.notch-tab[data-page="home"]').click(); await settle();
    payload.expanded = false; render(payload); await settle();
    payload.expanded = true; render(payload); await settle();
    assert(!oldStrip.isConnected, 'reopen retires hidden Limits tree');
    document.querySelector('.notch-tab[data-page="limits"]').click(); await settle();
    assert(Math.abs(document.querySelector('.notch-limits').scrollLeft - savedLeft) < 1, 'retired Limits page restores saved horizontal page after mounting');
    document.querySelector('.notch-tab[data-page="home"]').click(); await settle();
    const fuel = document.querySelector('.notch-fuel'); fuel.style.maxWidth = '160px';
    const entry = payload.cells.find(cell => cell.kind === 'provider');
    const today = payload.cells.find(cell => cell.id === 'stat:today');
    payload.cells = [today, ...Array.from({ length: 8 }, (_, index) => ({ ...entry, id: `fuel-${index}` }))];
    render(payload); await settle();
    const more = fuel.querySelector('.notch-fuel-more'); assert(more && !more.hidden, 'quota remainder really overflows'); more.focus();
    for (let i = 0; i < 2; i++) {
      today.totalTokens++; render(payload); await settle();
      assert(fuel.querySelector('.notch-fuel-more') === more && document.activeElement === more, 'focused quota remainder stays connected across pushes');
    }
  }
  return `PASS actual ${surface} quotas, control lifecycle and scroll retention`;
})()
