import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { createGateway } from './app.js';
import { loadConfig } from './config.js';

if (existsSync('.env')) loadEnvFile('.env');

const config = loadConfig();
const gateway = createGateway({ config, distDir: resolve('dist') });

gateway.listen(config.port, config.host, () => {
  console.log(`Token Monitor Web listening on http://${config.host}:${config.port}`);
  console.log(`Read-only Web authentication mode: ${config.authMode}`);
  if (config.trustOidcProxy) {
    console.warn('Trusted-proxy mode: keep the listener restricted to configured proxy peers and enforce the documented upstream authentication contract.');
  }
});

function shutdown() {
  gateway.close((error) => process.exit(error ? 1 : 0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
