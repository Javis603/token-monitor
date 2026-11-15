import test from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { renderReference, referenceHref, references } from "./build-docs.mjs";

const root = new URL("../", import.meta.url);
test("reference rendering keeps code literal, escapes raw HTML and rejects executable links", () => {
  const html = renderReference('# API\n\n<script>alert(1)</script>\n\n[x](javascript:alert)\n\n```js\nconst a = "<b>&";\n```\n', references[0].source);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('const a = &quot;&lt;b&gt;&amp;&quot;;'));
  assert.ok(html.includes('class="code-head"'));
});

test("canonical document links stay local while implementation links keep repository context", () => {
  assert.equal(referenceHref('README.md#ui-lifecycle', references[1].source), 'plugin-reference.html#ui-lifecycle');
  assert.equal(referenceHref('author-ui-options.md#original-content-targets', references[0].source), 'plugin-ui-reference.html#original-content-targets');
  assert.equal(referenceHref('../../src/shared/plugins/manifest.js', references[0].source), 'https://github.com/Javis603/token-monitor/blob/main/src/shared/plugins/manifest.js');
  assert.equal(referenceHref('author-data-settings.md#plugin-settings', references[0].source), 'plugin-data-reference.html#plugin-settings');
  assert.equal(referenceHref('author-data-resources.md#live-token-rate', references[0].source), 'plugin-resources-reference.html#live-token-rate');
  assert.equal(referenceHref('publishing.md', references[0].source), 'plugin-publishing-reference.html');
  assert.equal(referenceHref('validation.md#author-self-check', references[0].source), 'plugin-testing-reference.html#author-self-check');
  assert.equal(referenceHref('//external.test', references[0].source), null);
  assert.equal(referenceHref('data:text/html,example', references[0].source), null);
  assert.equal(referenceHref('../../../escape', references[0].source), null);
});

test("built references contain current canonical content and source-context Markdown links", async () => {
  for (const reference of references) {
    const markdown = await readFile(new URL(reference.source, root), 'utf8');
    const html = await readFile(new URL(`_site/docs/${reference.page}.html`, root), 'utf8');
    assert.ok(html.includes(`href="https://raw.githubusercontent.com/Javis603/token-monitor/main/${reference.source}"`));
    assert.ok(!html.includes(`href="${reference.page}.md"`));
    assert.ok(html.includes(renderReference(markdown, reference.source).split('</h1>')[1]), reference.page);
    assert.equal((html.match(/<article /g) || []).length, 1);
    assert.ok(html.includes('data-docs-shared lang="en"'));
    assert.ok(!html.includes('src="../islands.js'));
    assert.ok(html.includes('href="../docs.css'));
  }
});

test("published Markdown bookmarks remain small canonical-source pointers", async () => {
  for (const reference of references) {
    const markdown = await readFile(new URL(`_site/docs/${reference.page}.md`, root), 'utf8');
    assert.ok(markdown.includes(`[canonical Markdown](https://raw.githubusercontent.com/Javis603/token-monitor/main/${reference.source})`));
    assert.ok(markdown.length < 512, reference.page);
    assert.equal([...markdown.matchAll(/\]\(([^)]+)\)/g)].length, 1);
  }
});

test("canonical reference edits trigger Pages and each reference has a navigation entry", async () => {
  const workflow = await readFile(new URL('.github/workflows/pages.yml', root), 'utf8');
  assert.match(workflow, /concurrency:\n  group: pages-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false/);
  for (const event of ['push', 'pull_request']) {
    const section = workflow.split(`  ${event}:`)[1].split(/\n  [a-z_]+:/)[0];
    assert.ok(section.includes("'docs/plugins/author-quickstart.md'"), `${event}: quickstart parity trigger missing`);
    for (const reference of references) assert.ok(section.includes(`'${reference.source}'`));
  }
  assert.ok(workflow.includes("if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'"));
  const output = new URL('_site/docs/', root);
  for (const reference of references) {
    assert.ok(workflow.includes(`'${reference.source}'`), `Pages does not watch ${reference.source}`);
    const html = await readFile(new URL(reference.page + '.html', output), 'utf8');
    assert.ok(html.includes(`<a href="${reference.page}.html" aria-current="page"`), reference.page);
  }
});

test("agent Markdown relative links resolve to repository files in their original source context", async () => {
  const { Marked } = await import('marked');
  const marked = new Marked();
  for (const reference of references) {
    const markdown = await readFile(new URL(reference.source, root), 'utf8');
    const links = [];
    marked.walkTokens(marked.lexer(markdown), token => { if (token.type === 'link') links.push(token.href); });
    const base = new URL(reference.source, 'https://raw.githubusercontent.com/Javis603/token-monitor/main/');
    for (const href of links) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) continue;
      const resolved = new URL(href, base);
      const relative = resolved.pathname.split('/main/')[1];
      assert.ok(relative, `${reference.page}: ${href}`);
      assert.ok((await stat(new URL(relative, root))).isFile(), `${reference.page}: ${href}`);
    }
  }
});

for (const scenario of [
  { name: 'success', query: async () => ({ availability: 'available', rows: [{totalTokens: 42}] }), expected: 'Today snapshot: 42 tokens' },
  { name: 'not collected', query: async () => ({ availability: 'notCollected', rows: [] }), expected: 'Today snapshot: notCollected' },
  { name: 'rejection', query: async () => { throw new Error('Plugin is disabled'); }, expected: 'Today snapshot: could not read data: Plugin is disabled' }
]) test(`standalone quickstart query labels ${scenario.name} without retaining data in the mount`, async () => {
  const markdown = await readFile(new URL('docs/plugins/author-quickstart.md', root), 'utf8');
  const blocks = [...markdown.matchAll(/```js\n([\s\S]*?)```/g)].map(match => match[1]);
  const describeToday = new Function(blocks[1] + '; return describeToday;')();
  const ctx = { data: { query: async query => {
    assert.deepEqual(query, { resource: 'usage', period: 'today' });
    return scenario.query();
  } } };
  assert.equal(await describeToday(ctx), scenario.expected);
  const module = await import('data:text/javascript,' + encodeURIComponent(blocks[0]));
  const nodes = [];
  const savedDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ remove() { this.removed = true; } }) };
  try {
    const mount = module.activate(ctx).mount({ append(...children) { nodes.push(...children); } }, {surface: 'page'});
    assert.equal(nodes.length, 1, 'first UI retains only its context label');
    mount.update({surface: 'page', width: 600, height: 400});
    assert.equal(nodes[0].textContent, 'My view: page');
    mount.update({surface: 'page', period: 'month', width: 800, height: 500});
    assert.equal(nodes[0].textContent, 'My view: month');
    assert.ok(!nodes[0].textContent.includes('42'), 'no previous query result remains under the new context');
    mount.dispose();
    assert.ok(nodes.every(node => node.removed));
  } finally { globalThis.document = savedDocument; }
});

test("reference cross-links and section anchors resolve in the built pages", async () => {
  const pages = new Map(await Promise.all(references.map(async reference => {
    const html = await readFile(new URL(`_site/docs/${reference.page}.html`, root), 'utf8');
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length, `duplicate id: ${reference.page}`);
    return [reference.page + '.html', { html, ids: new Set(ids) }];
  })));
  for (const [name, page] of pages) {
    for (const match of page.html.matchAll(/href="([^"]+)"/g)) {
      const url = new URL(match[1].replaceAll('&amp;', '&'), `https://docs.test/docs/${name}`);
      if (url.origin !== 'https://docs.test') continue;
      const target = url.pathname.split('/').pop();
      const hash = decodeURIComponent(url.hash.slice(1));
      if (pages.has(target) && hash) assert.ok(pages.get(target).ids.has(hash), `${name} -> ${target}#${hash}`);
    }
  }
});


test("all built guide and reference links resolve without leaving the static site", async () => {
  const output = new URL('_site/', root);
  const files = (await readdir(new URL('docs/', output))).filter(name => name.endsWith('.html'));
  const cache = new Map();
  for (const name of files) {
    const html = await readFile(new URL('docs/' + name, output), 'utf8');
    for (const match of html.matchAll(/<(?:a|link|script|img)\b[^>]*?\b(?:href|src)="([^"]+)"/g)) {
      const url = new URL(match[1].replaceAll('&amp;', '&'), `https://docs.test/docs/${name}`);
      if (url.origin !== 'https://docs.test') continue;
      let relative = decodeURIComponent(url.pathname).slice(1);
      if (!relative || relative.endsWith('/')) relative += 'index.html';
      const target = new URL(relative, output);
      assert.ok((await stat(target)).isFile(), `${name}: missing ${relative}`);
      if (url.hash && relative.endsWith('.html')) {
        if (!cache.has(relative)) cache.set(relative, await readFile(target, 'utf8'));
        const hash = decodeURIComponent(url.hash.slice(1));
        assert.ok(cache.get(relative).includes(`id="${hash}"`), `${name}: missing ${relative}#${hash}`);
      }
    }
  }
});

test("published docs use main sources and product guidance rather than development-stage notices", async () => {
  const output = new URL('_site/', root);
  for (const name of (await readdir(new URL('docs/', output))).filter(name => name.endsWith('.html'))) {
    const html = await readFile(new URL('docs/' + name, output), 'utf8');
    assert.ok(!/PR\s*#?1164|feat\/plugin-ecosystem|callout-preview|class="docs-pager"/.test(html), name);
  }
  const script = await readFile(new URL('docs.js', output), 'utf8');
  assert.ok(!/PR\s*#?1164|feat\/plugin-ecosystem/.test(script));
  const guide = await readFile(new URL('docs/plugin-quickstart.html', output), 'utf8');
  assert.ok(guide.includes('github.com/Javis603/token-monitor/blob/main/docs/plugins/author-quickstart.md'));
});

test("author guide is continuous and compatibility routes link into its chapters", async () => {
  const html = await readFile(new URL('_site/docs/plugin-quickstart.html', root), 'utf8');
  for (const anchor of ['manifest-basics', 'interface', 'data-settings', 'test-distribute', 'create-prompt']) {
    assert.ok(html.includes(`data-anchor="${anchor}"`), anchor);
  }
  for (const route of ['plugin-ui', 'plugin-data', 'plugin-share']) {
    const legacy = await readFile(new URL(`_site/docs/${route}.html`, root), 'utf8');
    assert.ok(legacy.includes('data-docs-legacy='), route);
    assert.ok(/href="plugin-quickstart.html#[^"]+"/.test(legacy), route);
  }
});


test("generic agent prompt is readable without scripts and consistent across entry points", async () => {
  const prompts = [];
  for (const page of ['index', 'plugin-quickstart']) {
    const html = await readFile(new URL(`_site/docs/${page}.html`, root), 'utf8');
    assert.ok(!/data-prompt-builder|prompt-need|prompt-surfaces|prompt-output/.test(html));
    const articles = [...html.matchAll(/<article\b[^>]*lang="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)];
    const byLanguage = new Map();
    for (const [, language, article] of articles) {
      const prompt = article.match(/<figure class="code prompt-card">[\s\S]*?<code>([\s\S]*?)<\/code>/)?.[1];
      assert.ok(prompt, `${page}: static prompt missing for ${language}`);
      assert.ok(prompt.includes('github.com/Javis603/token-monitor/blob/main/docs/plugins/author-quickstart.md'));
      assert.ok(prompt.includes('.tmplugin'), `${page}: incomplete contract`);
      byLanguage.set(language, prompt);
    }
    assert.deepEqual([...byLanguage.keys()].sort(), ['en', 'ja', 'ko', 'pt-BR', 'zh-CN', 'zh-TW']);
    prompts.push(byLanguage);
  }
  assert.deepEqual(prompts[0], prompts[1]);
});

test("topic navigation encodes fragment text and highlights the final Unicode section", async () => {
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('site/scripts/docs.js', root), 'utf8');
  const nodes = [];
  function element(tag) {
    const attrs = {};
    const node = {
      tagName: tag.toUpperCase(), children: [], hidden: false,
      classList: { toggle() {} },
      setAttribute(key, value) { attrs[key] = value; },
      getAttribute(key) { return key === 'href' ? this.href : attrs[key]; },
      removeAttribute(key) { delete attrs[key]; },
      appendChild(child) { this.children.push(child); },
      contains() { return false; }, addEventListener() {},
      querySelector(selector) { return this.children.find(child => '.' + child.className === selector); },
      querySelectorAll(selector) {
        const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
        return descendants.filter(child => selector === '*' || (selector === 'a' ? child.tagName === 'A' : '.' + child.className === selector));
      },
      getBoundingClientRect() { return { top: 500 }; }
    };
    nodes.push(node);
    return node;
  }
  const headings = ['start', '數字 / #?\"<end>'].map(anchor => {
    const heading = element('h2');
    heading.setAttribute('data-anchor', anchor);
    heading.textContent = anchor;
    return heading;
  });
  const parent = element('div');
  const document = {
    scrollingElement: { scrollHeight: 1000 }, activeElement: null,
    createElement: element,
    querySelector(selector) {
      return selector.includes('aria-current') ? { parentNode: parent } : nodes.find(node => node.className === 'docs-topic-links');
    }
  };
  const context = { document, docsMessages: () => ({ 'docs.toc': 'Contents' }), window: {
    scrollY: 500, innerHeight: 500, innerWidth: 390,
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame(fn) { fn(); }, setTimeout(fn) { fn(); }
  } };
  runInNewContext(source.slice(source.indexOf('function buildTopicNav('), source.indexOf('function setupCopyButtons(')), context);
  context.watchTopic(context.buildTopicNav({ querySelectorAll: () => headings }));
  const links = parent.querySelectorAll('a');
  assert.equal(links.length, 2);
  assert.equal(links[1].href, '#' + encodeURIComponent(headings[1].textContent));
  assert.equal(decodeURIComponent(new URL(links[1].href, 'https://docs.test/').hash.slice(1)), headings[1].textContent);
  assert.equal(links[1].getAttribute('aria-current'), 'location');
  assert.equal(links[0].getAttribute('aria-current'), undefined);
  assert.equal(links[1].textContent, headings[1].textContent);
});

test("legacy tutorial redirects reach real sections for every supported language", async () => {
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('site/scripts/docs.js', root), 'utf8');
  const fn = source.slice(source.indexOf('function redirectLegacyGuide('), source.indexOf('function scrollToHash('));
  const sections = {
    ui: ['choose', 'example', 'lifecycle', 'reference', 'render-choice', 'rich-failures'],
    data: ['permissions', 'data-decision', 'paging', 'relations', 'settings', 'plugin-settings', 'settings-conflicts'],
    share: ['catalog', 'catalog-trust', 'package', 'reference', 'release-check', 'test']
  };
  for (const lang of ['en', 'zh-TW', 'zh-CN', 'ko', 'ja', 'pt-BR']) {
    for (const [route, anchors] of Object.entries(sections)) {
      for (const anchor of ['', ...anchors, 'unknown-bookmark', '__proto__', '%invalid']) {
        for (const unified of [false, true]) {
          let target;
          const context = { URL, document: { body: { getAttribute: () => unified ? null : route } }, window: { location: {
            href: `https://docs.test/docs/plugin-${unified ? 'quickstart' : route}.html?lang=${lang}`,
            pathname: `/docs/plugin-${unified ? 'quickstart' : route}.html`,
            search: `?lang=${lang}`, hash: '#' + (unified ? route + '-' : '') + anchor, replace(value) { target = new URL(value); }
          } } };
          runInNewContext(fn, context);
          if (unified && anchor === '%invalid') {
            assert.equal(context.redirectLegacyGuide(), false);
            continue;
          }
          assert.equal(context.redirectLegacyGuide(), true);
          assert.equal(target.searchParams.get('lang'), lang);
          const html = await readFile(new URL('_site' + target.pathname, root), 'utf8');
          assert.ok(html.includes(`id="${target.hash.slice(1)}"`), target.href);
          if (!target.pathname.includes('reference')) {
            const article = html.match(new RegExp(`<article[^>]*lang="${lang}"[^>]*>([\\s\\S]*?)</article>`))[1];
            assert.ok(article.includes(`data-anchor="${target.hash.slice(1)}"`));
          }
        }
      }
    }
    for (const page of ['plugins', 'plugin-quickstart']) {
      const html = await readFile(new URL(`site/docs/${page}.html`, root), 'utf8');
      const article = html.match(new RegExp(`<article[^>]*lang="${lang}"[^>]*>([\\s\\S]*?)</article>`))[1];
      assert.ok(article.includes('plugin-distribution-reference.html#create-a-community-catalog'));
      if (page === 'plugin-quickstart') {
        for (const link of ['plugin-data-reference.html#live-updates-with-cleanup', 'plugin-data-reference.html#plugin-settings', 'plugin-resources-reference.html#live-token-rate', 'plugin-testing-reference.html#author-self-check', 'plugin-publishing-reference.html']) {
          assert.ok(article.includes(`href="${link}"`), `${lang}: ${link}`);
        }
      }
    }
  }
});

test("catalog tutorial scripts produce packages and signatures accepted by production", async t => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const { parseIndex, signingKey } = require('../src/electron/plugins/catalogSources');
  const { parsePackage } = require('../src/electron/plugins/package');
  const { createPluginCatalog } = require('../src/electron/plugins/catalog');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-doc-catalog-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const docs = await readFile(new URL('docs/plugins/distribution-design.md', root), 'utf8');
  const scripts = [...docs.matchAll(/```js\n([\s\S]*?)```/g)].map(m => m[1]);
  assert.equal(scripts.length, 3);
  const quickstart = await readFile(new URL('docs/plugins/author-quickstart.md', root), 'utf8');
  const manifest = JSON.parse(quickstart.match(/```json\n([\s\S]*?)```/)[1]);
  fs.mkdirSync(path.join(scratch, 'plugin'));
  fs.writeFileSync(path.join(scratch, 'plugin/manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(scratch, 'plugin/ui.mjs'), quickstart.match(/```js\n([\s\S]*?)```/)[1]);
  execFileSync(process.execPath, [fileURLToPath(new URL('scripts/build-plugin-package.js', root)), 'plugin', 'my-panel.tmplugin'], { cwd: scratch });
  fs.writeFileSync(path.join(scratch, 'catalog-template.json'), docs.match(/```json\n([\s\S]*?)```/)[1]);
  for (let i = 0; i < scripts.length; i++) fs.writeFileSync(path.join(scratch, `${i}.cjs`), scripts[i]);
  const run = (i, ...args) => execFileSync(process.execPath, [`${i}.cjs`, ...args], { cwd: scratch });
  run(0, 'my-panel.tmplugin', 'catalog-template.json', 'catalog.json');
  run(1, 'private.pem', 'public.pem');
  run(2, 'catalog.json', 'private.pem', 'catalog-signed.json');
  const bytes = fs.readFileSync(path.join(scratch, 'my-panel.tmplugin'));
  const plain = fs.readFileSync(path.join(scratch, 'catalog.json'));
  const signed = fs.readFileSync(path.join(scratch, 'catalog-signed.json'));
  const key = signingKey(fs.readFileSync(path.join(scratch, 'public.pem'), 'utf8')).pem;
  assert.deepEqual(parseIndex(signed, key), parseIndex(plain));
  assert.equal(parsePackage(bytes).manifest.id, manifest.id);
  assert.throws(() => parseIndex(signed), /format 1/);
  const tampered = JSON.parse(signed);
  tampered.payload = Buffer.from(plain.toString().replace('My plugins', 'Changed')).toString('base64');
  assert.throws(() => parseIndex(Buffer.from(JSON.stringify(tampered)), key), /signature is invalid/);
  for (const pinned of [false, true]) {
    let packageResponse = bytes;
    const catalog = createPluginCatalog({ root: path.join(scratch, String(pinned)), catalogDirectory: path.join(scratch, 'plugin'),
      manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {}, preview(pkg) { return pkg.manifest.id; } },
      fetchImpl: async url => new Response(url.endsWith('.tmplugin') ? packageResponse : pinned ? signed : plain)
    });
    t.after(() => catalog.dispose());
    const state = await catalog.addSource({ url: 'https://example.com/catalog.json', publicKey: pinned ? key : '' });
    const source = state.sources.find(s => s.kind === 'community');
    assert.equal(source.error, '');
    assert.equal(source.signed, pinned);
    assert.equal(await catalog.preview(source.id, manifest.id, manifest.version), manifest.id);
    packageResponse = Buffer.from('tampered');
    await assert.rejects(catalog.preview(source.id, manifest.id, manifest.version), /SHA-256/);
  }
});

test("six-language plugin guides use the first API and packageable manifest examples", async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { parsePackage } = require('../src/electron/plugins/package');
  for (const page of ['index', 'plugins', 'plugin-quickstart']) {
    const html = await readFile(new URL(`_site/docs/${page}.html`, root), 'utf8');
    assert.ok(!/API 2|API 1 is incompatible|Trusted Desktop|可信 Desktop|Token Monitor Desktop/.test(html), page);
    const articles = [...html.matchAll(/<article\b[^>]*lang="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)];
    assert.equal(articles.length, 6);
    if (page !== 'plugin-quickstart') continue;
    for (const [, language, article] of articles) {
      const encoded = article.match(/<code>({&quot;tmApi&quot;[\s\S]*?)<\/code>/)?.[1];
      assert.ok(encoded, language);
      const manifest = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
      const quickstart = await readFile(new URL('docs/plugins/author-quickstart.md', root), 'utf8');
      const canonicalUI = quickstart.match(/```js\n([\s\S]*?)```/)[1].trim();
      const encodedUI = article.match(/<code>(export function activate[\s\S]*?)<\/code>/)?.[1];
      assert.ok(encodedUI, `${language}: complete activate(ctx) example missing`);
      const decodedUI = encodedUI.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
      assert.equal(decodedUI.trim(), canonicalUI, `${language}: first UI differs from canonical quickstart`);
      assert.equal(manifest.tmApi, 1);
      const files = Object.fromEntries(manifest.files.map(name => [name, Buffer.from('// author fixture').toString('base64')]));
      const bytes = Buffer.from(JSON.stringify({ format: 2, manifest, files }));
      assert.equal(parsePackage(bytes).manifest.apiMajor, 1);
      assert.throws(() => parsePackage(Buffer.from(JSON.stringify({ format: 2, manifest: { ...manifest, tmApi: 2 }, files }))), /incompatible-plugin-api/);
    }
  }
});
