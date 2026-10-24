'use strict';

// The permission catalog. A plugin reads data only through Data Bus sources
// its granted permissions cover, and reaches the outside world only through
// host-owned capabilities. Risk is "read × egress": reading usage is harmless
// while nothing can leave the sandbox, so the egress grant is the one the
// consent prompt has to make loud.

const PERMISSIONS = Object.freeze({
  'ui.web': Object.freeze({ risk: 'action', sources: Object.freeze([]) }),
  'tm.pages': Object.freeze({ risk: 'read', sources: Object.freeze([]) }),
  'tm.data.usage': Object.freeze({ risk: 'read', sources: Object.freeze([]) }),
  'tm.data.devices': Object.freeze({ risk: 'read', sources: Object.freeze([]) }),
  'tm.data.sessions': Object.freeze({ risk: 'read', sources: Object.freeze([]) }),
  'tm.data.projects': Object.freeze({ risk: 'read', sources: Object.freeze([]) }),
  'tm.data.history': Object.freeze({ risk: 'read', sources: Object.freeze([]) }),
  'tm.data.limits': Object.freeze({ risk: 'read', sources: Object.freeze([]) }),
  'tm.data.subscriptions': Object.freeze({ risk: 'read', sources: Object.freeze([]) }),
  'tm.data.status': Object.freeze({ risk: 'read', sources: Object.freeze([]) }),
  'tm.data.identities': Object.freeze({ risk: 'read', sources: Object.freeze([]) }),
  'sys.details': Object.freeze({ risk: 'read', sources: Object.freeze(['sys.details', 'sys.cpu.details', 'sys.memory.details', 'sys.network', 'sys.disk', 'sys.battery', 'sys.gpu', 'sys.temperature']) }),
  'sys.cpu': Object.freeze({ risk: 'read', sources: Object.freeze(['sys.cpu']) }),
  'sys.memory': Object.freeze({ risk: 'read', sources: Object.freeze(['sys.memory']) }),
  // Totals and the live rate; never per-session titles or account identity.
  'tm.usage': Object.freeze({ risk: 'read', sources: Object.freeze(['tm.today', 'tm.month', 'tm.rate']) }),
  // Quota windows by provider, stripped of account email and keys.
  'tm.limits': Object.freeze({ risk: 'read', sources: Object.freeze(['tm.limits']) }),
  // Counts of running sessions per tool; titles never cross.
  'tm.sessions': Object.freeze({ risk: 'read', sources: Object.freeze(['tm.sessions']) }),
  notify: Object.freeze({ risk: 'action', sources: Object.freeze([]) }),
  // Requests to the hosts listed in the manifest's network.hosts, through the
  // host broker. There is no ambient fetch in the sandbox.
  network: Object.freeze({ risk: 'egress', sources: Object.freeze([]) })
});

const PERMISSION_IDS = Object.freeze(Object.keys(PERMISSIONS));
const READ_PERMISSIONS = Object.freeze(PERMISSION_IDS.filter((id) => PERMISSIONS[id].risk === 'read'));

// Host patterns: an exact hostname or one leading wildcard label. No ports,
// schemes, paths or IP literals: an allowlist entry names a service.
const HOST_RE = /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function normalizeHostPattern(value) {
  const host = String(value || '').trim().toLowerCase();
  return HOST_RE.test(host) ? host : '';
}

function hostAllowed(hostname, patterns) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  return (patterns || []).some((pattern) => (pattern.startsWith('*.')
    ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
    : host === pattern));
}

function sourcePermission(sourceId) {
  const id = String(sourceId || '');
  return PERMISSION_IDS.find((permission) => PERMISSIONS[permission].sources.includes(id)) || null;
}

// What a grant covers: sorted permissions plus egress hosts. Hosts are part of
// the grant because a new host is a new destination for whatever the plugin
// can read, which the user has not agreed to.
function grantFor(manifest) {
  return {
    permissions: [...(manifest?.permissions || [])].sort(),
    hosts: [...(manifest?.network?.hosts || [])].sort()
  };
}

function normalizeGrant(value) {
  const grant = value && typeof value === 'object' ? value : {};
  const permissions = Array.isArray(grant.permissions)
    ? [...new Set(grant.permissions.filter((id) => PERMISSION_IDS.includes(id)))].sort() : [];
  const hosts = Array.isArray(grant.hosts)
    ? [...new Set(grant.hosts.map(normalizeHostPattern).filter(Boolean))].sort().slice(0, 32) : [];
  return { permissions, hosts };
}

// What the manifest asks for beyond the stored grant. An update that widens
// access pauses the plugin until the user approves the difference.
function missingGrant(manifest, grant) {
  const wanted = grantFor(manifest);
  const held = normalizeGrant(grant);
  return {
    permissions: wanted.permissions.filter((id) => !held.permissions.includes(id)),
    hosts: wanted.hosts.filter((host) => !held.hosts.includes(host))
  };
}

function grantSatisfied(manifest, grant) {
  const missing = missingGrant(manifest, grant);
  return missing.permissions.length === 0 && missing.hosts.length === 0;
}

function hasPermission(grant, permission) {
  return normalizeGrant(grant).permissions.includes(permission);
}

function canReadSource(grant, sourceId) {
  const permission = sourcePermission(sourceId);
  return Boolean(permission) && hasPermission(grant, permission);
}

// Read access to app data combined with egress is what lets data leave the
// machine, so the consent prompt warns about the pair, not either alone.
function riskSummary(manifest) {
  const permissions = manifest?.permissions || [];
  const reads = permissions.filter((id) => PERMISSIONS[id]?.risk === 'read');
  const egress = permissions.includes('network') && (manifest?.network?.hosts || []).length > 0;
  const readsAppData = reads.some((id) => id.startsWith('tm.'));
  return {
    reads,
    egress,
    hosts: egress ? [...manifest.network.hosts] : [],
    exfiltrationWarning: egress && reads.length > 0,
    appDataWarning: egress && readsAppData,
    level: egress ? 'high' : permissions.includes('notify') ? 'medium' : 'low'
  };
}

module.exports = {
  PERMISSIONS,
  PERMISSION_IDS,
  READ_PERMISSIONS,
  canReadSource,
  grantFor,
  grantSatisfied,
  hasPermission,
  hostAllowed,
  missingGrant,
  normalizeGrant,
  normalizeHostPattern,
  riskSummary,
  sourcePermission
};
