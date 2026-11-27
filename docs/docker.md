# Run the Hub with Docker

The Hub image is published to `ghcr.io/javis603/token-hub`. It runs the Node Hub without the desktop widget or collector.

From a checkout, create a `.env` file with the shared secret your devices will use:

```dotenv
TOKEN_MONITOR_SECRET=replace-with-a-private-secret
```

The secret is required: without it the Hub only binds to loopback inside the container, so nothing outside can reach it.

Start the Hub:

```bash
docker compose pull
docker compose up -d
```

Compose maps host port `17321` to container port `17321` and stores Hub data in the `token-monitor-data` volume. Point each device at `http://<docker-host>:17321` with the same secret.

Compose uses `latest`. To pin a deployment, set the image to a published version such as `ghcr.io/javis603/token-hub:<version>`.

## Publishing

Pushing an app version tag (`v<version>`) runs `.github/workflows/release-hub.yml` alongside the desktop release. It publishes `ghcr.io/javis603/token-hub:<version>`, and also `latest` for non-prerelease versions.

GHCR creates the package as private on first publish. Make it public in the package settings so `docker compose pull` works without logging in.
