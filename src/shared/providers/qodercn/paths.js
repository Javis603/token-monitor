'use strict';

const path = require('node:path');
const { tokscaleHomeDir } = require('../../tokscaleConfig');

// Qoder CN usage is parsed by the tokscale fork (`--client qodercn`); these
// paths only feed watching, source health and the collector anchor
// fingerprint, so they must resolve the same files the fork reads, including
// its env overrides.
const QODER_CN_DB_SUFFIX = path.join('SharedClientCache', 'cache', 'db', 'local.db');
// Qoder CN builds from ~2026-09 dropped the SharedClientCache SQLite database
// and persist sessions as Claude-compatible JSONL transcripts under the
// home-relative `.qoder-cn/projects` tree (one directory per workspace, a
// `<sessionId>.jsonl` per session, plus `<sessionId>/subagents/agent-*.jsonl`
// for side-chain agents).
const QODER_CN_PROJECTS_SUFFIX = path.join('.qoder-cn', 'projects');

function qoderCnDataPaths(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  // The fork builds every default on tokscale's effective home, which on
  // Windows is an absolute native $HOME in preference to the profile.
  const home = tokscaleHomeDir({ env, platform, homeDir: options.homeDir });
  let appSupport;
  if (platform === 'darwin') appSupport = path.join(home, 'Library', 'Application Support');
  else if (platform === 'win32') appSupport = (typeof env.APPDATA === 'string' && env.APPDATA.length > 0) ? env.APPDATA : path.join(home, 'AppData', 'Roaming');
  else {
    const xdg = env.XDG_CONFIG_HOME;
    appSupport = (typeof xdg === 'string' && path.isAbsolute(xdg)) ? xdg : path.join(home, '.config');
  }

  const explicitDb = String(env.TOKEN_MONITOR_QODER_CN_DB_PATH || '').trim();
  const explicitProjects = String(env.TOKEN_MONITOR_QODER_CN_PROJECTS_PATH || '').trim();
  const qoderConfigDir = String(env.QODERCN_CONFIG_DIR || '').trim();
  return {
    dbPaths: explicitDb
      ? [path.resolve(explicitDb)]
      : [path.join(appSupport, 'QoderCN', QODER_CN_DB_SUFFIX)],
    // The transcript home is a dot-directory in the user's home on every
    // platform (like ~/.proma), not the platform Application Support root the
    // legacy database lived under.
    projectsDir: explicitProjects
      ? path.resolve(explicitProjects)
      : qoderConfigDir
        ? path.resolve(qoderConfigDir, 'projects')
        : path.join(home, QODER_CN_PROJECTS_SUFFIX)
  };
}

module.exports = { qoderCnDataPaths };
