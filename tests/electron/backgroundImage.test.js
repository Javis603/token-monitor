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

  const dataUrl = await importBackgroundImage(source, userData, nativeImage);
  await fs.promises.unlink(source);
  assert.equal(await getBackgroundImage(userData), dataUrl);
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

test('custom image layer is not covered by an opaque glass tint', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /[.]shell[.]has-custom-background\s*\{\s*background:\s*transparent;/);
  assert.match(css, /[.]shell[.]has-custom-background::before\s*\{[^}]*background-image:[^;]*var\(--custom-background-image\);[^}]*opacity:\s*var\(--glass-alpha\);/);
  assert.doesNotMatch(css, /linear-gradient\(var\(--glass\), var\(--glass\)\), var\(--custom-background-image\)/);
});
