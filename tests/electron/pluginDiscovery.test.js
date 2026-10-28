'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGitHubDiscovery, normalizeRepositories } = require('../../src/electron/plugins/githubDiscovery');
const { parseIndex } = require('../../src/electron/plugins/catalogSources');
const { createPluginCatalog } = require('../../src/electron/plugins/catalog');
const raw = () => ({ total_count: 1, items: [{ full_name: 'author/project', name: 'Project', description: 'Description', stargazers_count: 42, official: true, html_url: 'https://evil.test/' }] });
function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-plugin-discovery-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
const response = data => new Response(JSON.stringify(data));
test('public topic discovery is disabled by default, including saved cache and forced requests', async t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'github-discovery.json'), JSON.stringify({ at: Date.now(), raw: raw() }));
  const catalog = createPluginCatalog({ root, manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {} }, fetchImpl: () => assert.fail('disabled discovery must not fetch') });
  t.after(() => catalog.dispose());
  for (const snapshot of [catalog.list(), await catalog.discover(), await catalog.discover(true)]) {
    assert.equal(snapshot.github.enabled, false);
    assert.deepEqual(snapshot.github.entries, []);
    assert.equal(snapshot.github.lastFetched, null);
  }
  await assert.rejects(catalog.details('github-discovery', 'author/project'), /Unknown/);
  await assert.rejects(catalog.preview('github-discovery', 'author/project', '1.0.0'), /missing/);
});
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
  const discovery = createGitHubDiscovery({ enabled: true, root, fetchImpl, now: () => time }); t.after(() => discovery.dispose());
  await Promise.all([discovery.refresh(), discovery.refresh()]); assert.equal(calls, 1);
  time += 1000; await discovery.refresh(); assert.equal(calls, 1);
  offline = true; await discovery.refresh(true); assert.equal(discovery.list().entries.length, 1); assert.match(discovery.list().error, /offline/);
  const restarted = createGitHubDiscovery({ enabled: true, root, fetchImpl, now: () => time }); t.after(() => restarted.dispose());
  assert.equal(restarted.list().entries[0].stars, 42); assert.equal(restarted.list().lastFetched, 1000);
});
test('README is fetched only for discovered repositories with its actual base location', async t => {
  const calls = []; const discovery = createGitHubDiscovery({ enabled: true, root: temp(t), fetchImpl: async url => {
    calls.push(url); return response(url.endsWith('/readme') ? { download_url: 'https://raw.githubusercontent.com/author/project/main/docs/README.md', html_url: 'https://github.com/author/project/blob/main/docs/README.md', encoding: 'base64', content: Buffer.from('# Title\n<script>bad()</script>').toString('base64') } : raw());
  } }); t.after(() => discovery.dispose());
  await discovery.refresh(); assert.equal(calls.length, 1);
  await assert.rejects(discovery.readme('other/repo'), /Unknown/); assert.equal(calls.length, 1);
  assert.equal((await discovery.readme('author/project')).readme, '# Title\n<script>bad()</script>'); assert.equal(calls.length, 2);
});
test('disposal aborts GitHub requests and a late response cannot populate cache', async t => {
  const root = temp(t); let finish;
  const discovery = createGitHubDiscovery({ enabled: true, root, fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
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
  const catalog = createPluginCatalog({ githubDiscoveryEnabled: true, root: temp(t), manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {} }, fetchImpl: async () => { calls++; return response(raw()); } });
  t.after(() => catalog.dispose());
  assert.equal(catalog.list().entries.length, 0); assert.equal(calls, 0);
  const next = await catalog.discover(); assert.equal(next.github.entries.length, 1); assert.equal(next.entries.length, 0);
  await assert.rejects(catalog.readmeImage('arbitrary-document', 0), /Unknown/);
  await assert.rejects(catalog.preview('github-discovery', 'author/project', '1.0.0'), /missing/);
  assert.equal(calls, 1);
});

const { renderReadme } = require('../../src/electron/plugins/catalogReadme');
test('README Markdown preserves layout, resolves relative images and cannot inject HTML or active URLs', () => {
  const result = renderReadme('# Heading\n\nBefore **bold**.\n\n![Preview](../images/demo.png)\n\nAfter.\n\n[Guide](./guide.md)\n\n<script>alert(1)</script>\n\n![bad](file:///secret)\n\n[bad](javascript:alert(1))', 'https://github.com/author/project/blob/main/docs/README.md', 'https://raw.githubusercontent.com/author/project/main/docs/README.md');
  assert.match(result.html, /<h1>Heading<\/h1>/); assert.match(result.html, /<strong>bold<\/strong>/);
  assert.deepEqual(result.images, ['https://raw.githubusercontent.com/author/project/main/images/demo.png']);
  assert.match(result.html, /data-readme-image="0"/); assert.doesNotMatch(result.html, /<img|<script|href="javascript:|src="file:/);
  assert.match(result.html, /&lt;script&gt;/); assert.match(result.html, /href="https:\/\/github.com\/author\/project\/blob\/main\/docs\/guide.md"/);
});
test('README image access is scoped to the active detail document, after another detail is opened', async t => {
  const catalog = createPluginCatalog({ githubDiscoveryEnabled: true, root: temp(t), manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {} }, fetchImpl: async url => response(url.endsWith('/readme') ? { download_url: 'https://raw.githubusercontent.com/author/project/main/README.md', html_url: 'https://github.com/author/project/blob/main/README.md', encoding: 'base64', content: Buffer.from('![Shot](image.png)').toString('base64') } : raw()) });
  t.after(() => catalog.dispose()); await catalog.discover();
  const first = await catalog.details('github-discovery', 'author/project');
  assert.equal(first.imageCount, 1); assert.match(first.html, /data-readme-image/);
  await catalog.details('github-discovery', 'author/project');
  await assert.rejects(catalog.readmeImage(first.documentId, 0), /Unknown/);
  await assert.rejects(catalog.details('custom', 'unknown'), /Unknown/);
});

test('README images stay lazy, duplicate IPC shares a load, and closing aborts the active document', async t => {
  const bytes = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.writeUInt32BE(13,8); bytes.write('IHDR',12); bytes.writeUInt32BE(20,16); bytes.writeUInt32BE(10,20); bytes[24]=8; bytes[25]=2;
  let images = 0, deferred = false, finish, imageSignal;
  const image = { isEmpty: () => false, getSize: () => ({ width: 20, height: 10 }), toPNG: () => Buffer.from('png') };
  const catalog = createPluginCatalog({ githubDiscoveryEnabled: true, root: temp(t), manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {} }, nativeImage: { createFromBuffer: () => image }, fetchImpl: async (url, init) => {
    if (url.includes('/search/')) return response(raw());
    if (url.endsWith('/readme')) return response({ download_url: 'https://raw.githubusercontent.com/author/project/main/README.md', html_url: 'https://github.com/author/project/blob/main/README.md', encoding: 'base64', content: Buffer.from('![Shot](image.png)').toString('base64') });
    images++; imageSignal = init.signal;
    return deferred ? new Promise(resolve => { finish = resolve; }) : new Response(bytes);
  } }); t.after(() => catalog.dispose()); await catalog.discover();
  const first = await catalog.details('github-discovery', 'author/project'); assert.equal(images, 0);
  const results = await Promise.all([catalog.readmeImage(first.documentId, 0), catalog.readmeImage(first.documentId, 0)]);
  assert.equal(images, 1); assert.equal(results[0], results[1]);
  const second = await catalog.details('github-discovery', 'author/project');
  await assert.rejects(catalog.readmeImage(first.documentId, 0), /Unknown/);
  deferred = true; const pending = catalog.readmeImage(second.documentId, 0);
  await new Promise(resolve => setImmediate(resolve)); catalog.closeDetails(); assert.equal(imageSignal.aborted, true);
  finish(new Response(bytes)); await assert.rejects(pending, /closed/);
  await assert.rejects(catalog.readmeImage(second.documentId, 0), /Unknown/); assert.equal(images, 2);
});
test('closing details also aborts a pending README and prevents a late result reopening it', async t => {
  let finish, signal;
  const catalog = createPluginCatalog({ githubDiscoveryEnabled: true, root: temp(t), manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {} }, fetchImpl: async (url, init) => {
    if (url.includes('/search/')) return response(raw());
    signal = init.signal; return new Promise(resolve => { finish = resolve; });
  } }); t.after(() => catalog.dispose()); await catalog.discover();
  const pending = catalog.details('github-discovery', 'author/project'); catalog.closeDetails(); assert.equal(signal.aborted, true);
  finish(response({ download_url: 'https://raw.githubusercontent.com/author/project/main/README.md', html_url: 'https://github.com/author/project/blob/main/README.md', encoding: 'base64', content: Buffer.from('README').toString('base64') }));
  await assert.rejects(pending, /no longer current/);
});

test('catalog README repository ownership allows GitHub canonical casing without relaxing its host', async t => {
  const discovery = createGitHubDiscovery({ enabled: true, root: temp(t), fetchImpl: async () => response({ download_url: 'https://raw.githubusercontent.com/author/project/main/README.md', html_url: 'https://github.com/author/project/blob/main/README.md', encoding: 'base64', content: Buffer.from('README').toString('base64') }) });
  t.after(() => discovery.dispose());
  const result = await discovery.repositoryReadme('https://github.com/AUTHOR/PROJECT');
  assert.equal(result.readme, 'README');
  assert.equal(result.baseUrl, 'https://github.com/author/project/blob/main/README.md');
  assert.equal(result.imageBaseUrl, 'https://raw.githubusercontent.com/author/project/main/README.md');
});

test('README page URLs must be browsable files owned by the selected repository', async t => {
  let htmlUrl;
  const discovery = createGitHubDiscovery({ root: temp(t), fetchImpl: async () => response({
    download_url: 'https://raw.githubusercontent.com/author/project/main/docs/README.md', html_url: htmlUrl,
    encoding: 'base64', content: Buffer.from('[Guide](./guide.md)\n\n![Shot](../images/demo.png)').toString('base64')
  }) }); t.after(() => discovery.dispose());
  for (const invalid of [undefined, 'https://evil.test/author/project/blob/main/docs/README.md',
    'https://github.com/other/project/blob/main/README.md', 'https://github.com/author/project/issues/1',
    'http://github.com/author/project/blob/main/README.md', 'https://github.com:8443/author/project/blob/main/README.md',
    'https://user@github.com/author/project/blob/main/README.md', 'https://github.com/author/project/blob/main/README.md?q=1']) {
    htmlUrl = invalid;
    await assert.rejects(discovery.repositoryReadme('https://github.com/author/project'), /Invalid/);
  }
  htmlUrl = 'https://github.com/AUTHOR/PROJECT/blob/main/docs/README.md';
  const result = await discovery.repositoryReadme('https://github.com/author/project');
  const rendered = renderReadme(result.readme, result.baseUrl, result.imageBaseUrl);
  assert.match(rendered.html, /href="https:\/\/github.com\/AUTHOR\/PROJECT\/blob\/main\/docs\/guide.md"/);
  assert.deepEqual(rendered.images, ['https://raw.githubusercontent.com/author/project/main/images/demo.png']);
});
