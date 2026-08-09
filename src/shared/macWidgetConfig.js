'use strict';

const DEFAULT_WIDGET_URL_SCHEME = 'token-monitor';
const DEFAULT_MAC_DISTRIBUTION_CHANNEL = 'developer-id';

const APP_GROUP_SEGMENT = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const GROUP_PROFILE_APP_GROUP = new RegExp(`^group\\.${APP_GROUP_SEGMENT}(?:\\.${APP_GROUP_SEGMENT})*$`);
const TEAM_PREFIXED_APP_GROUP = new RegExp(`^([A-Z0-9]{10})\\.${APP_GROUP_SEGMENT}(?:\\.${APP_GROUP_SEGMENT})*$`);
const DEVELOPMENT_TEAM = /^[A-Z0-9]{10}$/;

function normalizeWidgetURLScheme(value, fallback = DEFAULT_WIDGET_URL_SCHEME) {
  const raw = String(value ?? '').trim();
  const resolved = raw || fallback;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(resolved)) {
    throw new Error('TOKEN_MONITOR_WIDGET_URL_SCHEME contains unsupported characters');
  }
  return resolved.toLowerCase();
}

function classifyAppGroup(value) {
  const appGroup = String(value || '').trim();
  if (GROUP_PROFILE_APP_GROUP.test(appGroup)) return 'group-profile';
  if (TEAM_PREFIXED_APP_GROUP.test(appGroup)) return 'team-prefixed';
  return 'invalid';
}

function validateAppGroupSyntax(value) {
  const appGroup = String(value || '').trim();
  const classification = classifyAppGroup(appGroup);
  if (classification === 'invalid') {
    throw new Error(
      `TOKEN_MONITOR_APP_GROUP has invalid format: ${appGroup || '(empty)'}; expected group.<name> or <10-character-DEVELOPMENT_TEAM>.<name>`
    );
  }
  return classification;
}

function isTeamPrefixedAppGroup(value) {
  return classifyAppGroup(value) === 'team-prefixed';
}

function validateAppGroup(value, options = {}) {
  const appGroup = String(value || '').trim();
  const classification = validateAppGroupSyntax(appGroup);

  const developmentTeam = String(options.developmentTeam || '').trim();
  if (developmentTeam && !DEVELOPMENT_TEAM.test(developmentTeam)) {
    throw new Error('DEVELOPMENT_TEAM must be exactly 10 uppercase letters or digits');
  }
  if (classification === 'team-prefixed' && (developmentTeam || options.requireMatchingTeamPrefix || options.requireDevelopmentTeam)) {
    if (!developmentTeam) {
      throw new Error('DEVELOPMENT_TEAM is required for a Team-prefixed TOKEN_MONITOR_APP_GROUP');
    }
    const prefix = appGroup.slice(0, 10);
    if (prefix !== developmentTeam) {
      throw new Error('TOKEN_MONITOR_APP_GROUP prefix does not match DEVELOPMENT_TEAM');
    }
  }
  if (options.requireDevelopmentTeam && !developmentTeam) {
    throw new Error('DEVELOPMENT_TEAM is required for this macOS Widget distribution');
  }
  return classification;
}

function validateAppGroupForDistribution(value, developmentTeam) {
  return validateAppGroup(value, {
    developmentTeam,
    requireDevelopmentTeam: true,
    requireMatchingTeamPrefix: true
  });
}

function normalizeMacDistributionChannel(value) {
  const channel = String(value || DEFAULT_MAC_DISTRIBUTION_CHANNEL).trim().toLowerCase();
  if (channel !== DEFAULT_MAC_DISTRIBUTION_CHANNEL) {
    throw new Error(
      `TOKEN_MONITOR_MAC_DISTRIBUTION_CHANNEL must be ${DEFAULT_MAC_DISTRIBUTION_CHANNEL} (received ${channel || 'empty'})`
    );
  }
  return channel;
}

module.exports = {
  DEFAULT_MAC_DISTRIBUTION_CHANNEL,
  DEFAULT_WIDGET_URL_SCHEME,
  classifyAppGroup,
  isTeamPrefixedAppGroup,
  normalizeMacDistributionChannel,
  validateAppGroup,
  validateAppGroupForDistribution,
  validateAppGroupSyntax,
  normalizeWidgetURLScheme
};
