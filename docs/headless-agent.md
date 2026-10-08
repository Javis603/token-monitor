<p align="right">
   <strong>EN</strong> | <a href="./headless-agent.zh-CN.md">简</a> | <a href="./headless-agent.zh-TW.md">繁</a>
</p>

# Headless agent

The headless agent is the widget's collector without the UI. It scans the AI tools on its own machine and posts the usage summary to a hub, so the machine shows up as one more device in every connected widget.

## When to use it

- Servers, SSH hosts, and other machines where you use AI tools but don't run the desktop widget.
- Inside WSL, for SQLite-backed tools the Windows widget cannot read reliably. Follow the [WSL SQLite setup](wsl-sqlite-setup.md), which adds WSL-specific steps on top of this guide.

A machine that already runs the widget does not need the agent: the widget contributes its own usage once multi-device sync is on. iCloud Drive sync is widget-only and does not accept agents.

## Requirements

- Node.js 22.15.0 or newer, plus npm and git.
- A running hub the agent can reach: the in-widget hub, a Node hub, or a Cloudflare Worker (see [Multi-device sync](../README.md#multi-device-sync)), with its URL and shared secret.

## Install

```bash
node --version   # must report v22.15.0 or newer
git clone https://github.com/Javis603/token-monitor.git
cd token-monitor
npm ci
cp .env.example .env
```

`npm ci` installs the upstream tokscale package. The first `npm run agent` or `npm run agent:once` (including `--dry-run`) replaces its binary with the pinned build for this platform and verifies the checksum; later runs skip the download. Platforms without a pinned build keep the npm binary.

## Configure

Set at least these keys in `token-monitor/.env`:

```env
TOKEN_MONITOR_HUB_URL=https://token-monitor-hub.<your-subdomain>.workers.dev   # or http://<hub-ip>:17321
TOKEN_MONITOR_SECRET=YOUR_SHARED_SECRET
TOKEN_MONITOR_DEVICE_ID=build-server
```

- `TOKEN_MONITOR_DEVICE_ID` defaults to the hostname. It must be unique across your devices: the hub treats a matching ID as the same device, so the latest post replaces the other one.
- `TOKEN_MONITOR_CLIENTS` lists the tools to collect (comma-separated). `.env.example` already lists the default set; remove the ones you don't want. Qoder CN is off by default; add `qodercn` to collect it.
- Provider credentials for account limits, proxy settings, and every other option are documented in [`.env.example`](../.env.example) and [configuration.md](configuration.md#headless-agent--hub-env). A CLI flag overrides the env var, which overrides the built-in default.

The agent reads `.env` from the checkout root, wherever it is started from.

## Verify

Print the summary the agent would send, without posting it to the hub:

```bash
npm run agent:once -- --dry-run
```

Then post one real snapshot and check that the device appears in a connected widget:

```bash
npm run agent:once
```

## Run continuously

```bash
npm run agent
```

The long-running agent watches tool data and posts updates within seconds, with a periodic rescan as a fallback. Stop it with Ctrl-C.

To keep it running unattended, start it from your platform's service manager, such as a systemd user service, a launchd agent, or Task Scheduler. Whichever you use:

- Run it as your own user, from the checkout directory. The agent reads tool data from the home directory of the account it runs as.
- Put Node on its `PATH`. Service managers start with a minimal `PATH`; add the directory that contains `node` (`dirname "$(command -v node)"` on macOS and Linux). Version managers such as nvm put the Node version in that path, so update it after upgrading Node.
- Restart it whenever it exits. The agent exits with status 0 on SIGTERM and SIGHUP, so a restart-on-failure policy such as systemd's `Restart=on-failure` leaves it stopped; use `Restart=always` or your manager's equivalent.

On a Windows desktop, the widget is usually the better choice.

Where a long-running process is not an option, run `npm run agent:once` from a scheduler such as cron instead. Each run does a full scan, so updates arrive only as often as the schedule fires.

## Update

Stop the agent or its service first: `npm ci` replaces `node_modules`, including the tokscale binary the agent runs.

```bash
cd ~/token-monitor
git pull
npm ci
```

Then start it again. The next start fetches the pinned tokscale build if it changed.

## Uninstall

Stop and remove the service, delete the checkout, and delete the agent's state directory: `~/.config/Token Monitor/` on Linux, `~/Library/Application Support/Token Monitor/` on macOS, `%APPDATA%\Token Monitor\` on Windows (or `TOKEN_MONITOR_SHARED_DIR` if you set it). On a machine that also has the widget installed, this is the widget's data directory too. tokscale keeps its settings and pricing cache in `%APPDATA%\tokscale\` on Windows and `~/.config/tokscale/` elsewhere; delete it too unless you also use the tokscale CLI. To remove the device from the dashboard, delete it from a connected widget's device list.

## Troubleshooting

- **The device never appears:** check `TOKEN_MONITOR_HUB_URL` and `TOKEN_MONITOR_SECRET`, and that the hub port is reachable from this machine (firewall, LAN, or VPN). A startup warning about `TOKEN_MONITOR_SECRET` means the agent is posting without a secret.
- **`No such built-in module: node:sqlite`:** Node is older than the required version. Upgrade it, then open a new terminal so `node --version` reports the new version.
- **Requests go through a proxy:** add the hub host to `NO_PROXY` and `no_proxy`, or unset the proxy variables for the agent.
- **Two devices replace each other:** give each machine its own `TOKEN_MONITOR_DEVICE_ID`.
- **Totals are doubled:** two collectors are reading the same tool data, for example the Windows widget's WSL scan and an agent inside WSL. Narrow `TOKEN_MONITOR_CLIENTS` on one of them; the hub adds device totals and does not deduplicate sessions across devices.
- **A tool reports no usage:** run `npm run agent:once -- --dry-run` and check whether the tool appears in the summary; if not, make sure it is listed in `TOKEN_MONITOR_CLIENTS` (or that the variable is unset) and that its data lives under this user's home directory.
