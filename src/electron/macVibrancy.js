'use strict';

const os = require('node:os');

const LIQUID_GLASS_DARWIN_MAJOR = 25;

function macVibrancyMaterial(platform = process.platform, osRelease = os.release()) {
  if (platform !== 'darwin') return null;
  const darwinMajor = Number.parseInt(String(osRelease).split('.')[0], 10);
  return Number.isFinite(darwinMajor) && darwinMajor >= LIQUID_GLASS_DARWIN_MAJOR
    ? 'under-window'
    : 'hud';
}

module.exports = { LIQUID_GLASS_DARWIN_MAJOR, macVibrancyMaterial };
