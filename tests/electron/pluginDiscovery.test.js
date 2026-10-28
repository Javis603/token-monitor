'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGitHubDiscovery, normalizeRepositories } = require('../../src/electron/plugins/githubDiscovery');
const { parseIndex } = require('../../src/electron/plugins/catalogSources');
const { createPluginCatalog } = require('../../src/electron/plugins/catalog');
const { createCatalogMedia } = require('../../src/electron/plugins/catalogMedia');
const raw = () => ({ total_count: 1, items: [{ full_name: 'author/project', name: 'Project', description: 'Description', stargazers_count: 42, official: true, html_url: 'https://evil.test/' }] });
function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-plugin-discovery-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
const response = data => new Response(JSON.stringify(data));
test('topic discovery derives provenance and repository URL instead of trusting publisher claims', () => {
  const input = raw(); input.items.push({ full_name: '../../secret' }, { full_name: 'author/project' }, { full_name: 'a/private', private: true });
  const entries = normalizeRepositories(input);
  assert.equal(entries.length, 1); assert.equal(entries[0].origin.kind, 'community');
  assert.equal(entries[0].repository, 'https://github.com/author/project');
  assert.equal(entries[0].stars, 42); assert.equal(entries[0].status, 'repository');
  assert.equal(entries[0].version, undefined); assert.equal(entries[0].versions, undefined);
});
test('GitHub refresh coalesces, keeps last good results offline, and survives restart', async t => {
  const root = temp(t); let time = 1000, calls = 0, offline = false;
  const fetchImpl = async (url, options) => { calls++; assert.match(url, /topic%3Atoken-monitor-plugin/); assert.equal(options.credentials, 'omit'); if (offline) throw Error('offline'); return response(raw()); };
  const discovery = createGitHubDiscovery({ root, fetchImpl, now: () => time }); t.after(() => discovery.dispose());
  await Promise.all([discovery.refresh(), discovery.refresh()]); assert.equal(calls, 1);
  time += 1000; await discovery.refresh(); assert.equal(calls, 1);
  offline = true; await discovery.refresh(true); assert.equal(discovery.list().entries.length, 1); assert.match(discovery.list().error, /offline/);
  const restarted = createGitHubDiscovery({ root, fetchImpl, now: () => time }); t.after(() => restarted.dispose());
  assert.equal(restarted.list().entries[0].stars, 42); assert.equal(restarted.list().lastFetched, 1000);
});
test('README is fetched only for discovered repositories with its actual base location', async t => {
  const calls = []; const discovery = createGitHubDiscovery({ root: temp(t), fetchImpl: async url => {
    calls.push(url); return response(url.endsWith('/readme') ? { download_url: 'https://raw.githubusercontent.com/author/project/main/docs/README.md', encoding: 'base64', content: Buffer.from('# Title\n<script>bad()</script>').toString('base64') } : raw());
  } }); t.after(() => discovery.dispose());
  await discovery.refresh(); assert.equal(calls.length, 1);
  await assert.rejects(discovery.readme('other/repo'), /Unknown/); assert.equal(calls.length, 1);
  assert.match((await discovery.readme('author/project')).readme, /<script>/); assert.equal(calls.length, 2);
});
test('disposal aborts GitHub requests and a late response cannot populate cache', async t => {
  const root = temp(t); let finish;
  const discovery = createGitHubDiscovery({ root, fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  const pending = discovery.refresh(); discovery.dispose(); finish(response(raw())); await pending;
  assert.equal(discovery.list().entries.length, 0); assert.equal(fs.existsSync(path.join(root, 'github-discovery.json')), false);
});
test('catalog presentation keeps repository and ignores retired gallery fields and publisher stars', () => {
  const entry = { id: 'test-plugin', name: 'Plugin', repository: 'https://github.com/author/project', screenshots: ['https://images.example/preview.png'], readme: 'Description', stars: 100000,
    versions: [{ version: '1.0.0', url: 'https://example.test/package', sha256: 'a'.repeat(64) }] };
  const parse = value => parseIndex(Buffer.from(JSON.stringify({ format: 1, title: 'Catalog', plugins: [value] })));
  assert.equal(parse(entry).plugins[0].screenshots, undefined); assert.equal(parse(entry).plugins[0].readme, undefined); assert.equal(parse(entry).plugins[0].stars, undefined);
  assert.throws(() => parse({ ...entry, repository: 'https://github.com/author/project/issues' }));
});
test('catalog lists saved repositories separately and README image IPC cannot fetch arbitrary URLs', async t => {
  let calls = 0;
  const catalog = createPluginCatalog({ root: temp(t), manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {} }, fetchImpl: async () => { calls++; return response(raw()); } });
  t.after(() => catalog.dispose());
  assert.equal(catalog.list().entries.length, 0); assert.equal(calls, 0);
  const next = await catalog.discover(); assert.equal(next.github.entries.length, 1); assert.equal(next.entries.length, 0);
  await assert.rejects(catalog.readmeImage('arbitrary-document', 0), /Unknown/);
  await assert.rejects(catalog.preview('github-discovery', 'author/project', '1.0.0'), /missing/);
  assert.equal(calls, 1);
});
test('image previews reject non-raster data and normalize decoded images to bounded PNG', async t => {
  let bytes = Buffer.from('<svg onload="bad()"/>'), decoded = 0;
  const media = createCatalogMedia({ fetchImpl: async () => new Response(bytes), nativeImage: { createFromBuffer() { decoded++; return { isEmpty: () => false, getSize: () => ({ width: 20, height: 10 }), toPNG: () => Buffer.from('png') }; } } });
  t.after(() => media.dispose());
  await assert.rejects(media.load('https://example.test/preview'), /PNG, JPEG or WebP/); assert.equal(decoded, 0);
  bytes = Buffer.from([137,80,78,71,13,10,26,10]);
  assert.equal(await media.load('https://example.test/preview'), 'data:image/png;base64,cG5n'); assert.equal(decoded, 1);
});

const { renderReadme } = require('../../src/electron/plugins/catalogReadme');
test('README Markdown preserves layout, resolves relative images and cannot inject HTML or active URLs', () => {
  const result = renderReadme('# Heading\n\nBefore **bold**.\n\n![Preview](../images/demo.png)\n\nAfter.\n\n[Guide](./guide.md)\n\n<script>alert(1)</script>\n\n![bad](file:///secret)\n\n[bad](javascript:alert(1))', 'https://raw.githubusercontent.com/author/project/main/docs/README.md');
  assert.match(result.html, /<h1>Heading<\/h1>/); assert.match(result.html, /<strong>bold<\/strong>/);
  assert.deepEqual(result.images, ['https://raw.githubusercontent.com/author/project/main/images/demo.png']);
  assert.match(result.html, /data-readme-image="0"/); assert.doesNotMatch(result.html, /<img|<script|href="javascript:|src="file:/);
  assert.match(result.html, /&lt;script&gt;/); assert.match(result.html, /href="https:\/\/raw.githubusercontent.com\/author\/project\/main\/docs\/guide.md"/);
});
test('README image access is scoped to the active detail document, after another detail is opened', async t => {
  const catalog = createPluginCatalog({ root: temp(t), manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {} }, fetchImpl: async url => response(url.endsWith('/readme') ? { download_url: 'https://raw.githubusercontent.com/author/project/main/README.md', encoding: 'base64', content: Buffer.from('![Shot](image.png)').toString('base64') } : raw()) });
  t.after(() => catalog.dispose()); await catalog.discover();
  const first = await catalog.details('github-discovery', 'author/project');
  assert.equal(first.imageCount, 1); assert.match(first.html, /data-readme-image/);
  await catalog.details('github-discovery', 'author/project');
  await assert.rejects(catalog.readmeImage(first.documentId, 0), /Unknown/);
  await assert.rejects(catalog.details('custom', 'unknown'), /Unknown/);
});
