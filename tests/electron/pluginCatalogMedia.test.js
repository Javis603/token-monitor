'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCatalogMedia } = require('../../src/electron/plugins/catalogMedia');
const { renderReadme } = require('../../src/electron/plugins/catalogReadme');
const { repositoryImageUrl, imageBudget, MAX_IMAGE_BYTES } = require('../../src/electron/plugins/catalogImagePolicy');
const baseUrl = 'https://raw.githubusercontent.com/owner/plugin/main/docs/README.md';
const url = 'https://raw.githubusercontent.com/owner/plugin/main/docs/image.png';
function png(width = 20, height = 10, length = 33) {
  const bytes = Buffer.alloc(length); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); bytes[24] = 8; bytes[25] = 2; return bytes;
}
function native(width = 20, height = 10, output = Buffer.from('png'), onDecode = () => {}) {
  const image = { isEmpty: () => false, getSize: () => ({ width, height }), resize: () => image, toPNG: () => output };
  return { createFromBuffer() { onDecode(); return image; } };
}
const options = (budget = imageBudget(), signal = new AbortController().signal) => ({ baseUrl, signal, budget });
test('README images are restricted to the same raw GitHub repository on standard HTTPS', async t => {
  const blocked = [
    'https://127.0.0.1/private', 'https://[::1]/private', 'https://192.168.1.1/private', 'https://internal.example/private',
    'https://raw.githubusercontent.com.evil.test/owner/plugin/main/a.png', 'http://raw.githubusercontent.com/owner/plugin/main/a.png',
    'https://raw.githubusercontent.com:8443/owner/plugin/main/a.png', 'https://user@raw.githubusercontent.com/owner/plugin/main/a.png',
    'https://raw.githubusercontent.com/other/plugin/main/a.png', 'https://raw.githubusercontent.com/owner/other/main/a.png',
    'https://raw.githubusercontent.com/owner/plugin/main/a.png?token=secret', 'https://raw.githubusercontent.com/owner/plugin/main/a.png#x',
    'https://raw.githubusercontent.com/owner/plugin/main/%2fsecret.png'
  ];
  let requests = 0;
  const media = createCatalogMedia({ fetchImpl: async () => { requests++; return new Response(png()); }, nativeImage: native() }); t.after(() => media.dispose());
  for (const candidate of blocked) {
    assert.equal(repositoryImageUrl(candidate, baseUrl), null, candidate);
    await assert.rejects(media.load(candidate, options()), /repository/);
  }
  assert.equal(requests, 0);
  assert.equal(repositoryImageUrl('../images/demo.png', baseUrl), 'https://raw.githubusercontent.com/owner/plugin/main/images/demo.png');
  assert.equal(repositoryImageUrl('https://raw.githubusercontent.com:443/owner/plugin/main/a.png', baseUrl), 'https://raw.githubusercontent.com/owner/plugin/main/a.png');
});
test('README image slots are capped without fetching blocked or excess images', () => {
  const text = Array.from({ length: 20 }, (_, i) => `![Shot ${i}](images/${i}.png)`).join('\n\n') + '\n\n![External](https://internal.example/image.png)';
  const result = renderReadme(text, 'https://github.com/owner/plugin/blob/main/docs/README.md', baseUrl);
  assert.equal(result.images.length, 8); assert.equal((result.html.match(/data-readme-image=/g) || []).length, 8);
  assert.match(result.html, /Shot 19/); assert.match(result.html, /External/);
});
test('oversized dimensions are rejected from headers before native decoding', async t => {
  let decoded = 0;
  const media = createCatalogMedia({ fetchImpl: async () => new Response(png(100000, 100000)), nativeImage: native(20, 10, undefined, () => decoded++) }); t.after(() => media.dispose());
  await assert.rejects(media.load(url, options()), /dimensions/); assert.equal(decoded, 0);
});
test('non-raster and truncated images cannot reach native decoding', async t => {
  let decoded = 0, bytes = Buffer.from('<svg/>');
  const media = createCatalogMedia({ fetchImpl: async () => new Response(bytes), nativeImage: native(20, 10, undefined, () => decoded++) }); t.after(() => media.dispose());
  await assert.rejects(media.load(url, options()), /PNG or JPEG/);
  bytes = png().subarray(0, 12); await assert.rejects(media.load(url, options())); assert.equal(decoded, 0);
});
test('redirect responses are rejected without contacting their targets', async t => {
  let requests = 0;
  const media = createCatalogMedia({ fetchImpl: async (_url, init) => { requests++; assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit'); return new Response('', { status: 302, headers: { location: 'https://127.0.0.1/private' } }); }, nativeImage: native() }); t.after(() => media.dispose());
  await assert.rejects(media.load(url, options()), /redirect/); assert.equal(requests, 1);
});
test('cumulative download bytes are bounded even when a later image exceeds the remaining budget', async t => {
  let requests = 0, decoded = 0; const budget = imageBudget();
  const media = createCatalogMedia({ fetchImpl: async () => { requests++; return new Response(png(20, 10, 3 * 1024 * 1024)); }, nativeImage: native(20, 10, undefined, () => decoded++) }); t.after(() => media.dispose());
  await media.load(url, options(budget)); await media.load(url, options(budget));
  await assert.rejects(media.load(url, options(budget)), /size limit/);
  await assert.rejects(media.load(url, options(budget)), /budget exhausted/);
  assert.equal(requests, 3); assert.equal(decoded, 2); assert.equal(budget.download, 0);
});
test('cumulative output budget prevents further decoding and downloads', async t => {
  let requests = 0; const budget = imageBudget();
  const media = createCatalogMedia({ fetchImpl: async () => { requests++; return new Response(png()); }, nativeImage: native(20, 10, Buffer.alloc(MAX_IMAGE_BYTES)) }); t.after(() => media.dispose());
  await media.load(url, options(budget)); await media.load(url, options(budget));
  await assert.rejects(media.load(url, options(budget)), /budget exhausted/); assert.equal(requests, 2); assert.equal(budget.output, 0);
});
test('cumulative pixel budget is checked before each decode', async t => {
  let requests = 0; const budget = imageBudget();
  const media = createCatalogMedia({ fetchImpl: async () => { requests++; return new Response(png(4000, 4000)); }, nativeImage: native(4000, 4000) }); t.after(() => media.dispose());
  await media.load(url, options(budget)); await assert.rejects(media.load(url, options(budget)), /budget exhausted/); assert.equal(requests, 1);
});
test('decodes are serialized and closing a document cancels active and queued image loads', async t => {
  let finish, requestSignal, requests = 0, decoded = 0; const controller = new AbortController();
  const media = createCatalogMedia({ fetchImpl: (_url, init) => { requests++; requestSignal = init.signal; return new Promise(resolve => { finish = resolve; }); }, nativeImage: native(20, 10, undefined, () => decoded++) }); t.after(() => media.dispose());
  const budget = imageBudget(); const first = media.load(url, options(budget, controller.signal)), second = media.load(url, options(budget, controller.signal));
  await Promise.resolve(); assert.equal(requests, 1); controller.abort(); assert.equal(requestSignal.aborted, true);
  finish(new Response(png())); await assert.rejects(first, /closed/); await assert.rejects(second, /closed/); assert.equal(requests, 1); assert.equal(decoded, 0);
});
