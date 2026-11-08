'use strict';
const { MARK_IDS, VENDOR_IDS } = require('../vendorPresentation');
const { normalizeIdentityIcon } = require('./identityIcon');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function normalizePresentation(value) {
  if (value === undefined) return {};
  const fail = () => { throw Error('invalid plugin presentation icon/color'); };
  if (!object(value) || Object.keys(value).some(key => !['icon','color'].includes(key))) fail();
  const out = {};
  if (value.icon !== undefined) {
    const icon = value.icon;
    if (!object(icon)) fail();
    if (Object.hasOwn(icon, 'native')) {
      if (Object.keys(icon).length !== 1 || !MARK_IDS.includes(icon.native)) fail();
      out.icon = { native: icon.native };
    } else {
      if (Object.keys(icon).some(key => !['data','mode'].includes(key)) || !['image','mask'].includes(icon.mode ?? 'image')) fail();
      const data = normalizeIdentityIcon(icon.data);
      if (!data || (icon.mode === 'mask' && !data.startsWith('data:image/svg+xml;base64,'))) fail();
      out.icon = { data, mode: icon.mode ?? 'image' };
    }
  }
  if (value.color !== undefined) {
    const color = value.color;
    if (!object(color) || Object.keys(color).length !== 1) fail();
    if (Object.hasOwn(color, 'palette') && VENDOR_IDS.includes(color.palette)) out.color = { palette: color.palette };
    else if (typeof color.hex === 'string' && /^#[0-9a-f]{6}$/i.test(color.hex)) out.color = { hex: color.hex.toLowerCase() };
    else fail();
  }
  return out;
}
module.exports = { normalizePresentation };
