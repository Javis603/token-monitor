'use strict';

const path = require('node:path');
const js = require('@eslint/js');
const globals = require('globals');
const { includeIgnoreFile } = require('@eslint/compat');

module.exports = [
  // Respect .gitignore (node_modules, dist, build, tmp, _site, .agents, .claude, data, …)
  includeIgnoreFile(path.resolve(__dirname, '.gitignore')),
  // site/ is a standalone GitHub Pages property with its own browser conventions
  { ignores: ['site/**'] },

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
    // Renderer runs in the browser; UMD modules also touch module/window
    files: ['src/electron/renderer/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
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
