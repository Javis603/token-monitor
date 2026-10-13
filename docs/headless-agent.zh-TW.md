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

`npm ci` 會安裝上游 tokscale 套件。第一次執行 `npm run agent` 或 `npm run agent:once`（包括 `--dry-run`）時，會把其中的執行檔換成本平台固定版本的 tokscale 並驗證 checksum；之後的執行會跳過下載。沒有固定版本的平台會保留 npm 安裝的執行檔。

## 設定

至少在 `token-monitor/.env` 中設定以下幾項：

```env
TOKEN_MONITOR_HUB_URL=https://token-monitor-hub.<your-subdomain>.workers.dev   # 或 http://<hub-ip>:17321
TOKEN_MONITOR_SECRET=你的共享密鑰
TOKEN_MONITOR_DEVICE_ID=build-server
```

- `TOKEN_MONITOR_DEVICE_ID` 預設是主機名稱，必須在所有裝置之間唯一：hub 會把相同 ID 當作同一台裝置，後傳送的紀錄會覆蓋另一台。
- `TOKEN_MONITOR_CLIENTS` 列出要採集的工具（以逗號分隔）。`.env.example` 已列出預設的工具，刪掉不需要的即可。Qoder CN 預設關閉，需要時加入 `qodercn`。
- 額度所需的服務商憑證、代理設定以及其他所有選項，見 [`.env.example`](../.env.example) 與 [configuration.md](configuration.md#headless-agent--hub-env)。優先順序為 CLI 參數 → 環境變數 → 內建預設值。

無論從哪個目錄啟動，agent 都會讀取 checkout 根目錄下的 `.env`。

### 標題同步狀態與遷移

工作階段標題同步預設關閉，需要分別在 Hub 和 agent 上開啟。agent 使用 `TOKEN_MONITOR_SYNC_SESSION_TITLES=1` 或 `--sync-session-titles`；每次啟動時，CLI/環境變數都會對目前目標重新聲明同意，與小工具的標題顯示偏好獨立。協定見[標題同步 API](API.md#put-apisynctitlesdeviceid)。

agent 將私有撤銷狀態保存在狀態目錄中的 `agent-sync-credentials.json`，其中包含清理舊目標所需的憑證（`TOKEN_MONITOR_SHARED_DIR` 可覆蓋預設目錄）。重新啟動或變更連線時應保留這個目錄；每個獨立部署的 agent 應使用各自的目錄。舊 Hub 離線或拒絕驗證時，清理會維持待處理，並在後續上傳時重試。同一 Hub URL/裝置仍有待處理項目時，不會重新啟用標題傳送，但基本用量仍會不帶標題上傳。`--dry-run` 不協商標題權限，也不存取該狀態檔。

刪除或遷移這個狀態前，先停止常駐 agent，再使用原來的 Hub URL、憑證、裝置 ID 和狀態目錄執行 `npm run agent:once -- --sync-session-titles=false`，等待清理完成。如果仍有清理待處理或狀態檔警告，就應保留狀態以便重試。也可以直接在舊 Hub 上刪除舊裝置。從尚未使用此狀態檔的舊版 agent 升級時，程式無法找回歷史目標，需要手動刪除那些舊裝置。撤銷只會移除伺服器目前儲存的標題，無法刪除已匯出的副本或備份。

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

常駐的 agent 會監看工具資料，幾秒內回報更新，並定期重新掃描作為備援。按 Ctrl-C 停止。

如需無人值守執行，請交給所在平台的服務管理器啟動，例如 systemd 使用者服務、launchd agent 或工作排程器。無論用哪一種：

- 以你自己的使用者身分、在 checkout 目錄中執行。agent 讀取的是執行帳號主目錄下的工具資料。
- 讓 Node 位於它的 `PATH` 中。服務管理器啟動時的 `PATH` 很精簡，請加入 `node` 所在的目錄（macOS 和 Linux 上可用 `dirname "$(command -v node)"` 查看）。nvm 等版本管理器的路徑裡帶有 Node 版本號，升級 Node 後要一併更新。
- 無論以何種方式結束都要重新啟動。agent 收到 SIGTERM 和 SIGHUP 時以狀態 0 結束，所以只在失敗時重啟的策略（例如 systemd 的 `Restart=on-failure`）會讓它停下；請使用 `Restart=always` 或服務管理器中的對應設定。

在 Windows 桌面上，通常直接用小工具更合適。

如果無法常駐程序，可以改為用 cron 等排程器定時執行 `npm run agent:once`。每次都會完整掃描，因此更新頻率取決於排程間隔。

## 更新

先停止 agent 或其服務：`npm ci` 會替換 `node_modules`，包括 agent 正在使用的 tokscale 執行檔。

```bash
cd ~/token-monitor
git pull
npm ci
```

然後重新啟動。如果固定的 tokscale 版本有變動，下次啟動時會自動取得。

## 解除安裝

如果這個 agent 曾經同步過標題，刪除狀態目錄前必須完成[標題同步清理](#標題同步狀態與遷移)。只刪除本機狀態檔，不會撤銷舊 Hub 上的標題。

停止並移除服務，刪除 checkout，再刪除 agent 的狀態目錄：Linux 為 `~/.config/Token Monitor/`，macOS 為 `~/Library/Application Support/Token Monitor/`，Windows 為 `%APPDATA%\Token Monitor\`（若設定了 `TOKEN_MONITOR_SHARED_DIR` 則為該目錄）。如果這台機器也裝了小工具，這同時也是小工具的資料目錄。tokscale 的設定與價格快取位於 `%APPDATA%\tokscale\`（Windows）或 `~/.config/tokscale/`（其他系統）；除非你也在使用 tokscale CLI，否則一併刪除。要把裝置從面板中移除，請在已連線小工具的裝置清單中刪除它。

## 疑難排解

- **裝置一直沒有出現**：檢查 `TOKEN_MONITOR_HUB_URL` 與 `TOKEN_MONITOR_SECRET`，以及本機能否連到 hub 連接埠（防火牆、區域網路或 VPN）。啟動時出現 `TOKEN_MONITOR_SECRET` 警告，表示 agent 正在不帶密鑰傳送。
- **`No such built-in module: node:sqlite`**：Node 版本低於需求。升級後重新開啟終端機，確認 `node --version` 顯示新版本。
- **請求經過代理**：把 hub 主機加入 `NO_PROXY` 與 `no_proxy`，或為 agent 取消代理環境變數。
- **兩台裝置互相覆蓋**：為每台機器設定不同的 `TOKEN_MONITOR_DEVICE_ID`。
- **總量翻倍**：有兩個採集器讀取了同一份工具資料，例如 Windows 小工具的 WSL 掃描與 WSL 內的 agent。請在其中一邊縮小 `TOKEN_MONITOR_CLIENTS`；hub 只會相加裝置總量，不會跨裝置去除重複的 session。
- **某個工具沒有用量**：執行 `npm run agent:once -- --dry-run`，看摘要中是否有該工具；如果沒有，確認它在 `TOKEN_MONITOR_CLIENTS` 中（或該變數未設定），並且其資料位於目前使用者的主目錄下。
