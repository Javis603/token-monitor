'use strict';

// Manus limits account wiring. Leaf module: no requires.
// Manus has no settings-backed credential: its limits module reads the session
// the signed-in Manus desktop app keeps in its own cookie store, and it gets no
// settings panel.
module.exports = {
  id: 'manus',
  fetch: 'fetchManusLimits',
  fields: []
};
