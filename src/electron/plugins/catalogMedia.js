'use strict';
const { imageSize } = require('image-size');
const { download } = require('./catalogSources');
const { MAX_IMAGE_BYTES, repositoryImageUrl } = require('./catalogImagePolicy');
// One decode at a time across detail documents, with document-owned cancellation
// and cumulative budgets. Failed attempts keep their reservation; retries cannot
// reset a document's limits. Renderer receives only bounded raster data URLs.
function createCatalogMedia({ fetchImpl, nativeImage }) {
  const controllers = new Set();
  let disposed = false, queue = Promise.resolve();
  async function load(url, { baseUrl, signal, budget }) {
    if (disposed || signal.aborted) throw new Error('Image preview is closed');
    if (!nativeImage || repositoryImageUrl(url, baseUrl) !== url) throw new Error('Image must be in the README GitHub repository');
    const inputLimit = Math.min(MAX_IMAGE_BYTES, budget.download), outputLimit = Math.min(MAX_IMAGE_BYTES, budget.output);
    if (inputLimit <= 0 || outputLimit <= 0 || budget.pixels <= 0) throw new Error('README image budget exhausted');
    budget.download -= inputLimit; budget.output -= outputLimit;
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15000); timer.unref?.();
    try {
      const bytes = await download(fetchImpl, url, inputLimit, controller.signal, 'image/png, image/jpeg');
      if (controller.signal.aborted) throw new Error('Image preview is closed');
      budget.download += inputLimit - bytes.length;
      const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!png && !jpeg) throw new Error('Preview must be PNG or JPEG');
      const dimensions = imageSize(bytes);
      const { width, height } = dimensions, pixels = width * height;
      if (!['png', 'jpg'].includes(dimensions.type) || !Number.isSafeInteger(pixels) || width <= 0 || height <= 0 || width > 8192 || height > 8192 || pixels > budget.pixels) throw new Error('Preview dimensions exceed the README budget');
      budget.pixels -= pixels;
      let image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error('Invalid preview image');
      const size = image.getSize();
      // JPEG orientation may swap the axes, but must not expand the bitmap.
      if (size.width * size.height !== pixels || Math.max(size.width, size.height) !== Math.max(width, height)) throw new Error('Preview dimensions changed during decoding');
      if (size.width > 1600 || size.height > 1600) image = image.resize(size.width >= size.height ? { width: 1600 } : { height: 1600 });
      const output = image.toPNG();
      if (output.length > outputLimit) throw new Error('Preview output exceeds the README budget');
      budget.output += outputLimit - output.length;
      if (disposed || controller.signal.aborted) throw new Error('Image preview is closed');
      return `data:image/png;base64,${output.toString('base64')}`;
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort); controllers.delete(controller);
    }
  }
  return {
    load(url, options) {
      const pending = queue.then(() => load(url, options));
      queue = pending.catch(() => {}); return pending;
    },
    dispose() { disposed = true; for (const controller of controllers) controller.abort(); controllers.clear(); }
  };
}
module.exports = { createCatalogMedia };
