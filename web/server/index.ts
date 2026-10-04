import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { createGateway } from './app.js';
import { loadConfig } from './config.js';
import { closeGateway } from './shutdown.js';

if (existsSync('.env')) loadEnvFile('.env');

const config = loadConfig();
const gateway = createGateway({ config, distDir: resolve('dist') });

gateway.listen(config.port, config.host, () => {
  const displayHost = config.host.includes(':') ? `[${config.host}]` : config.host;
  console.log(`Token Monitor Web listening on http://${displayHost}:${config.port}`);
  console.log(`Read-only Web authentication mode: ${config.authMode}`);
  if (config.trustOidcProxy) {
    console.warn('Trusted-proxy mode: keep the listener restricted to configured proxy peers and enforce the documented upstream authentication contract.');
    if (!config.publicOrigin) {
      console.warn('Legacy proxy configuration: set WEB_PUBLIC_ORIGIN to the full external HTTPS origin (scheme, host and optional port, without a trailing slash). Without it, Origin validation compares only the host and cannot reject same-host cross-scheme requests.');
    }
  }
});

function shutdown() {
  void closeGateway(gateway).then(() => process.exit(0), () => process.exit(1));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
