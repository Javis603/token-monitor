'use strict';

// GLM Team limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'zaiteam',
  fetch: 'fetchZaiTeamLimits',
  fields: [
    {
      key: 'zaiTeamApiKey',
      kind: 'credential',
      storePath: ['providers', 'zaiTeam', 'apiKey'],
      resolve: 'zaiTeamToken',
      resolveStyle: 'explicit'
    },
    {
      key: 'zaiTeamOrganizationId',
      kind: 'credential',
      storePath: ['providers', 'zaiTeam', 'organizationId'],
      normalize: 'trim',
      project: 'set'
    },
    {
      key: 'zaiTeamProjectId',
      kind: 'credential',
      storePath: ['providers', 'zaiTeam', 'projectId'],
      normalize: 'trim',
      project: 'set'
    }
  ],
  status: {
    credential: 'zaiTeamApiKey',
    configuredKey: 'zaiTeamApiKeyConfigured',
    sourceKey: 'zaiTeamApiKeySource',
    pendingKey: 'zaiteamPendingCheckSince'
  }
};
