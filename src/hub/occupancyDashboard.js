'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const ASSETS = new Map([
  ['/occupancy', { file: 'occupancy.html', type: 'text/html; charset=utf-8' }],
  ['/occupancy/', { file: 'occupancy.html', type: 'text/html; charset=utf-8' }],
  ['/occupancy.css', { file: 'occupancy.css', type: 'text/css; charset=utf-8' }],
  ['/occupancy.js', { file: 'occupancy.js', type: 'text/javascript; charset=utf-8' }]
]);

function occupancyAsset(pathname) {
  const asset = ASSETS.get(String(pathname || ''));
  if (!asset) return null;
  return { ...asset, body: fs.readFileSync(path.join(PUBLIC_DIR, asset.file)) };
}

function serveOccupancyDashboard(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const asset = occupancyAsset(pathname);
  if (!asset) return false;
  res.writeHead(200, {
    'content-type': asset.type,
    'content-length': asset.body.length,
    'cache-control': 'no-cache',
    'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  });
  res.end(req.method === 'HEAD' ? undefined : asset.body);
  return true;
}

module.exports = { occupancyAsset, serveOccupancyDashboard };
