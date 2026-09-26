import type { Server } from 'node:http';

export function closeGateway(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    // Stop accepting first, then close active SSE/HTTP responses. Their close
    // handlers abort upstream fetches and clear session-expiration timers.
    server.closeAllConnections();
  });
}
