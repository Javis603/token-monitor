'use strict';

const fs = require('node:fs');

// Windows lets an account create symbolic links only with Developer Mode or an
// elevated token. CI runners have that privilege, but a developer machine often
// does not, and the fixture setup then fails with EPERM before the code under
// test runs. Skip the rest of the case there, keeping the assertions it already
// made, the way claudeDesktopWatch.test.js does.
function symlinkOrSkip(t, target, linkPath, type) {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Windows symlink privilege unavailable');
      return false;
    }
    throw error;
  }
}

module.exports = { symlinkOrSkip };
