<p align="right">
   <a href="./headless-agent.md">EN</a> | <a href="./headless-agent.zh-CN.md">简</a> | <strong>繁</strong>
</p>

# Headless Agent

Headless agent 就是拿掉介面的小工具採集器。它掃描本機上的 AI 工具，把用量摘要傳送到 hub，讓這台機器在所有已連線的小工具裡顯示為一台裝置。

## 什麼時候需要

- 伺服器、SSH 主機等會用 AI 工具、但不執行桌面小工具的機器。
- 在 WSL 內採集 Windows 小工具無法可靠讀取的 SQLite 工具。請依照 [WSL SQLite 用量設定指南](wsl-sqlite-setup.zh-TW.md)操作，它在本指南之上補充了 WSL 專屬步驟。

已經執行小工具的機器不需要 agent：開啟多裝置同步後，小工具會自動回報本機用量。iCloud Drive 同步僅供小工具使用，不接受 agent。

## 前置需求

- Node.js 22.15.0 或更新版本，以及 npm 和 git。
- 一個 agent 連得到的 hub：小工具內建 hub、Node hub 或 Cloudflare Worker（見[多裝置同步](../README.zh-TW.md#多裝置同步)），並準備好它的 URL 與共享密鑰。

## 安裝

```bash
node --version   # 必須是 v22.15.0 或更新
git clone https://github.com/Javis603/token-monitor.git
cd token-monitor
npm ci
cp .env.example .env
```

`npm ci` 會安裝上游 tokscale 套件。第一次執行 `npm run agent` 或 `npm run agent:once`（包括 `--dry-run`）時，會把其中的執行檔換成本平台固定版本的 tokscale 並驗證 checksum；之後的執行會跳過下載。

## 設定

至少在 `token-monitor/.env` 中設定以下幾項：

```env
TOKEN_MONITOR_HUB_URL=https://token-monitor-hub.<your-subdomain>.workers.dev   # 或 http://<hub-ip>:17321
TOKEN_MONITOR_SECRET=你的共享密鑰
TOKEN_MONITOR_DEVICE_ID=build-server
```

- `TOKEN_MONITOR_DEVICE_ID` 預設是主機名稱，必須在所有裝置之間唯一：hub 會把相同 ID 當作同一台裝置，後傳送的紀錄會覆蓋另一台。
- `TOKEN_MONITOR_CLIENTS` 限制要採集的工具（以逗號分隔）。不設定則採集所有支援的工具。
- 額度所需的服務商憑證、代理設定以及其他所有選項，見 [`.env.example`](../.env.example) 與 [configuration.md](configuration.md#headless-agent--hub-env)。優先順序為 CLI 參數 → 環境變數 → 內建預設值。

無論從哪個目錄啟動，agent 都會讀取 checkout 根目錄下的 `.env`。

## 驗證

印出 agent 將要傳送的摘要，但不傳送到 hub：

```bash
npm run agent:once -- --dry-run
```

接著傳送一次真實快照，確認已連線的小工具中出現這台裝置：

```bash
npm run agent:once
```

## 持續執行

```bash
npm run agent
```

常駐的 agent 會監看工具資料，幾秒內回報更新，並定期重新掃描作為備援。按 Ctrl-C 停止。如需無人值守執行，請交給服務管理器啟動。以下範例假設 checkout 位於 `~/token-monitor`；如果複製到別處，請相應修改路徑。

服務管理器啟動時的 `PATH` 很精簡，所以範例都明確設定了它。請把 Node 目錄換成 `dirname "$(command -v node)"` 的輸出；透過 nvm、fnm 或 Homebrew 安裝 Node 時尤其需要。版本管理器的路徑裡帶有版本號，升級 Node 後要一併更新。

### Linux（systemd 使用者服務）

建立 `~/.config/systemd/user/token-monitor-agent.service`：

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
loginctl enable-linger "$USER"   # 登出後仍保持執行
journalctl --user -u token-monitor-agent -f
```

在 WSL 中，需要先在 `/etc/wsl.conf` 啟用 systemd（`[boot]` → `systemd=true`）；否則請改為從 shell 設定檔啟動 agent。

### macOS（launchd agent）

建立 `~/Library/LaunchAgents/com.token-monitor.agent.plist`，把 `YOU` 換成你的使用者名稱：

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
launchctl bootout "gui/$(id -u)/com.token-monitor.agent"   # 停止
```

### Windows（工作排程器）

```powershell
schtasks /Create /TN "Token Monitor agent" /SC ONLOGON /TR "cmd /c cd /d %USERPROFILE%\token-monitor && npm run agent"
```

請保留 `%USERPROFILE%` 原樣：工作執行時由 `cmd` 展開。這個工作會在登入時開啟主控台視窗，關閉視窗即停止 agent，當機後也不會自動重新啟動。在 Windows 桌面上，通常直接用小工具更合適。

### 排程單次執行

如果無法常駐程序，可以改為排程執行 `npm run agent:once`，例如用 cron：

```cron
*/10 * * * * cd "$HOME/token-monitor" && PATH=/path/to/node/bin:/usr/bin:/bin npm run agent:once >> "$HOME/token-monitor-agent.log" 2>&1
```

每次都會完整掃描，因此更新頻率取決於排程間隔。

## 更新

```bash
cd ~/token-monitor
git pull
npm ci
```

然後重新啟動 agent 或其服務。如果固定的 tokscale 版本有變動，下次啟動時會自動取得。

## 解除安裝

停止並移除服務，刪除 checkout，再刪除 agent 的狀態目錄：Linux 為 `~/.config/Token Monitor/`，macOS 為 `~/Library/Application Support/Token Monitor/`，Windows 為 `%APPDATA%\Token Monitor\`（若設定了 `TOKEN_MONITOR_SHARED_DIR` 則為該目錄）。如果這台機器也裝了小工具，這同時也是小工具的資料目錄。tokscale 的設定與價格快取位於 `%APPDATA%\tokscale\`（Windows）或 `~/.config/tokscale/`（其他系統）；除非你也在使用 tokscale CLI，否則一併刪除。要把裝置從面板中移除，請在已連線小工具的裝置清單中刪除它。

## 疑難排解

- **裝置一直沒有出現**：檢查 `TOKEN_MONITOR_HUB_URL` 與 `TOKEN_MONITOR_SECRET`，以及本機能否連到 hub 連接埠（防火牆、區域網路或 VPN）。啟動時出現 `TOKEN_MONITOR_SECRET` 警告，表示 agent 正在不帶密鑰傳送。
- **`No such built-in module: node:sqlite`**：Node 版本低於需求。升級後重新開啟終端機，確認 `node --version` 顯示新版本。
- **`systemctl --user` 出現 `Failed to connect to bus`**：目前的 shell 沒有使用者工作階段，常見於 `su` 或 `sudo -u` 之後。請以該使用者透過 SSH 或桌面登入後再執行，或先執行 `export XDG_RUNTIME_DIR=/run/user/$(id -u)`。
- **請求經過代理**：把 hub 主機加入 `NO_PROXY` 與 `no_proxy`，或為 agent 取消代理環境變數。
- **兩台裝置互相覆蓋**：為每台機器設定不同的 `TOKEN_MONITOR_DEVICE_ID`。
- **總量翻倍**：有兩個採集器讀取了同一份工具資料，例如 Windows 小工具的 WSL 掃描與 WSL 內的 agent。請在其中一邊縮小 `TOKEN_MONITOR_CLIENTS`；hub 只會相加裝置總量，不會跨裝置去除重複的 session。
- **某個工具沒有用量**：執行 `npm run agent:once -- --dry-run`，看摘要中是否有該工具；如果沒有，確認它在 `TOKEN_MONITOR_CLIENTS` 中（或該變數未設定），並且其資料位於目前使用者的主目錄下。
