// System vitals views for the edge dock: one ring cell per metric (compact
// variant, drawn like the host's quota rings) and one hover card (full
// variant) with the recent-load curve. Both views share one backend series;
// each mount subscribes on its own and repaints in place.

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 17;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const SPARK_POINTS = 90;

const LABELS = {
  cpu: { en: 'CPU', 'zh-CN': 'CPU', 'zh-TW': 'CPU' },
  mem: { en: 'MEM', 'zh-CN': '内存', 'zh-TW': '記憶體' }
};
const CAPTIONS = {
  en: (minutes) => `Last ${minutes} min`,
  'zh-CN': (minutes) => `最近 ${minutes} 分钟`,
  'zh-TW': (minutes) => `最近 ${minutes} 分鐘`
};
const NOTES = {
  load: {
    en: (avg) => `Load ${avg}`,
    'zh-CN': (avg) => `负载 ${avg}`,
    'zh-TW': (avg) => `負載 ${avg}`
  },
  waiting: {
    en: 'Waiting for a reading…',
    'zh-CN': '等待读数…',
    'zh-TW': '等待讀數…'
  }
};

function locale() {
  const lang = document.documentElement?.lang || navigator.language || 'en';
  const key = String(lang).toLowerCase();
  if (key.startsWith('zh')) return key.includes('tw') || key.includes('hk') || key.includes('hant') ? 'zh-TW' : 'zh-CN';
  return 'en';
}

function metricLabel(metric) {
  const table = LABELS[metric] || LABELS.cpu;
  return table[locale()] || table.en;
}

// A quota ring drains toward empty; a vital fills toward full. Same geometry
// as the host's rings, mirrored semantics; the severity colour mirrors too.
function severityColor(percent) {
  if (percent >= 90) return 'var(--red, #e5484d)';
  if (percent >= 70) return 'var(--orange, #f5a623)';
  return 'var(--accent, #4cb782)';
}

// Fixed 0-100 axis: a rescaled line would let a quiet machine look busy. Null
// ticks (before a first reading) are skipped; the line starts at the first one.
function sparkSvg(points, color) {
  const width = 100;
  const height = 40;
  const samples = (points || []).slice(-SPARK_POINTS).filter((value) => Number.isFinite(value));
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'sv-spark');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const guide = document.createElementNS(SVG_NS, 'line');
  guide.setAttribute('class', 'sv-spark-guide');
  guide.setAttribute('x1', '0');
  guide.setAttribute('x2', String(width));
  guide.setAttribute('y1', String(height / 2));
  guide.setAttribute('y2', String(height / 2));
  svg.append(guide);
  if (samples.length >= 2) {
    const stepX = width / (samples.length - 1);
    const toY = (value) => height - (Math.max(0, Math.min(100, value)) / 100) * (height - 4) - 2;
    const coords = samples.map((value, index) => `${(index * stepX).toFixed(2)},${toY(value).toFixed(2)}`);
    const line = `M${coords.join(' L')}`;
    const area = `${line} L${width},${height} L0,${height} Z`;
    const areaPath = document.createElementNS(SVG_NS, 'path');
    areaPath.setAttribute('class', 'sv-spark-area');
    areaPath.setAttribute('d', area);
    areaPath.style.fill = color;
    const linePath = document.createElementNS(SVG_NS, 'path');
    linePath.setAttribute('class', 'sv-spark-line');
    linePath.setAttribute('d', line);
    linePath.style.stroke = color;
    svg.append(areaPath, linePath);
  }
  return svg;
}

function compactBytes(value) {
  const gib = Math.max(0, Number(value) || 0) / 2 ** 30;
  if (gib >= 10) return `${Math.round(gib)}G`;
  if (gib >= 1) return `${gib.toFixed(1)}G`;
  return `${Math.round((Number(value) || 0) / 2 ** 20)}M`;
}

function readPercent(value, metric) {
  const percent = value ? Number(value[metric]) : NaN;
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
}

export function activate(ctx) {
  return {
    mount(container, context = {}) {
      const metric = context.viewId === 'mem' ? 'mem' : 'cpu';
      const lang = locale();
      let latest = context.data || null;
      let unsubscribe = null;

      if (context.variant === 'full') {
        // The hover card: the percent headline over the recent-load curve,
        // with the metric's own sub-line (load average or used footprint).
        const root = document.createElement('div');
        root.className = 'sv-card';
        const headline = document.createElement('div');
        headline.className = 'sv-headline';
        const strong = document.createElement('strong');
        headline.append(strong);
        const sparkSlot = document.createElement('div');
        sparkSlot.className = 'sv-spark-slot';
        const caption = document.createElement('div');
        caption.className = 'sv-caption';
        const note = document.createElement('div');
        note.className = 'sv-note';
        root.append(headline, sparkSlot, caption, note);
        container.append(root);

        function renderUnknown() {
          strong.textContent = '—';
          strong.style.color = '';
          sparkSlot.replaceChildren(sparkSvg([], null));
          caption.textContent = '';
          note.textContent = NOTES.waiting[lang];
        }
        function render(value) {
          const percent = readPercent(value, metric);
          if (percent === null) {
            renderUnknown();
            return;
          }
          const color = severityColor(percent);
          strong.textContent = `${Math.round(percent)}%`;
          strong.style.color = color;
          const series = (value.history || []).map((point) => (point ? point[metric] : null));
          sparkSlot.replaceChildren(sparkSvg(series, color));
          const stepMs = Number(value.historyStepMs) || 2000;
          const drawn = series.filter((entry) => Number.isFinite(entry)).length;
          const minutes = Math.max(1, Math.round(((drawn - 1) * stepMs) / 60000));
          caption.textContent = (CAPTIONS[lang] || CAPTIONS.en)(minutes);
          if (metric === 'mem' && Number.isFinite(value.memUsedBytes) && Number.isFinite(value.memTotalBytes)) {
            note.textContent = `${compactBytes(value.memUsedBytes)} / ${compactBytes(value.memTotalBytes)}`;
          } else if (metric === 'cpu' && Array.isArray(value.loadAvg) && value.loadAvg.some(Number.isFinite)) {
            note.textContent = (NOTES.load[lang] || NOTES.load.en)(value.loadAvg.map((entry) => Number(entry).toFixed(2)).join(' / '));
          } else {
            note.textContent = '';
          }
        }

        render(latest);
        unsubscribe = ctx.backend.subscribe((value) => {
          latest = value;
          render(value);
        });
        return {
          update(next) {
            if (next?.data && next.data !== latest) {
              latest = next.data;
              render(latest);
            }
          },
          dispose() {
            unsubscribe?.();
            unsubscribe = null;
            root.remove();
          }
        };
      }

      // Compact rail cell: the ring with the metric's name inside and the
      // percent beneath, matching the host quota cells' 70px rhythm.
      const root = document.createElement('div');
      root.className = 'sv-cell';
      const ring = document.createElement('div');
      ring.className = 'sv-ring';
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 42 42');
      svg.setAttribute('aria-hidden', 'true');
      const track = document.createElementNS(SVG_NS, 'circle');
      track.setAttribute('class', 'sv-ring-track');
      const fillArc = document.createElementNS(SVG_NS, 'circle');
      fillArc.setAttribute('class', 'sv-ring-fill');
      for (const circle of [track, fillArc]) {
        circle.setAttribute('cx', '21');
        circle.setAttribute('cy', '21');
        circle.setAttribute('r', String(RING_RADIUS));
      }
      fillArc.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
      fillArc.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
      fillArc.setAttribute('transform', 'rotate(-90 21 21)');
      svg.append(track, fillArc);
      const label = document.createElement('span');
      label.className = 'sv-ring-label';
      label.textContent = metricLabel(metric);
      const value = document.createElement('span');
      value.className = 'sv-value';
      ring.append(svg, label);
      root.append(ring, value);
      container.append(root);

      function renderCell(entry) {
        const percent = readPercent(entry, metric);
        if (percent === null) {
          root.classList.add('is-idle');
          fillArc.style.opacity = '0';
          value.textContent = '—';
          value.style.color = '';
          return;
        }
        root.classList.remove('is-idle');
        fillArc.style.opacity = '1';
        fillArc.style.stroke = severityColor(percent);
        fillArc.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE * (1 - percent / 100)));
        value.textContent = `${Math.round(percent)}%`;
        value.style.color = percent >= 70 ? severityColor(percent) : '';
      }

      renderCell(latest);
      unsubscribe = ctx.backend.subscribe((next) => {
        latest = next;
        renderCell(next);
      });
      return {
        update(next) {
          if (next?.data && next.data !== latest) {
            latest = next.data;
            renderCell(latest);
          }
        },
        dispose() {
          unsubscribe?.();
          unsubscribe = null;
          root.remove();
        }
      };
    }
  };
}
