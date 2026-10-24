import test from "node:test";
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
  assert.equal(referenceHref('README.md#code-api', references[1].source), 'plugin-reference.html#code-api');
  assert.equal(referenceHref('author-ui-options.md#fixed-bridge', references[0].source), 'plugin-rich-reference.html#fixed-bridge');
  assert.equal(referenceHref('../../src/shared/plugins/manifest.js', references[0].source), 'https://github.com/Javis603/token-monitor/blob/main/src/shared/plugins/manifest.js');
  assert.equal(referenceHref('//external.test', references[0].source), null);
  assert.equal(referenceHref('data:text/html,example', references[0].source), null);
  assert.equal(referenceHref('../../../escape', references[0].source), null);
});

test("built references contain current canonical content and byte-identical agent Markdown", async () => {
  for (const reference of references) {
    const markdown = await readFile(new URL(reference.source, root), 'utf8');
    const html = await readFile(new URL(`_site/docs/${reference.page}.html`, root), 'utf8');
    const raw = await readFile(new URL(`_site/docs/${reference.page}.md`, root), 'utf8');
    assert.equal(raw, markdown);
    assert.ok(html.includes(renderReference(markdown, reference.source).split('</h1>')[1]), reference.page);
    assert.equal((html.match(/<article /g) || []).length, 1);
    assert.ok(html.includes('data-docs-shared lang="en"'));
    assert.ok(!html.includes('src="../islands.js'));
    assert.ok(html.includes('href="../docs.css'));
  }
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
