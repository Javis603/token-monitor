# WSL SQLite usage setup

[简体中文](wsl-sqlite-setup.zh-CN.md)

## When this setup is needed

On Windows, Token Monitor normally scans supported tools inside every running WSL distribution through `\\wsl$` and merges their usage about every five minutes. File-based sources such as Codex JSONL sessions work well with this path.

OpenCode and Hermes store current usage in SQLite databases. A Windows process can discover those databases through `\\wsl$` while SQLite still cannot reliably coordinate locks or an active WAL across the WSL 9P boundary. Token Monitor may therefore show the tool under **Settings → Collection → WSL detection** with no usage.

Do not copy a live `.db` file as a workaround. Recent transactions may still be in `-wal`, and copying the database and sidecars separately does not guarantee a consistent snapshot.

The reliable setup is:

```text
WSL headless agent → Windows host hub → Token Monitor widget
```

The agent runs the Linux tokscale binary next to the database, then sends only the normalized usage summary to the hub.

## 1. Start the hub on Windows

In Token Monitor, open **Settings → Multi-device Sync** and select **Host hub on this device**. Record the hub URL and shared secret.

Keep the hub on a trusted network and retain the generated secret. If WSL cannot reach the displayed hostname, use the Windows host IP while keeping the same port, which defaults to `17321`.

## 2. Install the headless agent in WSL

Token Monitor requires Node.js 22.13.0 or newer. Verify Node.js and npm inside WSL before installing; upgrade Node.js first if the reported version is older.

```bash
node --version
npm --version
git clone https://github.com/Javis603/token-monitor.git
cd token-monitor
npm ci
```

Create `token-monitor/.env`:

```env
TOKEN_MONITOR_HUB_URL=http://WINDOWS_HOST_IP:17321
TOKEN_MONITOR_SECRET=YOUR_SHARED_SECRET
TOKEN_MONITOR_DEVICE_ID=wsl-agent
TOKEN_MONITOR_CLIENTS=opencode,hermes
```

`TOKEN_MONITOR_DEVICE_ID` must differ from the Windows widget device ID. The hub treats matching IDs as the same device, so a duplicate ID would make the latest post replace the previous record.

## 3. Choose one collection boundary

The hub adds device totals; it does not deduplicate the same session across devices. Choose one of these configurations:

- Recommended: keep Windows WSL scanning enabled and restrict the WSL agent to SQLite-backed tools that Windows cannot read reliably, for example `TOKEN_MONITOR_CLIENTS=opencode,hermes`.
- Alternative: let the WSL agent collect every WSL tool, then turn off **Settings → Collection → Scan tools inside WSL** in the Windows widget.

Do not let both collectors report the same Codex, Claude Code, or other file-based sessions.

## 4. Verify and keep it running

Send one snapshot first:

```bash
npm run agent:once
```

Confirm that a second device appears in Token Monitor and that OpenCode or Hermes has usage. Then run the continuous agent:

```bash
npm run agent
```

For unattended use, run that command from your normal WSL service manager or login startup. Keep its working directory set to the Token Monitor checkout so `.env` is loaded.

## Troubleshooting

- **No second device:** verify the hub URL, shared secret, and Windows firewall access to the hub port.
- **Request goes through a proxy:** add the Windows host IP to `NO_PROXY` and `no_proxy`, or unset the proxy variables for the agent process.
- **Totals are doubled:** narrow `TOKEN_MONITOR_CLIENTS`, or disable the Windows widget's built-in WSL scan when the agent owns all WSL tools.
- **WSL detection still says no data:** the Windows-side status describes its own `\\wsl$` scan. The WSL agent appears as a separate synced device and is the authoritative source for these SQLite-backed tools.
