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
chmod 600 .env   # macOS/Linux: it will hold the hub secret
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
- `TOKEN_MONITOR_CLIENTS` limits which tools are collected (comma-separated). Leave it unset to collect every supported tool.
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

The long-running agent watches tool data and posts updates within seconds, with a periodic rescan as a fallback. Stop it with Ctrl-C. To keep it running unattended, start it from your service manager. The examples below assume the checkout is at `~/token-monitor`; change the paths if you cloned it elsewhere.

Service managers start with a minimal `PATH`, so the examples set it explicitly. Replace the Node directory with the output of `dirname "$(command -v node)"`, which matters when Node comes from nvm, fnm, or Homebrew. Version managers put the version in that path, so update it after upgrading Node.

### Linux (systemd user service)

Create `~/.config/systemd/user/token-monitor-agent.service`:

```ini
[Unit]
Description=Token Monitor headless agent

[Service]
WorkingDirectory=%h/token-monitor
Environment=PATH=/path/to/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env npm run agent
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now token-monitor-agent
loginctl enable-linger "$USER"   # keep it running while you are logged out
journalctl --user -u token-monitor-agent -f
```

In WSL, enable systemd in `/etc/wsl.conf` (`[boot]` → `systemd=true`), then run `wsl --shutdown` from Windows so it takes effect. Without systemd, start the agent from your shell profile instead. WSL does not start with Windows, so the agent runs only while the distro is running.

### macOS (launchd agent)

Create `~/Library/LaunchAgents/com.token-monitor.agent.plist`, replacing `YOU` with your user name:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.token-monitor.agent</string>
  <key>WorkingDirectory</key><string>/Users/YOU/token-monitor</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/env</string><string>npm</string><string>run</string><string>agent</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/path/to/node/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/Library/Logs/token-monitor-agent.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/token-monitor-agent.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.token-monitor.agent.plist
launchctl bootout "gui/$(id -u)/com.token-monitor.agent"   # to stop it
```

The `gui` domain exists only while you are signed in to the desktop, so the agent starts when you sign in and stops when you sign out. After a reboot it waits for the next desktop sign-in.

### Windows (Task Scheduler)

```powershell
schtasks /Create /TN "Token Monitor agent" /SC ONLOGON /TR "cmd /c cd /d %USERPROFILE%\token-monitor && npm run agent"
```

Keep `%USERPROFILE%` as written: `cmd` expands it when the task runs. The task opens a console window at sign-in, closing that window stops the agent, and nothing restarts it after a crash. On a Windows desktop, the widget is usually the better choice.

### Scheduled one-shot runs

Where a long-running process is not an option, run `npm run agent:once` on a schedule instead, for example from cron:

```cron
*/10 * * * * cd "$HOME/token-monitor" && PATH=/path/to/node/bin:/usr/bin:/bin npm run agent:once >> "$HOME/token-monitor-agent.log" 2>&1
```

Each run does a full scan, so updates arrive only as often as the schedule fires.

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
- **`systemctl --user` fails with `Failed to connect to bus`:** the shell has no user session, which happens after `su` or `sudo -u`. Run the commands from an SSH or desktop login as that user, or `export XDG_RUNTIME_DIR=/run/user/$(id -u)` first.
- **Requests go through a proxy:** add the hub host to `NO_PROXY` and `no_proxy`, or unset the proxy variables for the agent.
- **Two devices replace each other:** give each machine its own `TOKEN_MONITOR_DEVICE_ID`.
- **Totals are doubled:** two collectors are reading the same tool data, for example the Windows widget's WSL scan and an agent inside WSL. Narrow `TOKEN_MONITOR_CLIENTS` on one of them; the hub adds device totals and does not deduplicate sessions across devices.
- **A tool reports no usage:** run `npm run agent:once -- --dry-run` and check whether the tool appears in the summary; if not, make sure it is listed in `TOKEN_MONITOR_CLIENTS` (or that the variable is unset) and that its data lives under this user's home directory.
