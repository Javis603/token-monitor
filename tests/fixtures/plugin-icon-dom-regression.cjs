/* global document, getComputedStyle */
'use strict';
(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const waitFor = async predicate => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Icon did not finish loading');
  };
  const views = window.TokenMonitorPluginViews;
  const dom = window.TokenMonitorDomReconcile.create();
  const host = document.createElement('div'); document.body.append(host);
  const data = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>');
  const mask = { presentation: { icon: { data, mode: 'mask' } } };
  const native = { presentation: { icon: { native: 'codex' } } };
  const image = { presentation: { icon: { data, mode: 'image' } } };
  const push = (view, size = 16) => {
    dom.reconcileChildren(host, [views.navigationIcon(document, view, size)]);
    return host.firstChild;
  };
  // Both refresh-before-load and refresh-after-load used to orphan callbacks.
  for (const view of [native, mask]) {
    dom.clear(host);
    const first = push(view);
    push(view);
    await waitFor(() => first.firstChild?.style.maskImage);
    const mark = first.firstChild;
    for (const color of ['rgb(240, 240, 240)', 'rgb(20, 20, 20)']) {
      host.style.color = color;
      for (let i = 0; i < 3; i++) {
        push(view);
        await new Promise(resolve => setTimeout(resolve, 10));
        assert(host.firstChild === first && first.childNodes.length === 1 && first.firstChild === mark, 'native/mask artwork survives pushes without a raw image or duplicate mask');
        assert(getComputedStyle(mark).backgroundColor === color, 'monochrome artwork follows the current theme');
      }
    }
  }
  const bitmap = push(image);
  await waitFor(() => bitmap.firstChild?.complete);
  push(image);
  assert(host.firstChild === bitmap && bitmap.firstChild.tagName === 'IMG', 'image artwork keeps its original colors');
  const resized = push(image, 20);
  assert(resized !== bitmap && resized.style.width === '20px', 'size changes replace the icon');
  assert(push(native) !== resized, 'artwork changes replace the icon');
  const factory = push({ presentation: { icon: { native: 'factory' } } });
  await waitFor(() => factory.firstChild?.style.maskImage);
  assert(factory.firstChild.className === 'row-icon-factory', 'factory uses its native class');
  const droid = push({ presentation: { icon: { native: 'droid' } } });
  await waitFor(() => droid.firstChild?.style.maskImage);
  assert(droid !== factory && droid.firstChild.className === 'row-icon-droid', 'native IDs sharing artwork still update their class');
  // A broken image must still fall back after a retained refresh, then remain
  // settled rather than being resurrected on every subsequent stats push.
  for (const identityIcon of [data, 'data:image/png;base64,invalid']) {
    const broken = { identityIcon, icon: 'cpu', presentation: { icon: { data: 'data:image/png;base64,broken', mode: 'mask' } } };
    dom.clear(host);
    const first = push(broken); push(broken);
    await waitFor(() => identityIcon === data ? first.querySelector('img')?.naturalWidth > 0 : first.querySelector('path'));
    const fallback = first.firstChild;
    for (let i = 0; i < 3; i++) push(broken);
    assert(host.firstChild === first && first.firstChild === fallback && first.childNodes.length === 1, 'loaded identity/glyph fallback survives pushes');
    // An obsolete image event must not modify the new icon after an update.
    const obsolete = first.querySelector('img');
    const current = push(native);
    obsolete?.dispatchEvent(new Event('error'));
    await waitFor(() => current.firstChild?.style.maskImage);
    assert(host.firstChild === current && !current.querySelector('path'), 'obsolete fallback cannot overwrite new artwork');
  }
  host.remove();
  return 'PASS plugin icons: cold/cached native and masks, dark/light themes, image colors, size/art changes, identity/glyph fallback and obsolete callbacks';
})()
