'use strict';
// Compatibility for the old verification entry; cloud sessions no longer
// have a dedicated dashboard. Exercise the existing Sessions screen instead.
process.env.TM_SESSIONS_VERIFY_DIR ||= process.env.TM_CLOUD_VERIFY_DIR;
require('./verify-unified-sessions');
