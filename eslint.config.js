'use strict';

const path = require('node:path');
const js = require('@eslint/js');
const globals = require('globals');
const { includeIgnoreFile } = require('@eslint/compat');

module.exports = [
  // Respect .gitignore (node_modules, dist, build, tmp, _site, .agents, .claude, data, …)
  includeIgnoreFile(path.resolve(__dirname, '.gitignore')),
  // site/ is a standalone GitHub Pages property with its own browser conventions
  // worker/src/shared/ is generated (vendored CommonJS); linted at its src/shared/ source
  { ignores: ['site/**', 'worker/src/shared/**'] },

  js.configs.recommended,

  {
    // Default: Node CommonJS — src/**, hub, agent, scripts, tests, this config.
    // window/self are readonly because shared modules (currency, trayText,
    // windowShortcut) feature-detect them in their UMD export wrapper.
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, window: 'readonly', self: 'readonly' },
    },
  },

  {
    files: ['tests/fixtures/trusted-plugin/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: globals.browser },
  },

  {
    // Renderer runs in the browser; UMD modules also touch module/window
    files: ['src/electron/renderer/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
  },

  {
    // The plugin host page and the Worker prelude run in the plugin sandbox.
    files: ['src/electron/plugins/host/runtime.js', 'src/electron/plugins/host/prelude.js', 'src/electron/plugins/host/message.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.worker },
    },
  },

  {
    // Plugin code runs inside a Worker with the host's `tm` API as its only global.
    files: ['src/electron/plugins/builtin/**/*.js', 'docs/plugins/examples/**/*.js', 'tests/fixtures/plugins/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.worker, tm: 'readonly' },
    },
  },

  {
    // Cloudflare Worker is ESM with service-worker runtime globals
    files: ['worker/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.serviceworker, ...globals.browser },
    },
  },

  {
    // Adjust recommended rules to the codebase's intentional idioms
    rules: {
      // CLI/terminal output parsing legitimately needs ANSI (\x1b) and NUL (\x00)
      'no-control-regex': 'off',
      // Best-effort defensive catches are deliberate
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `_` is the throwaway-placeholder convention here
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        // Rest-destructuring to omit keys (e.g. redacting account identity) is deliberate
        ignoreRestSiblings: true,
      }],
    },
  },
];
