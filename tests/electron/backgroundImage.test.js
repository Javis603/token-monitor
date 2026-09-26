'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  backgroundImagePath,
  clearBackgroundImage,
  getBackgroundImage,
  importBackgroundImage
} = require('../../src/electron/backgroundImage');

test('chosen background survives source removal and can be cleared', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'token-background-test-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'chosen.png');
  const userData = path.join(dir, 'userData');
  await fs.promises.mkdir(userData);
  await fs.promises.writeFile(source, Buffer.from('source'));
  const output = Buffer.from('converted-png');
  const nativeImage = {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 120, height: 80 }),
      toPNG: () => output
    })
  };

  const bytes = await importBackgroundImage(source, userData, nativeImage);
  await fs.promises.unlink(source);
  assert.deepEqual(await getBackgroundImage(userData), bytes);
  assert.deepEqual(await fs.promises.readFile(backgroundImagePath(userData)), output);
  await clearBackgroundImage(userData);
  assert.equal(await getBackgroundImage(userData), null);
  await clearBackgroundImage(userData);
});

test('invalid replacement preserves the previous background', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'token-background-test-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'chosen.jpg');
  const userData = path.join(dir, 'userData');
  await fs.promises.mkdir(userData);
  await fs.promises.writeFile(source, Buffer.from('source'));
  let resizedTo;
  await importBackgroundImage(source, userData, {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 4000, height: 2000 }),
      resize: (size) => {
        resizedTo = size;
        return { toPNG: () => Buffer.from('first') };
      }
    })
  });
  assert.deepEqual(resizedTo, { width: 2000, height: 1000 });
  await assert.rejects(importBackgroundImage(source, userData, {
    createFromBuffer: () => ({ isEmpty: () => true })
  }), /not supported/);
  assert.deepEqual(await fs.promises.readFile(backgroundImagePath(userData)), Buffer.from('first'));
});

test('custom image layers over the glass instead of replacing it', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'styles.css'), 'utf8');
  // The shell keeps its own glass while an image is set. Clearing it made the
  // image stand in for the glass, so the glass slider ended up driving the image.
  assert.doesNotMatch(css, /[.]shell[.]has-custom-background\s*\{/);
  const layer = css.match(/[.]shell[.]has-custom-background::before\s*\{([^}]*)\}/)?.[1];
  assert.match(layer, /z-index:\s*-1;/);
  assert.match(layer, /background-image:[^;]*var\(--custom-background-image\);/);
  assert.match(layer, /opacity:\s*var\(--background-image-alpha, 0[.]28\);/);
  // One rule for every material, so the image slider means the same thing under
  // native Liquid Glass as it does over the app's own glass.
  assert.doesNotMatch(css, /native-liquid-glass [.]shell[.]has-custom-background::before/);
  assert.match(css, /html[.]native-reduced-transparency [.]shell[.]has-custom-background::before\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(css, /linear-gradient\(var\(--glass\), var\(--glass\)\), var\(--custom-background-image\)/);
});

test('image opacity has its own slider, shown only while an image is set', () => {
  const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  assert.match(html, /id="backgroundImageOpacityRow" class="[^"]*\bhidden\b/);
  assert.match(html, /id="backgroundImageOpacityInput" type="range" min="0" max="100"/);
  assert.match(app, /backgroundImageOpacityRow\?[.]classList[.]toggle\('hidden', !backgroundImageActive\)/);
  assert.match(app, /setProperty\('--background-image-alpha'/);
  // An invalid opacity in CSS resolves to 1, so NaN must fall back before it gets there.
  assert.match(app, /Number[.]isFinite\(requestedImageOpacity\) \? requestedImageOpacity : defaultAppearance[.]backgroundImageOpacity/);
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  assert.match(main, /backgroundImageOpacity: normalizeBackgroundImageOpacity\(/);
  assert.match(main, /function normalizeBackgroundImageOpacity\(value\) \{[^}]*Number[.]isFinite\(opacity\) \? Math[.]max\(0, Math[.]min\(100, opacity\)\) : 28;/);
  // Native material locks the glass sliders; the image slider must stay usable.
  const locked = app.match(/for \(const control of \[([^\]]*)\]\) \{\n\s*if \(control\) control[.]disabled = nativeMaterial;/)?.[1];
  assert.ok(locked, 'native-material lock loop should exist');
  assert.doesNotMatch(locked, /backgroundImageOpacity/);
});
