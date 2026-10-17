'use strict';

// Shared by settings/bubble previews and the small tray renderer. No app DOM,
// collector, credentials or full application bootstrap belongs in this module.
(function exposeTrayImageRenderer(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorTrayImageRenderer = api;
})(typeof window !== 'undefined' ? window : null, function createTrayImageRendererApi() {
  function createTrayImageRenderer(env) {
    const {
      getState,
      pickWorstProvider,
      pickWorstSessionProvider,
      pickWorstWeeklyProvider,
      configuredLimitProviderOrder,
      currentCurrency,
      compactTokenDisplayOptions,
      displayLiveTokenRateSamples,
      formatLiveTokenRate,
      localLiveCodexProvider,
      statsForTrayComposer,
      themePresetsApi,
      resolvedThemeColor,
      formatPercent,
      limitFillPercent,
      accountIdentityApi,
      trayLayoutApi
    } = env;
    const trayProviderImages = {};
    const trayProviderImageIds = new WeakMap();
    const trayProviderImageOpticalSamples = new WeakMap();

    function roundedRectPath(ctx, x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }

    function providerImageOpticalSample(image) {
      const cached = trayProviderImageOpticalSamples.get(image);
      if (cached) return cached;

      const sampleSize = 128;
      const canvas = document.createElement('canvas');
      canvas.width = sampleSize;
      canvas.height = sampleSize;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, sampleSize, sampleSize);

      let bounds = { x: 0, y: 0, width: sampleSize, height: sampleSize };
      // Whether the mark is drawn in one flat ink, i.e. authored `fill="currentColor"`
      // and meant to be re-inked, as opposed to brand artwork that must be left alone.
      // The rule itself lives in isFlatInkPixels so it can be tested against pixels
      // directly; pixels we cannot read back (a future non-local image) leave it
      // false, which means untinted.
      let flatInk = false;
      try {
        const pixels = ctx.getImageData(0, 0, sampleSize, sampleSize).data;
        flatInk = window.TokenMonitorTrayProviderIcons.isFlatInkPixels(pixels);
        let minX = sampleSize;
        let minY = sampleSize;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < sampleSize; y += 1) {
          for (let x = 0; x < sampleSize; x += 1) {
            if (pixels[(y * sampleSize + x) * 4 + 3] <= 12) continue;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
        if (maxX >= minX && maxY >= minY) {
          bounds = {
            x: minX,
            y: minY,
            width: maxX - minX + 1,
            height: maxY - minY + 1
          };
        }
      } catch (_) {
        // Keep the original frame if a future non-local image cannot be inspected.
      }

      const sample = { canvas, bounds, flatInk };
      trayProviderImageOpticalSamples.set(image, sample);
      return sample;
    }

    function paintProviderImage(ctx, image, x, y, size, templateColor = '', optical = {}) {
      const {
        trayProviderOpticalLayout,
        trayProviderOpticalRatio
      } = window.TokenMonitorTrayProviderIcons;
      const sample = providerImageOpticalSample(image);
      const opticalRatio = trayProviderOpticalRatio(trayProviderImageIds.get(image), optical);
      const layout = trayProviderOpticalLayout(sample.bounds, size, opticalRatio);
      const maskSize = Math.max(1, Math.round(size));
      const mask = document.createElement('canvas');
      mask.width = maskSize;
      mask.height = maskSize;
      const maskCtx = mask.getContext('2d');
      maskCtx.drawImage(
        sample.canvas,
        sample.bounds.x,
        sample.bounds.y,
        sample.bounds.width,
        sample.bounds.height,
        layout.x,
        layout.y,
        layout.width,
        layout.height
      );
      if (templateColor) {
        maskCtx.globalCompositeOperation = 'source-in';
        maskCtx.fillStyle = templateColor;
        maskCtx.fillRect(0, 0, maskSize, maskSize);
      }
      ctx.drawImage(mask, x, y, size, size);
    }

    // Which ink a provider mark is drawn in. An explicit colour always wins — the
    // menubar previews and the floating bubble pass their own, and the bubble
    // deliberately passes none to keep the artwork in colour. `trayInk` is set only
    // by the two paths that hand a bitmap to the system tray, where a monochrome
    // mark has to be re-inked for a dark taskbar (see trayProviderGlyphInk).
    function trayGlyphInk(options, image) {
      if (options?.templateIconColor) return options.templateIconColor;
      if (options?.trayInk !== true || !image) return '';
      return window.TokenMonitorTrayText.trayProviderGlyphInk(
        getState().appInfo?.platform,
        getState().systemDarkUi,
        providerImageOpticalSample(image).flatInk
      );
    }

    function drawProviderImage(ctx, image, x, y, size, contrastHalo = false, templateColor = '', optical = {}) {
      if (contrastHalo) {
        const lightSurface = themePresetsApi.isLightHex(resolvedThemeColor('bg'));
        ctx.save();
        ctx.shadowColor = lightSurface ? 'rgba(0, 0, 0, 0.58)' : 'rgba(255, 255, 255, 0.82)';
        ctx.shadowBlur = Math.max(2, Math.round(size * 0.1));
        paintProviderImage(ctx, image, x, y, size, templateColor, optical);
        ctx.restore();
      }
      paintProviderImage(ctx, image, x, y, size, templateColor, optical);
    }

    function renderBarsIcon(stats, height = 44, picker = pickWorstProvider, colors = {}, options = {}) {
      const trackColor = colors.track || 'rgba(0, 0, 0, 0.32)';
      const fillColor = colors.fill || 'rgba(0, 0, 0, 1)';
      const selection = picker(stats);
      if (!selection) return null;
      const { providerRecord } = selection;
      const providerImage = trayProviderImages[providerRecord.provider];
      const { trayBarFillWidth, trayBarsLayout } = window.TokenMonitorTrayBars;
      const layout = trayBarsLayout(height);

      const canvas = document.createElement('canvas');
      canvas.width = layout.width;
      canvas.height = layout.height;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, layout.width, layout.height);

      if (providerImage) {
        drawProviderImage(
          ctx,
          providerImage,
          layout.padX,
          layout.iconY,
          layout.iconSize,
          options.providerContrastHalo === true,
          trayGlyphInk(options, providerImage)
        );
      }

      function drawBar(y, percent) {
        roundedRectPath(ctx, layout.barsX, y, layout.barsWidth, layout.barHeight, layout.radius);
        ctx.fillStyle = trackColor;
        ctx.fill();
        const fillW = trayBarFillWidth(limitFillPercent(percent, undefined, Boolean(getState().settings?.showLimitUsed)), layout.barsWidth);
        if (!fillW) return;
        // Clip-to-track + flat fillRect: a rounded rect's tiny corners get lost when the icon is downscaled into the menubar.
        ctx.save();
        roundedRectPath(ctx, layout.barsX, y, layout.barsWidth, layout.barHeight, layout.radius);
        ctx.clip();
        ctx.fillStyle = fillColor;
        ctx.fillRect(layout.barsX, y, fillW, layout.barHeight);
        ctx.restore();
      }

      // Read the selection's resolved percentages, not the raw windows: a balance
      // window carries no wire percentage and would draw an empty (exhausted) bar.
      drawBar(layout.barsStartY, selection.primaryPercent);
      drawBar(layout.barsStartY + layout.barHeight + layout.barGap, selection.secondaryPercent);
      return canvas.toDataURL('image/png');
    }

    function pickConfiguredSessionProviders(stats, configOrder) {
      return window.TokenMonitorTrayText.pickConfiguredLimitProviders(stats, {
        limitProviderOrder: configOrder,
        limitProviders: configOrder,
        showLimitUsed: Boolean(getState().settings?.showLimitUsed)
      });
    }

    function renderAllSessionsIcon(stats, height = 44, configOrder, colors = {}, options = {}) {
      const trackColor = colors.track || 'rgba(0, 0, 0, 0.32)';
      const fillColor = colors.fill || 'rgba(0, 0, 0, 1)';
      const picks = pickConfiguredSessionProviders(stats, configOrder);
      if (picks.length === 0) return null;
      // With one tool, preserve its canonical pair; a lone weekly/billing window is
      // promoted to the top lane and the lower lane remains an empty track.
      if (picks.length === 1) return renderBarsIcon(stats, height, () => picks[0], colors, options);

      const { trayBarFillWidth, trayBarsLayout } = window.TokenMonitorTrayBars;
      const layout = trayBarsLayout(height, { contentOnly: true });
      const canvas = document.createElement('canvas');
      canvas.width = layout.width;
      canvas.height = layout.height;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, layout.width, layout.height);

      // No per-row icons — order in the dropdown identifies which row is which tool.
      // Keep the canvas to just the bars, so the tray does not reserve a blank icon area.
      function drawBar(y, percent) {
        roundedRectPath(ctx, layout.barsX, y, layout.barsWidth, layout.barHeight, layout.radius);
        ctx.fillStyle = trackColor;
        ctx.fill();
        const fillW = trayBarFillWidth(limitFillPercent(percent, undefined, Boolean(getState().settings?.showLimitUsed)), layout.barsWidth);
        if (!fillW) return;
        ctx.save();
        roundedRectPath(ctx, layout.barsX, y, layout.barsWidth, layout.barHeight, layout.radius);
        ctx.clip();
        ctx.fillStyle = fillColor;
        ctx.fillRect(layout.barsX, y, fillW, layout.barHeight);
        ctx.restore();
      }

      // The picker's resolved remaining percentage, not the raw window: drawBar
      // applies the used-mode flip itself, and a balance window has no wire
      // percentage to read.
      drawBar(layout.barsStartY, picks[0].remaining);
      drawBar(layout.barsStartY + layout.barHeight + layout.barGap, picks[1].remaining);
      return canvas.toDataURL('image/png');
    }

    function renderLimitSessionsIcon(stats, height = 44, configOrder, colors = {}, options = {}) {
      const picks = pickConfiguredSessionProviders(stats, configOrder);
      if (picks.length === 0) return null;

      const textColor = colors.text || colors.fill || 'rgba(0, 0, 0, 1)';
      const { trayBarsLayout } = window.TokenMonitorTrayBars;
      const layout = trayBarsLayout(height);
      const iconSize = layout.iconSize;
      const gap = Math.max(3, Math.round(height * 0.1));
      const separator = ' · ';
      const padX = options.contentOnly === true ? 0 : layout.padX;
      const fontSize = Math.round(height * 0.68);
      const font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;

      const measureCanvas = document.createElement('canvas');
      const measureCtx = measureCanvas.getContext('2d');
      measureCtx.font = font;
      // `percent` / `secondaryPercent` are already mode-adjusted by the picker and
      // handle balance windows, which carry no wire percentage of their own.
      const visiblePicks = picks.length === 1
        ? [{
            ...picks[0],
            text: [picks[0].percent, picks[0].secondaryPercent]
              .filter((percent) => percent !== null && percent !== undefined)
              .map((percent) => formatPercent(percent))
              .join(separator)
          }]
        : picks.map((pick) => ({
            ...pick,
            text: formatPercent(pick.percent)
          }));
      const entries = visiblePicks.map((pick) => {
        const text = pick.text;
        const image = trayProviderImages[pick.providerRecord.provider];
        const textWidth = Math.ceil(measureCtx.measureText(text).width);
        const iconWidth = image ? iconSize + gap : 0;
        return { pick, text, image, width: iconWidth + textWidth };
      }).filter((entry) => entry.text);
      if (entries.length === 0) return null;

      const separatorWidth = Math.ceil(measureCtx.measureText(separator).width);
      const width = Math.ceil(
        padX * 2 +
        entries.reduce((sum, entry) => sum + entry.width, 0) +
        separatorWidth * Math.max(0, entries.length - 1)
      );
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, width);
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = font;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = textColor;

      let x = padX;
      const centerY = height / 2;
      entries.forEach((entry, index) => {
        if (entry.image) {
          drawProviderImage(ctx, entry.image, x, layout.iconY, iconSize,
            options.providerContrastHalo === true,
            trayGlyphInk(options, entry.image)
          );
          x += iconSize + gap;
        }
        ctx.fillText(entry.text, x, centerY + 1);
        x += Math.ceil(ctx.measureText(entry.text).width);
        if (index < entries.length - 1) {
          ctx.fillText(separator, x, centerY + 1);
          x += separatorWidth;
        }
      });
      return canvas.toDataURL('image/png');
    }

    function drawTrayFallbackMark(ctx, value, x, y, size, color) {
      ctx.save();
      ctx.fillStyle = color;
      ctx.font = `600 ${Math.round(size * 0.46)}px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(value === 'app' ? 'Σ' : String(value || '?').slice(0, 1).toUpperCase(), x + size / 2, y + size / 2 + 1);
      ctx.restore();
    }

    function trayTextCanvasFont(item, fontSize, defaultWeight) {
      const style = item?.fontStyle || 'normal';
      const family = style === 'compactMono'
        ? 'ui-monospace, ".AppleSystemUIFontMonospaced", "SFMono-Regular", "SF Mono", Menlo, monospace'
        : '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
      const weight = style === 'menubar' ? 700 : style === 'compactMono' ? 600 : defaultWeight;
      return `${weight} ${fontSize}px ${family}`;
    }

    function trayTextHorizontalScale(item) {
      if (item?.fontStyle === 'condensed') return 0.86;
      if (item?.fontStyle === 'menubar') return 0.92;
      return 1;
    }

    function trayTextSpaceScale(item) {
      return item?.fontStyle === 'compactMono' ? 0.55 : 1;
    }

    function trayTextRuns(ctx, text, item) {
      const spaceScale = trayTextSpaceScale(item);
      return (String(text).match(/\s+|\S+/g) || ['']).map((value) => {
        const blank = /^\s+$/.test(value);
        return {
          value,
          blank,
          width: ctx.measureText(value).width * (blank ? spaceScale : 1)
        };
      });
    }

    function measureTrayText(ctx, text, item, horizontalScale = 1) {
      return trayTextRuns(ctx, text, item)
        .reduce((width, run) => width + run.width, 0) * horizontalScale;
    }

    function drawTrayText(ctx, text, x, y, item, horizontalScale = 1) {
      const spaceScale = trayTextSpaceScale(item);
      if (spaceScale === 1 && horizontalScale === 1) {
        ctx.fillText(text, x, y);
        return;
      }

      const runs = trayTextRuns(ctx, text, item);
      const rawWidth = runs.reduce((width, run) => width + run.width, 0);
      const alignment = ctx.textAlign;
      const startX = alignment === 'right' || alignment === 'end'
        ? -rawWidth
        : alignment === 'center'
          ? -rawWidth / 2
          : 0;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(horizontalScale, 1);
      ctx.textAlign = 'left';
      let cursor = startX;
      for (const run of runs) {
        if (!run.blank) ctx.fillText(run.value, cursor, 0);
        cursor += run.width;
      }
      ctx.restore();
    }

    function drawCustomTrayProviderBadge(ctx, x, y, size, color) {
      const { trayProviderBadgeLayout } = window.TokenMonitorTrayProviderIcons;
      const layout = trayProviderBadgeLayout(size);
      const badgeX = x + layout.x;
      const badgeY = y + layout.y;
      const { badgeSize, radius, borderWidth } = layout;
      ctx.save();
      roundedRectPath(ctx, badgeX, badgeY, badgeSize, badgeSize, radius);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = borderWidth;
      ctx.strokeStyle = color;
      ctx.stroke();

      // Custom tray images remain macOS template images. Cut the sigma out of the
      // badge alpha so the mark survives the menu-bar tint as negative space.
      const left = badgeX + badgeSize * 0.29;
      const right = badgeX + badgeSize * 0.72;
      const top = badgeY + badgeSize * 0.27;
      const middle = badgeY + badgeSize * 0.5;
      const bottom = badgeY + badgeSize * 0.73;
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.moveTo(right, top);
      ctx.lineTo(left, top);
      ctx.lineTo(badgeX + badgeSize * 0.56, middle);
      ctx.lineTo(left, bottom);
      ctx.lineTo(right, bottom);
      ctx.lineWidth = Math.max(1, badgeSize * 0.13);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#000000';
      ctx.stroke();
      ctx.restore();
    }

    function drawCustomTrayProviderImage(ctx, img, provider, x, y, size, options = {}) {
      const showBadge = options.showProviderBadge === true && provider && provider !== 'app';
      const inset = showBadge ? Math.max(1, Math.round(size * 0.07)) : 0;
      const imageSize = size - inset * 2;
      drawProviderImage(
        ctx,
        img,
        x + inset,
        y + inset,
        imageSize,
        options.providerContrastHalo === true,
        trayGlyphInk(options, img)
      );
      if (showBadge) {
        drawCustomTrayProviderBadge(
          ctx,
          x,
          y,
          size,
          options.templateIconColor || options.textColor || '#000000'
        );
      }
    }

    function renderCustomTrayItemCanvas(item, height = 44, colors = {}, options = {}) {
      const trackColor = colors.track || 'rgba(0, 0, 0, 0.32)';
      const fillColor = colors.fill || 'rgba(0, 0, 0, 1)';
      const textColor = colors.text || fillColor;
      const h = Math.max(16, Math.round(height));

      if (item.type === 'spacer') {
        const isDot = item.variant === 'dot';
        const ratios = isDot
          ? { narrow: 0.18, regular: 0.24, wide: 0.34 }
          : { narrow: 0.07, regular: 0.14, wide: 0.27 };
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(2, Math.round(h * (ratios[item.size] || ratios.regular)));
        canvas.height = h;
        if (isDot) {
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = textColor;
          ctx.beginPath();
          ctx.arc(canvas.width / 2, h / 2, Math.max(1, h * 0.055), 0, Math.PI * 2);
          ctx.fill();
        } else if (options.spacerGuide) {
          const ctx = canvas.getContext('2d');
          ctx.strokeStyle = trackColor;
          ctx.setLineDash([1, 2]);
          ctx.beginPath();
          ctx.moveTo(0.5, h * 0.2);
          ctx.lineTo(0.5, h * 0.8);
          ctx.moveTo(canvas.width - 0.5, h * 0.2);
          ctx.lineTo(canvas.width - 0.5, h * 0.8);
          ctx.stroke();
        }
        return canvas;
      }

      if (item.type === 'icon') {
        const canvas = document.createElement('canvas');
        canvas.width = h;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        const provider = item.provider || 'app';
        const providerImage = trayProviderImages[provider];
        if (providerImage) {
          drawCustomTrayProviderImage(
            ctx,
            providerImage,
            provider,
            0,
            0,
            h,
            { ...options, textColor }
          );
        } else {
          drawTrayFallbackMark(ctx, provider, 0, 0, h, textColor);
        }
        return canvas;
      }

      if (item.type === 'bars') {
        const { trayBarFillWidth, trayBarsLayout } = window.TokenMonitorTrayBars;
        const showIcon = item.icon !== 'none';
        const barLayout = trayBarsLayout(h, { contentOnly: !showIcon });
        const canvas = document.createElement('canvas');
        canvas.width = barLayout.width;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        const rows = item.rows.length > 1 ? item.rows.slice(0, 2) : item.rows.slice(0, 1);
        const drawBar = (row, y) => {
          roundedRectPath(ctx, barLayout.barsX, y, barLayout.barsWidth, barLayout.barHeight, barLayout.radius);
          ctx.fillStyle = trackColor;
          ctx.fill();
          const fillWidth = trayBarFillWidth(row.percent, barLayout.barsWidth);
          if (!fillWidth) return;
          ctx.save();
          roundedRectPath(ctx, barLayout.barsX, y, barLayout.barsWidth, barLayout.barHeight, barLayout.radius);
          ctx.clip();
          ctx.fillStyle = fillColor;
          ctx.fillRect(barLayout.barsX, y, fillWidth, barLayout.barHeight);
          ctx.restore();
        };
        if (showIcon) {
          const preferredIndex = item.icon === 'second' ? 1 : 0;
          const provider = item.icon === 'app'
            ? 'app'
            : trayLayoutApi.preferredRowProvider(rows, preferredIndex);
          const providerImage = trayProviderImages[provider];
          if (providerImage) {
            drawCustomTrayProviderImage(
              ctx,
              providerImage,
              provider,
              barLayout.padX,
              barLayout.iconY,
              barLayout.iconSize,
              { ...options, textColor }
            );
          } else {
            drawTrayFallbackMark(ctx, provider || '?', barLayout.padX, barLayout.iconY, barLayout.iconSize, textColor);
          }
        }
        const ys = rows.length > 1
          ? [barLayout.barsStartY, barLayout.barsStartY + barLayout.barHeight + barLayout.barGap]
          : [Math.round((h - barLayout.barHeight) / 2)];
        rows.forEach((row, index) => {
          drawBar(row, ys[index]);
        });
        return canvas;
      }

      if (item.type === 'stack') {
        const rows = item.rows.slice(0, 2);
        const showIcon = item.icon !== 'none';
        const preferredIndex = item.icon === 'second' ? 1 : 0;
        const provider = item.icon === 'app'
          ? 'app'
          : trayLayoutApi.preferredRowProvider(rows, preferredIndex);
        const iconSize = h;
        const iconGap = Math.max(2, Math.round(h * 0.08));
        const fontSize = Math.max(8, Math.round(h * 0.43));
        const font = trayTextCanvasFont(item, fontSize, 600);
        const horizontalScale = trayTextHorizontalScale(item);
        const measure = document.createElement('canvas').getContext('2d');
        measure.font = font;
        const textWidth = Math.max(
          ...rows.map((row) => measureTrayText(measure, row.text || '--', item, horizontalScale)),
          1
        );
        const padX = Math.max(1, Math.round(h * 0.04));
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(textWidth) + padX * 2 + (showIcon ? iconSize + iconGap : 0);
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        const alignment = item.alignment === 'left' ? 'left' : 'right';
        let textX = alignment === 'right' ? canvas.width - padX : padX;
        if (showIcon) {
          const providerImage = trayProviderImages[provider];
          if (providerImage) {
            drawCustomTrayProviderImage(
              ctx,
              providerImage,
              provider,
              0,
              0,
              iconSize,
              { ...options, textColor }
            );
          } else {
            drawTrayFallbackMark(ctx, provider || '?', 0, 0, iconSize, textColor);
          }
          if (alignment === 'left') textX += iconSize + iconGap;
        }
        ctx.font = font;
        ctx.textBaseline = 'middle';
        ctx.textAlign = alignment;
        const textBaselineOffset = Math.max(1, Math.round(h * 0.025));
        rows.forEach((row, index) => {
          ctx.fillStyle = row.available === false ? trackColor : textColor;
          drawTrayText(
            ctx,
            row.text || '--',
            textX,
            h * (index === 0 ? 0.28 : 0.72) + textBaselineOffset,
            item,
            horizontalScale
          );
        });
        return canvas;
      }

      const text = item.text || '--';
      const fontSize = Math.round(h * 0.68);
      const font = trayTextCanvasFont(item, fontSize, 500);
      const horizontalScale = trayTextHorizontalScale(item);
      const measure = document.createElement('canvas').getContext('2d');
      measure.font = font;
      const padX = Math.max(1, Math.round(h * 0.04));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(measureTrayText(measure, text, item, horizontalScale)) + padX * 2);
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.font = font;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = item.available === false ? trackColor : textColor;
      drawTrayText(ctx, text, padX, h / 2 + 1, item, horizontalScale);
      return canvas;
    }

    function renderCustomTrayLayout(stats, layout, height = 44, colors = {}, options = {}) {
      const codexProviders = (stats?.limits?.providers || []).filter((provider) => provider?.provider === 'codex');
      const selectedCodexKey = String(getState().codexActiveAccount?.accountKey || '').trim();
      const detectedCodexKey = String(localLiveCodexProvider()?.accountKey || '').trim();
      const activeCodexKey = [selectedCodexKey, detectedCodexKey].find((accountKey) => (
        accountKey && codexProviders.some((provider) => provider.accountKey === accountKey)
      )) || '';
      const resolved = trayLayoutApi.resolveTrayLayout(layout, stats, {
        currency: currentCurrency(),
        ...compactTokenDisplayOptions(),
        nowMs: Date.now(),
        activeAccountKeys: activeCodexKey ? { codex: activeCodexKey } : {},
        availableProviderIds: Object.keys(trayProviderImages),
        liveTokenRates: options.liveTokenRates || displayLiveTokenRateSamples(),
        liveTokenRateFormatter: options.liveTokenRateFormatter || ((value) => formatLiveTokenRate(value))
      });
      const items = resolved.items.map((item) => (
        item.type === 'text'
          && item.metric === 'account'
          && getState().settings?.maskLimitAccountEmails === true
          ? { ...item, text: accountIdentityApi.maskEmailAddress(item.text) }
          : item
      ));
      const segments = items.map((item) => renderCustomTrayItemCanvas(item, height, colors, options));
      if (!segments.length) return null;
      const gap = Math.max(1, Math.round(height * 0.03));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, segments.reduce((width, segment) => width + segment.width, 0) + gap * Math.max(0, segments.length - 1));
      canvas.height = Math.max(16, Math.round(height));
      const ctx = canvas.getContext('2d');
      let x = 0;
      for (const segment of segments) {
        ctx.drawImage(segment, x, 0);
        x += segment.width + gap;
      }
      return canvas.toDataURL('image/png');
    }

    function barsDataUrlForMode(mode, size = 44, colors, options = {}) {
      const stats = options.stats || getState().stats;
      if (mode === 'barsAllSessions') return renderAllSessionsIcon(stats, size, configuredLimitProviderOrder(), colors, options);
      const pickers = { barsSession: pickWorstSessionProvider, barsWeekly: pickWorstWeeklyProvider };
      return renderBarsIcon(stats, size, pickers[mode] || pickWorstProvider, colors, options);
    }

    function liveTokenRateTrayLayout() {
      return {
        version: trayLayoutApi.VERSION,
        items: [
          trayLayoutApi.createTrayLayoutItem('appIcon', { idFactory: () => 'live-rate-app-icon' }),
          trayLayoutApi.createTrayLayoutItem('liveTokenRate', { idFactory: () => 'live-rate-value' })
        ]
      };
    }

    function trayDataUrlForMode(mode, size = 44, colors, options = {}) {
      if (mode === 'liveTokenRate') {
        return renderCustomTrayLayout(
          options.stats || getState().stats || statsForTrayComposer(),
          liveTokenRateTrayLayout(),
          size,
          colors,
          options
        );
      }
      if (mode === 'custom') {
        return renderCustomTrayLayout(
          options.stats || getState().stats || statsForTrayComposer(),
          options.layout || getState().settings?.trayCustomLayout,
          size,
          colors,
          {
            showProviderBadge: getState().settings?.showTrayProviderBadge === true,
            ...options
          }
        );
      }
      if (mode === 'limitsAllSessions') {
        return renderLimitSessionsIcon(options.stats || getState().stats, size, configuredLimitProviderOrder(), colors, options);
      }
      return barsDataUrlForMode(mode, size, colors, options);
    }

    function loadImage(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`load failed: ${src}`));
        img.src = src;
      });
    }

    function providerImageToPngDataUrl(img, size, showBadge = false, options = {}) {
      const { trayProviderBadgeLayout } = window.TokenMonitorTrayProviderIcons;
      const layout = trayProviderBadgeLayout(size);
      const canvas = document.createElement('canvas');
      canvas.width = layout.iconSize;
      canvas.height = layout.iconSize;
      const ctx = canvas.getContext('2d');
      const imageInset = showBadge ? Math.max(1, Math.round(layout.iconSize * 0.07)) : 0;
      const imageSize = layout.iconSize - imageInset * 2;
      // Only the tray delivery marks itself standalone: there the mark is the whole
      // icon and Windows expects it to fill its cell. The composer's provider picker
      // renders previews through here too and keeps the composed optical inset.
      const optical = { standalone: options.standalone === true, platform: getState().appInfo?.platform };
      if (showBadge) {
        ctx.save();
        ctx.shadowColor = 'rgba(255, 255, 255, 0.95)';
        ctx.shadowBlur = Math.max(2, Math.round(layout.iconSize * 0.1));
        paintProviderImage(ctx, img, imageInset, imageInset, imageSize, '', optical);
        ctx.restore();
      }
      drawProviderImage(
        ctx,
        img,
        imageInset,
        imageInset,
        imageSize,
        false,
        trayGlyphInk({ templateIconColor: options.templateColor, trayInk: options.trayInk }, img),
        optical
      );

      if (!showBadge) return canvas.toDataURL('image/png');

      const { x, y, badgeSize, radius, borderWidth } = layout;
      roundedRectPath(ctx, x, y, badgeSize, badgeSize, radius);
      ctx.fillStyle = '#1688f8';
      ctx.fill();
      ctx.lineWidth = borderWidth;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      // Draw the project's sigma mark as geometry so it remains crisp without a font dependency.
      const left = x + badgeSize * 0.29;
      const right = x + badgeSize * 0.72;
      const top = y + badgeSize * 0.27;
      const middle = y + badgeSize * 0.5;
      const bottom = y + badgeSize * 0.73;
      ctx.beginPath();
      ctx.moveTo(right, top);
      ctx.lineTo(left, top);
      ctx.lineTo(x + badgeSize * 0.56, middle);
      ctx.lineTo(left, bottom);
      ctx.lineTo(right, bottom);
      ctx.lineWidth = Math.max(2, badgeSize * 0.13);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      return canvas.toDataURL('image/png');
    }
    return { trayProviderImages, trayProviderImageIds, renderCustomTrayItemCanvas, renderCustomTrayLayout, trayDataUrlForMode, loadImage, providerImageToPngDataUrl };
  }
  return { createTrayImageRenderer };
});
