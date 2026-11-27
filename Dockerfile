# Hub-only image: runs `node src/hub/server.js`, which needs no tokscale binary.
FROM docker.io/library/node:22-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force

COPY src ./src

RUN mkdir -p /app/data && chown node:node /app/data
USER node

ENV TOKEN_MONITOR_PORT=17321 \
    TOKEN_MONITOR_HOST=0.0.0.0 \
    TOKEN_MONITOR_DATA_FILE=/app/data/devices.json

EXPOSE 17321
VOLUME /app/data

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.TOKEN_MONITOR_PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/hub/server.js"]
