'use strict';
const MarkdownIt = require('markdown-it');
const { MAX_IMAGES, repositoryImageUrl } = require('./catalogImagePolicy');
// All markup comes from Markdown tokens with raw HTML disabled. Images never
// receive a remote src in the renderer: only document-scoped indices cross IPC.
function renderReadme(text, baseUrl, imageBaseUrl) {
  const images = [];
  const md = new MarkdownIt({ html: false, linkify: true });
  const resolve = value => {
    try {
      const url = new URL(value, baseUrl || undefined);
      if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) return null;
      return url.href;
    } catch { return null; }
  };
  md.renderer.rules.image = (tokens, index) => {
    const token = tokens[index], url = repositoryImageUrl(token.attrGet('src'), imageBaseUrl);
    const alt = md.utils.escapeHtml(token.content || '');
    if (!url || images.length >= MAX_IMAGES) return alt;
    const image = images.length; images.push(url);
    return `<span data-readme-image="${image}" role="img" aria-label="${alt}">${alt}</span>`;
  };
  md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const url = resolve(tokens[index].attrGet('href'));
    // No href means inert text; never pass a custom scheme to shell.openExternal.
    tokens[index].attrs = url ? [['href', url], ['rel', 'noopener noreferrer']] : [];
    return self.renderToken(tokens, index, options);
  };
  return { html: md.render(text), images };
}
module.exports = { renderReadme };
