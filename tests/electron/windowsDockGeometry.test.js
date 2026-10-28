'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { compileWindowsDock } = require('../../scripts/build-windows-dock');
const shapes = require('../../src/electron/renderer/edgeDock/shapes');
const { rasterizeMask } = require('../../src/electron/edgeDock/mask');
const { EDGE_DOCK_METRICS: m } = require('../../src/electron/edgeDock/geometry');

test('native Direct2D curves agree with renderer masks at supported sides and DPI scales', { skip: process.platform !== 'win32' }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-curves-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const checks = [];
  for (const scale of [1, 1.25, 1.5, 2]) for (const side of ['left', 'right']) {
    const samples = [
      [shapes.railCommands({ width: m.railWidth, height: 600, side, shoulder: m.shoulder, radius: m.railRadius }), m.railWidth, 600],
      [shapes.peekCommands({ width: 14, height: 88, handleWidth: 8, handleLength: 36, side }), 14, 88],
      [shapes.bubbleCommands({ width: 320, height: 210, tail: 18, tailY: 72, neck: 16, radius: 16, side }), 320, 210],
      [shapes.refreshCommands({ width: 24, height: 24 }), 24, 24]
    ];
    for (const [index, [commands, width, height]] of samples.entries()) {
      const scaled = commands.map(([op, ...values]) => [op, ...values.map((n) => n * scale)]);
      const w = Math.round(width * scale); const h = Math.round(height * scale);
      const { buffer } = rasterizeMask(shapes.toPolygons(scaled), w, h, 1);
      const points = [];
      for (let yi = 0; yi < 20; yi++) for (let xi = 0; xi < 12; xi++) {
        const x = Math.floor(xi * (w - 1) / 11); const y = Math.floor(yi * (h - 1) / 19);
        const alpha = buffer[(y * w + x) * 4 + 3];
        if (alpha <= 4 || alpha >= 251) points.push({ x: x + .5, y: y + .5, inside: alpha >= 251 });
      }
      checks.push({ name: `${index}/${side}/${scale}`, commands: scaled, points });
    }
  }
  const input = path.join(directory, 'curves.json');
  const output = path.join(directory, 'curves.exe');
  fs.writeFileSync(input, JSON.stringify(checks));
  compileWindowsDock({ output, target: 'exe', sources: [
    path.resolve(__dirname, '../../src/windows-dock/NativeCurve.cs'),
    path.resolve(__dirname, '../windows-dock/NativeCurveChecks.cs')
  ] });
  const result = execFileSync(output, [input], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.trim(), `${checks.length} native shapes / ${checks.reduce((sum, check) => sum + check.points.length, 0)} mask points`);
});
