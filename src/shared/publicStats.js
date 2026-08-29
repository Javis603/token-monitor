'use strict';

const { publicLimits } = require('./limits');
const { publicDevices, publicPeriods } = require('./usage');

// The one place the unauthenticated view surface is built. The LAN gateway
// serves this over plain HTTP with no secret, so anything reached from here is
// readable by every device on the subnet — and by anything else that can reach
// the port. Adding a field to getStats() must not silently widen it: this
// function rebuilds the response field by field instead of spreading the source
// and deleting what it knows about.
//
// That is the reason for the explicit allowlist below rather than
// `const { devices, ...rest } = stats`: the Worker's earlier shape spread first
// and deleted after, so a new top-level field became public by default and only
// a reader who remembered the surface would notice.
const PUBLIC_STATS_FIELDS = Object.freeze([
  'updatedAt',
  'staleAfterMs',
  'historyPreview',
  'historyRevision',
  'sessionDetailsOmitted',
  'periodProjectsOmitted',
  'projectsIncomplete'
]);

function publicStats(stats, options = {}) {
  const source = stats && typeof stats === 'object' ? stats : {};
  const devices = Array.isArray(source.devices) ? source.devices : [];
  const view = { ok: true, source: options.source || 'gateway' };

  for (const field of PUBLIC_STATS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) view[field] = source[field];
  }

  view.deviceCount = devices.length;
  view.periods = publicPeriods(source.periods);
  view.limits = publicLimits(source.limits);
  view.devices = publicDevices(devices);
  return view;
}

module.exports = { publicStats };
