// Token Pulse — an example plugin with sandboxed logic.
//
// Runs in a Worker with no network, DOM or Node access. Everything it knows
// arrives through tm.subscribe(); everything it shows leaves through
// tm.publish() as data the host validates and draws.

const BARS = 40;
const RUNAWAY_DEFAULT = 200000; // tokens per minute
const history = [];
let runawaySince = null;
let notifiedAt = null;

// Reuse the host's matched-counter rate. Differencing today's total would
// mistake startup hydration and historical reconciliation for new activity.
tm.subscribe('tm.rate');
tm.subscribe('sys.cpu');

function tokensPerMinute() {
  const sample = tm.read('tm.rate');
  if (!sample || typeof sample.burn !== 'number') return null;
  return sample.idle ? 0 : Math.max(0, Math.round(sample.burn));
}

function equalizer(width, height, values, cpu, { gap = 2, labels = true, columns = BARS } = {}) {
  const max = Math.max(1, ...values);
  const barWidth = Math.max(1, (width - gap * (columns - 1)) / columns);
  const list = [];
  values.forEach((value, index) => {
    const x = index * (barWidth + gap) + (columns - values.length) * (barWidth + gap);
    const h = Math.max(1.5, (value / max) * (height - (labels ? 12 : 2)));
    list.push({
      op: 'rect', x, y: height - h, w: barWidth, h, r: Math.min(1.5, barWidth / 2),
      fill: index === values.length - 1 ? 'accent' : 'chart',
      o: 0.35 + 0.65 * ((index + 1) / values.length)
    });
  });
  if (cpu.length > 1) {
    const points = [];
    cpu.forEach((value, index) => {
      const x = (columns - cpu.length + index) * (barWidth + gap) + barWidth / 2;
      points.push(x, height - (Math.max(0, Math.min(100, value)) / 100) * (height - 2) - 1);
    });
    list.push({ op: 'poly', points, stroke: 'warn', sw: 1.25, o: 0.8 });
  }
  if (labels) list.push({ op: 'text', x: 0, y: 9, text: 'CPU', size: 8, fill: 'warn', o: 0.8 });
  return list;
}

tm.onTick(async ({ mode, now }) => {
  const rate = tokensPerMinute();
  if (rate === null) return;
  const cpu = tm.read('sys.cpu');
  history.push({ rate, cpu: typeof cpu === 'number' ? cpu : null });
  if (history.length > BARS) history.shift();
  const rates = history.map((entry) => entry.rate);
  const cpus = history.map((entry) => entry.cpu).filter((value) => value !== null);

  if (mode === 'visible') {
    tm.publish('tpm', rate);
    tm.publish('peak', `peak ${Math.max(...rates).toLocaleString()} / min`);
    tm.publish('pulse', equalizer(400, 120, rates, cpus));
    tm.publish('mini', equalizer(30, 22, rates.slice(-10), [], { gap: 1, labels: false, columns: 10 }));
  }

  // The same duration applies to fast visible ticks and slow background ticks.
  const threshold = (await tm.storage.get('runawayThreshold')) || RUNAWAY_DEFAULT;
  if (rate <= threshold) {
    runawaySince = null;
    return;
  }
  if (runawaySince === null) runawaySince = now;
  if (now - runawaySince >= 60_000 && (notifiedAt === null || now - notifiedAt >= 30 * 60_000)) {
    notifiedAt = now;
    await tm.notify({ title: 'Runaway agent?', body: `${rate.toLocaleString()} tokens/min for over a minute.` });
  }
});
