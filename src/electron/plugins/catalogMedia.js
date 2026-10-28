'use strict';
const { download } = require('./catalogSources');
// Renderer receives a bounded raster data URL, never author HTML or a remote img URL.
function createCatalogMedia({ fetchImpl, nativeImage }) {
  const controllers = new Set();
  let disposed = false;
  return {
    async load(url) {
      if (disposed || !nativeImage) throw new Error('Image preview is unavailable');
      const controller = new AbortController(); controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 15000); timer.unref?.();
      try {
        const bytes = await download(fetchImpl, url, 4 * 1024 * 1024, controller.signal, 'image/png, image/jpeg, image/webp');
        const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
        if (!png && !jpeg && !webp) throw new Error('Preview must be PNG, JPEG or WebP');
        let image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) throw new Error('Invalid preview image');
        const { width, height } = image.getSize();
        if (width > 8192 || height > 8192 || width * height > 16000000) throw new Error('Preview dimensions are too large');
        if (width > 1600 || height > 1600) image = image.resize(width >= height ? { width: 1600 } : { height: 1600 });
        const output = image.toPNG();
        if (output.length > 4 * 1024 * 1024) throw new Error('Preview image is too large');
        if (disposed) throw new Error('Image preview is closed');
        return `data:image/png;base64,${output.toString('base64')}`;
      } finally { clearTimeout(timer); controllers.delete(controller); }
    },
    dispose() { disposed = true; for (const controller of controllers) controller.abort(); controllers.clear(); }
  };
}
module.exports = { createCatalogMedia };
