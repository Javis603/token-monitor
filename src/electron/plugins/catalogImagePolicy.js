'use strict';
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENT_PIXELS = 16 * 1000 * 1000;
function repositoryImageUrl(value, baseUrl) {
  try {
    const base = new URL(baseUrl), url = new URL(value, base);
    const valid = candidate => candidate.protocol === 'https:' && candidate.hostname === 'raw.githubusercontent.com' && !candidate.port && !candidate.username && !candidate.password && !candidate.search && !candidate.hash && candidate.href.length <= 2048 && !/%(?:2f|5c|00)/i.test(candidate.pathname);
    const repository = candidate => candidate.pathname.split('/').slice(1, 3).join('/').toLowerCase();
    if (!valid(base) || !valid(url) || !base.pathname.split('/')[2] || repository(base) !== repository(url)) return null;
    return url.href;
  } catch { return null; }
}
function imageBudget() {
  return { download: MAX_DOCUMENT_BYTES, output: MAX_DOCUMENT_BYTES, pixels: MAX_DOCUMENT_PIXELS };
}
module.exports = { MAX_IMAGES, MAX_IMAGE_BYTES, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_PIXELS, repositoryImageUrl, imageBudget };
