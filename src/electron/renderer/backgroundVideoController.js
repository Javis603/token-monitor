'use strict';

(function exposeBackgroundVideo(root) {
  function isBackgroundVideoBlocked(material, bubble) {
    return material?.reducedTransparency === true || material?.type === 'opaque' || bubble?.collapsed === true;
  }
  function createBackgroundVideoController(options) {
    const { api, shell, t, imageActive, imageBusy = () => false, reducedMotion, visible, blocked } = options;
    const status = document.getElementById('backgroundVideoStatus');
    const choose = document.getElementById('chooseBackgroundVideoButton');
    const remove = document.getElementById('clearBackgroundVideoButton');
    const title = document.getElementById('backgroundVideoTitle');
    const opacityRow = document.getElementById('backgroundImageOpacityRow');
    const opacityLabel = document.getElementById('backgroundImageOpacityLabel');
    const opacityReset = document.getElementById('resetBackgroundImageOpacityButton');
    const imageChoose = document.getElementById('chooseBackgroundImageButton');
    const imageRemove = document.getElementById('clearBackgroundImageButton');
    let record = null;
    let video = null;
    let busy = false;
    let failed = false;
    let generation = 0;
    const text = (key, params) => t(`settings.appearance.${key}`, params);

    function release(element) {
      if (!element) return;
      element.pause();
      element.removeAttribute('src');
      element.load();
      element.remove();
    }

    function makeVideo() {
      const element = document.createElement('video');
      element.className = 'background-video-layer';
      element.muted = true;
      element.defaultMuted = true;
      element.volume = 0;
      element.loop = true;
      element.playsInline = true;
      element.preload = 'auto';
      element.setAttribute('aria-hidden', 'true');
      element.disablePictureInPicture = true;
      return element;
    }

    function loadPlayable(element, url) {
      return new Promise((resolve, reject) => {
        let timer;
        const done = (error) => {
          clearTimeout(timer);
          element.removeEventListener('loadeddata', ready);
          element.removeEventListener('error', errorHandler);
          error ? reject(error) : resolve();
        };
        const ready = () => done(element.videoWidth > 0 && element.videoHeight > 0 ? null : new Error('Invalid video'));
        const errorHandler = () => done(new Error('Unsupported video codec'));
        element.addEventListener('loadeddata', ready, { once: true });
        element.addEventListener('error', errorHandler, { once: true });
        timer = setTimeout(() => done(new Error('Video load timeout')), 15_000);
        element.src = url;
        element.load();
      });
    }

    function sync() {
      if (!visible()) {
        video?.pause();
        return;
      }
      title.textContent = text('backgroundVideo');
      choose.textContent = text('backgroundVideoChoose');
      remove.textContent = text('backgroundVideoClear');
      choose.disabled = busy || imageBusy();
      remove.disabled = busy || imageBusy();
      if (imageChoose) imageChoose.disabled = busy || imageBusy();
      if (imageRemove) imageRemove.disabled = busy || imageBusy();
      remove.classList.toggle('hidden', !record);
      opacityRow?.classList.toggle('hidden', !video && !imageActive());
      if (opacityLabel) opacityLabel.textContent = text(video ? 'backgroundOpacity' : 'backgroundImageOpacity');
      if (opacityReset) opacityReset.title = text(video ? 'resetBackgroundOpacity' : 'resetBackgroundImageOpacity');
      const hidden = blocked();
      const paused = reducedMotion();
      if (video) {
        video.hidden = hidden;
        if (hidden || paused) video.pause();
        else if (video.paused) void video.play().catch(() => {});
      }
      const key = busy ? 'backgroundVideoLoading'
        : failed ? 'backgroundVideoError'
          : video ? (hidden ? 'backgroundVideoHidden' : paused ? 'backgroundVideoPaused' : 'backgroundVideoActive')
            : 'backgroundVideoNone';
      status.textContent = text(key, { name: record?.name || '' });
      status.title = status.textContent;
    }

    // Reset only the presentation after main has removed the saved video.
    function reset() {
      generation += 1;
      release(video); video = null; record = null; failed = false;
      shell.classList.remove('has-background-video');
      sync();
    }

    async function apply(next) {
      if (!next) {
        reset();
        return;
      }
      const current = ++generation;
      const candidate = makeVideo();
      try {
        await loadPlayable(candidate, next.url);
        if (current !== generation) { release(candidate); return; }
        release(video);
        video = candidate;
        record = next;
        failed = false;
        shell.prepend(video);
        shell.classList.add('has-background-video');
        video.addEventListener('error', () => {
          if (video !== candidate) return;
          release(video); video = null; failed = true;
          shell.classList.remove('has-background-video');
          sync();
        }, { once: true });
        sync();
      } catch (error) {
        release(candidate);
        if (current === generation) { failed = true; sync(); }
        throw error;
      }
    }

    async function clear() {
      if (busy || imageBusy()) return;
      generation += 1;
      busy = true;
      sync();
      try {
        await api.clearBackgroundVideo();
        reset();
      } finally {
        busy = false;
        sync();
      }
    }

    async function chooseVideo() {
      if (busy || imageBusy()) return;
      generation += 1;
      busy = true; failed = false; sync();
      let preview;
      let candidate;
      try {
        const selection = await api.chooseBackgroundVideo();
        if (selection.canceled) return;
        preview = selection.preview;
        candidate = makeVideo();
        // Decode a frame before replacing the saved background. A bad codec
        // or canceled selection must leave the previous image/video intact.
        await loadPlayable(candidate, preview.url);
        release(candidate); candidate = null;
        await apply(await api.commitBackgroundVideo(preview.id));
      } catch (_) {
        failed = true;
      } finally {
        release(candidate);
        if (preview) await api.cancelBackgroundVideo(preview.id).catch(() => {});
        busy = false; sync();
      }
    }

    choose.addEventListener('click', () => { void chooseVideo(); });
    remove.addEventListener('click', () => { void clear().catch(() => { failed = true; sync(); }); });
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pagehide', () => { generation += 1; release(video); video = null; });
    sync();
    return {
      sync, clear, reset, isBusy: () => busy,
      async load() {
        const request = ++generation;
        try {
          const saved = await api.getBackgroundVideo();
          if (request === generation) await apply(saved);
        } catch (_) {
          if (request === generation) { failed = true; sync(); }
        }
      }
    };
  }
  root.TokenMonitorBackgroundVideo = { createBackgroundVideoController, isBackgroundVideoBlocked };
})(window);
