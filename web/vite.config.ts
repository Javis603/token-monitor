import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [preact(), {
    name: 'shared-provider-catalog',
    resolveId(id) { if (id === 'virtual:provider-labels') return '\0provider-labels'; },
    load(id) { if (id === '\0provider-labels') return `export default ${JSON.stringify(require('../src/shared/limitProviders.js').LIMIT_PROVIDER_LABELS)}`; }
  }],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4174',
        changeOrigin: true
      }
    }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts']
  }
});
