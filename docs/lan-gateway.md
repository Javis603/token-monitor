# LAN Gateway

The LAN gateway lets other devices on the same local network view this machine's
token usage without exposing it to the internet. It is built on the same hub
that drives multi-device sync, so a gateway is a superset of a hub: it points
the same data plane at the LAN and, optionally, exposes a **read-only view**.

## Ports

| Plane | Default port | Auth | What it serves |
|---|---|---|---|
| Data | `17321` | shared secret | `/api/ingest`, `/api/stats`, `/api/devices`, `/api/subscriptions`, SSE `/api/stats/stream` |
| View | `17322` | none | `GET /api/view/stats`, `GET /api/view/stats/stream` |

The view plane is deliberately a separate surface. It serves only `GET`/`HEAD`
under `/api/view/` and answers `404` to every write route, so there is nothing to
authenticate and nothing to mutate. The data plane still requires the shared
secret every time.

## Running it

### One-click (desktop app)

Open **Settings → Multi-device Sync → Host hub on this device**. The widget
starts the gateway automatically: it generates a shared secret, advertises the
data plane over mDNS (`_token-monitor._tcp.local.`), and lists the reachable LAN
addresses on screen. No separate process needed.

The **Read-only view** toggle is off by default. Turning it on shows a one-time
warning: the view plane serves plain, unauthenticated HTTP to the whole subnet,
so use it only on a network you trust.

### Standalone process

```bash
# Data + view planes, with mDNS
TOKEN_MONITOR_SECRET=<random> npm run gateway

# Data plane only (no unauthenticated view)
TOKEN_MONITOR_SECRET=<random> npm run gateway -- --view 0
```

## How devices reach the gateway

- **PC (client mode):** **Settings → Multi-device Sync → Scan for gateways**,
  pick a result, and the app fills in the address for you. Or type
  `http://<lan-ip>:17321` and the shared secret into **Connect to a hub**.
- **Android app:** on the same Wi-Fi the app discovers the gateway by mDNS. If
  the gateway is not advertising a view port (the desktop toggle is off), the
  app finds the gateway but has nothing to read — enable **Read-only view** on
  the desktop.

## Troubleshooting

Two failures look identical on a phone (an empty list) but have different
causes. `npm run gateway:doctor` asks the gateway directly and tells them apart:

```bash
node scripts/lan-doctor.js http://<lan-ip>:17322 --data-secret=<secret>
```

### Windows firewall

Windows blocks inbound connections to a fresh app by default. The data plane
binds `0.0.0.0:17321` and the view plane `0.0.0.0:17322`; allow those from
**Private** networks the first time Windows prompts. This step needs an
administrator and cannot be automated by the app.

### mDNS does not reach every device

Port `5353` is shared with every other mDNS responder on the host. If mDNS
cannot bind or does not receive on some interface, the app reports it as a
warning and the gateway keeps serving by address — connect using the LAN URL
directly.

## Security notes

- The mDNS advertisement carries **no secret**: it is multicast to the whole
  subnet. A phone still reaches the data plane only after you share the secret;
  the app reaches the view plane only because it is intentionally unauthenticated.
- Keep the read-only view off unless you actually want unattended monitoring.
- The gateway (like the hub) stores device records in `data/devices.json` (or
  the widget's `userData` when hosted from the app).

## Acceptance checklist

- [ ] Desktop host mode starts a gateway and lists one reachable LAN address per
      interface.
- [ ] A second PC in client mode discovers the gateway via **Scan for gateways**
      and connects with no manual IP entry.
- [ ] The read-only view is off by default; enabling it shows one risk warning.
- [ ] `npm run gateway:doctor` distinguishes "cannot reach" from "reachable but
      no device posted".
- [ ] Android app on the same Wi-Fi discovers the gateway and shows usage when
      the view is enabled.
