'use strict';

// A drawing-only SVG dialect, not a sanitizer for arbitrary SVG/XML. Reject
// unsupported syntax rather than repairing it. Consumers load only as an image.
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const number = new RegExp(`^${NUMBER}$`);
const numbers = new RegExp(`^${NUMBER}(?:[ ,]+${NUMBER})*$`);
const paint = /^(?:none|currentColor|transparent|black|white|#[0-9a-f]{3,8})$/i;
const common = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'fill-rule', 'clip-rule', 'opacity', 'fill-opacity', 'stroke-opacity', 'transform'];
const shapes = {
  svg: ['xmlns', 'viewBox', 'width', 'height'], g: [], path: ['d'], rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'], line: ['x1', 'x2', 'y1', 'y2'], polyline: ['points'], polygon: ['points']
};
function validateStaticSvg(source) {
  const fail = () => { throw Error('identityIcon SVG must be a bounded static drawing (no scripts, styles, links, entities or embedded content)'); };
  if (!source || source.length > 65536 || /[&\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source)) fail();
  const stack = [];
  let offset = 0, count = 0, root = false, closed = false;
  // Sticky scanning must consume every byte. Text, comments, declarations and
  // namespace-prefixed names are deliberately outside this small dialect.
  const tag = /\s*<(\/)?([a-zA-Z]+)((?:\s+[a-zA-Z][a-zA-Z0-9-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*)\s*(\/?)>/y;
  while (offset < source.length && source.slice(offset).trim()) {
    tag.lastIndex = offset;
    const match = tag.exec(source);
    if (!match || closed) fail();
    offset = tag.lastIndex;
    const [, end, name, raw, selfClosing] = match;
    if (!Object.hasOwn(shapes, name)) fail();
    if (end) {
      if (raw.trim() || selfClosing || stack.pop() !== name) fail();
      if (!stack.length) closed = true;
      continue;
    }
    if (++count > 256 || stack.length >= 16 || (name === 'svg' ? root : !stack.length)) fail();
    const attrs = new Map();
    for (const item of raw.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/g)) {
      const key = item[1], value = item[2] ?? item[3];
      if (attrs.has(key) || ![...common, ...shapes[name]].includes(key) || value.length > 32768) fail();
      attrs.set(key, value);
      if (key === 'xmlns') { if (value !== 'http://www.w3.org/2000/svg') fail(); }
      else if (key === 'viewBox') {
        const parts = value.trim().split(/[ ,]+/).map(Number);
        if (!numbers.test(value.trim()) || parts.length !== 4 || parts.some(n => !Number.isFinite(n) || Math.abs(n) > 1e6) || parts[2] <= 0 || parts[3] <= 0) fail();
      } else if (key === 'fill' || key === 'stroke') { if (!paint.test(value) || (value.startsWith('#') && ![4,5,7,9].includes(value.length))) fail(); }
      else if (key === 'd') { if (!/^[MmZzLlHhVvCcSsQqTtAa0-9eE+.,\s-]+$/.test(value)) fail(); }
      else if (key === 'points' || key === 'stroke-dasharray') { if (!(key === 'stroke-dasharray' && value === 'none') && !numbers.test(value.trim())) fail(); }
      else if (key === 'transform') {
        const transforms = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)\s*/gy;
        let end = 0, part;
        while ((part = transforms.exec(value))) {
          const n = part[2].trim(), size = n.split(/[ ,]+/).length;
          if (!numbers.test(n) || !({ matrix: [6], translate: [1,2], scale: [1,2], rotate: [1,3], skewX: [1], skewY: [1] }[part[1]].includes(size))) fail();
          end = transforms.lastIndex;
        }
        if (!end || end !== value.length) fail();
      } else if (key.endsWith('linecap')) { if (!['butt','round','square'].includes(value)) fail(); }
      else if (key.endsWith('linejoin')) { if (!['miter','round','bevel'].includes(value)) fail(); }
      else if (key.endsWith('rule')) { if (!['nonzero','evenodd'].includes(value)) fail(); }
      else {
        if (!number.test(value) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 1e6) fail();
        if (name === 'svg' && ['width','height'].includes(key) && (Number(value) <= 0 || Number(value) > 256)) fail();
      }
    }
    if (name === 'svg') {
      if (attrs.get('xmlns') !== 'http://www.w3.org/2000/svg' || !attrs.has('viewBox')) fail();
      root = true;
    }
    if (!selfClosing) stack.push(name);
    else if (name === 'svg') closed = true;
  }
  if (!root || stack.length || !closed) fail();
}
module.exports = { validateStaticSvg };
