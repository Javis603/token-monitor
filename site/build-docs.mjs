import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Marked, Renderer } from "marked";

// Canonical Markdown stays in docs/plugins; only this build imports Marked.
export const references = [
  { source: "docs/plugins/README.md", page: "plugin-reference", title: "Plugin API reference" },
  { source: "docs/plugins/author-ui-options.md", page: "plugin-ui-reference", title: "UI integration reference" },
  { source: "docs/plugins/distribution-design.md", page: "plugin-distribution-reference", title: "Package and catalog reference" },
  { source: "docs/plugins/author-data-settings.md", page: "plugin-data-reference", title: "Data and settings reference" },
  { source: "docs/plugins/publishing.md", page: "plugin-publishing-reference", title: "Publishing guide" },
  { source: "docs/plugins/validation.md", page: "plugin-testing-reference", title: "Author testing and platform acceptance" }
];
const repository = "https://github.com/Javis603/token-monitor/blob/main/";
const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function referenceHref(href, source) {
  if (href.startsWith("#")) return href;
  if (/^https?:\/\//i.test(href)) {
    const known = references.find(ref => href.startsWith(repository + ref.source));
    if (known && (href === repository + known.source || href.startsWith(repository + known.source + "#"))) {
      return known.page + ".html" + href.slice((repository + known.source).length);
    }
    return href;
  }
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) return null;
  const [file, fragment] = href.split("#", 2);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), file));
  if (resolved.startsWith("../") || resolved.startsWith("/")) return null;
  if (resolved === "docs/plugins/author-quickstart.md" && !fragment) return "plugin-quickstart.html";
  const known = references.find(ref => ref.source === resolved);
  return (known ? known.page + ".html" : repository + resolved) + (fragment ? "#" + fragment : "");
}

export function renderReference(markdown, source) {
  const headings = new Map();
  const renderer = new Renderer();
  renderer.html = ({ text }) => escape(text);
  renderer.heading = function ({ tokens, depth }) {
    const content = this.parser.parseInline(tokens);
    const label = tokens.map(token => token.text ?? token.raw ?? "").join("");
    const slug = label.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/ /g, "-") || "section";
    const count = headings.get(slug) || 0;
    headings.set(slug, count + 1);
    const id = slug + (count ? "-" + count : "");
    return `<h${depth} id="${escape(id)}" data-anchor="${escape(id)}">${content}</h${depth}>\n`;
  };
  renderer.link = function ({ href, title, tokens }) {
    const content = this.parser.parseInline(tokens);
    const target = referenceHref(href, source);
    return target ? `<a href="${escape(target)}"${title ? ` title="${escape(title)}"` : ""}>${content}</a>` : content;
  };
  renderer.image = ({ text }) => escape(text);
  renderer.code = ({ text, lang }) => `<figure class="code"><figcaption class="code-head"><span>${escape(lang || "Code")}</span></figcaption><pre><code>${escape(text)}</code></pre></figure>\n`;
  renderer.table = function (token) { return `<div class="table-wrap">${Renderer.prototype.table.call(this, token)}</div>\n`; };
  return new Marked({ renderer, gfm: true }).parse(markdown);
}

export function referencePage(template, reference, body) {
  const first = template.indexOf('<article class="doc-lang');
  const last = template.lastIndexOf("</article>") + "</article>".length;
  if (first < 0 || last < first) throw new Error("Documentation shell has no language articles");
  const notice = `<p data-i18n="docs.referenceLanguage">This reference is generated from the canonical English repository document. Navigation and guides follow your selected language.</p><p><a href="https://raw.githubusercontent.com/Javis603/token-monitor/main/${reference.source}" data-i18n="docs.referenceMarkdown">Read Markdown for agents</a> · <a href="${repository + reference.source}" data-i18n="docs.referenceSource">Repository source</a></p>`;
  const content = body.replace(/(<\/h1>)/, "$1" + notice);
  let html = template.slice(0, first) + `<article class="docs-article" data-docs-shared lang="en">${content}</article>` + template.slice(last);
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escape(reference.title)} · Token Monitor Docs</title>`)
    .replace(/(<meta (?:name="description"|property="og:description"|property="og:title") content=")[^"]*(">)/g, "$1" + escape(reference.title) + "$2")
    .replace(/<ol class="docs-crumbs">[\s\S]*?<\/ol>/, `<ol class="docs-crumbs"><li><a href="./" data-i18n="docs.crumb">Docs</a></li><li aria-current="page">${escape(reference.title)}</li></ol>`)
    .replace(/<nav class="docs-pager"[\s\S]*?<\/nav>/, "");
  // Active navigation belongs to the generated route, not the borrowed shell.
  html = html.replace(/(<a\b[^>]*?) aria-current="page"/g, "$1");
  html = html.replace(new RegExp(`(<a href="${reference.page.replaceAll("-", "\\-")}.html")`, "g"), '$1 aria-current="page"');
  return html;
}

export async function buildReferences({ siteRoot, outputRoot, rewrite }) {
  const template = await readFile(new URL("docs/plugin-quickstart.html", siteRoot), "utf8");
  for (const reference of references) {
    const markdown = await readFile(new URL("../" + reference.source, siteRoot), "utf8");
    const html = referencePage(template, reference, renderReference(markdown, reference.source));
    await writeFile(new URL(`docs/${reference.page}.html`, outputRoot), rewrite(html));
    // Keep published agent bookmarks without relocating source-relative links.
    const moved = `# ${reference.title}\n\nThis document has moved to the [canonical Markdown](https://raw.githubusercontent.com/Javis603/token-monitor/main/${reference.source}).\n`;
    await writeFile(new URL(`docs/${reference.page}.md`, outputRoot), moved);
  }
}
