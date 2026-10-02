'use strict';

function tokscalePackageNameForPlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') {
    if (arch === 'arm64') return '@tokscale/cli-darwin-arm64';
    if (arch === 'x64') return '@tokscale/cli-darwin-x64';
  }
  if (platform === 'win32') {
    if (arch === 'arm64') return '@tokscale/cli-win32-arm64-msvc';
    if (arch === 'x64') return '@tokscale/cli-win32-x64-msvc';
  }
  return null;
}

function tokscalePlatformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

// Written beside the binary by scripts/ensure-vendored-tokscale.js when it
// swaps in the pinned fork build, so the app can tell that build apart from an
// upstream release that reports the same `--version`.
function tokscaleBuildMarkerPath(binPath) {
  return `${binPath}.build.json`;
}

module.exports = { tokscaleBuildMarkerPath, tokscalePackageNameForPlatform, tokscalePlatformKey };
