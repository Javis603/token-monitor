'use strict';

const { app } = require('electron');
const { startWithXWayland } = require('./linuxDisplayServer');

// Select Ozone before loading main, taking the instance lock or creating windows.
startWithXWayland({ app, start: () => require('./main') });
