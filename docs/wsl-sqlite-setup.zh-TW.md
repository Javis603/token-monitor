<p align="right">
   <a href="./wsl-sqlite-setup.md">EN</a> | <a href="./wsl-sqlite-setup.zh-CN.md">简</a> | <strong>繁</strong>
</p>

# WSL SQLite 用量設定指南

## 什麼時候需要這樣設定

Windows 版 Token Monitor 預設會透過 `\\wsl$` 掃描所有正在執行的 WSL 發行版，並約每五分鐘合併一次用量。Codex JSONL session 這類檔案型資料通常可以直接讀取。

OpenCode、Hermes 和 ZCode 等工具的目前用量儲存在 SQLite 資料庫中。Windows 程序可以透過 `\\wsl$` 找到資料庫，但 SQLite 無法可靠地跨 WSL 9P 邊界協調檔案鎖和正在使用的 WAL。因此，Token Monitor 可能會在 **設定 → 採集 → WSL 偵測** 裡顯示已找到工具，卻沒有用量。

不要把複製正在使用的 `.db` 檔案當作解決方法。最新交易可能還在 `-wal` 中，而分別複製資料庫與 sidecar 檔案也無法保證得到一致的快照。

可靠的架構是：

```text
WSL headless agent → Windows host hub → Token Monitor widget
```

Agent 在資料庫旁邊執行 Linux 版 tokscale，再把正規化後的用量摘要傳送給 hub。

## 1. 在 Windows 啟動 Hub

開啟 Token Monitor 的 **設定 → 多裝置同步**，選擇 **在這台裝置架設 Hub**，並記下 Hub URL 與共享密鑰。

請只在可信任的網路中開放 hub，並保留自動產生的密鑰。如果 WSL 無法連到介面顯示的主機名稱，請改用 Windows 主機 IP，連接埠保持不變，預設是 `17321`。

## 2. 在 WSL 安裝 Headless Agent

Token Monitor 需要 Node.js 22.15.0 或更新版本。安裝前請先在 WSL 內檢查 Node.js 與 npm；如果 Node.js 版本過舊，請先完成升級。

```bash
node --version
npm --version
git clone https://github.com/Javis603/token-monitor.git
cd token-monitor
npm ci
```

建立 `token-monitor/.env`：

```env
TOKEN_MONITOR_HUB_URL=http://WINDOWS_HOST_IP:17321
TOKEN_MONITOR_SECRET=你的共享密鑰
TOKEN_MONITOR_DEVICE_ID=wsl-agent
TOKEN_MONITOR_CLIENTS=opencode,hermes,zcode
```

`TOKEN_MONITOR_DEVICE_ID` 必須與 Windows 小工具的裝置 ID 不同。Hub 會把相同 ID 當作同一台裝置，後傳送的紀錄會覆蓋前一筆。

## 3. 明確劃分採集範圍

Hub 會直接相加不同裝置的總量，不會跨裝置去除重複的 session。請選擇一種設定：

- 建議：保留 Windows 的 WSL 掃描，只讓 WSL agent 採集 Windows 無法可靠讀取的 SQLite 工具，例如 `TOKEN_MONITOR_CLIENTS=opencode,hermes,zcode`。
- 另一種方式：讓 WSL agent 採集全部 WSL 工具，然後在 Windows 小工具的 **設定 → 採集** 中關閉 **掃描 WSL 裡的工具**。

不要讓兩個採集器同時回報相同的 Codex、Claude Code 或其他檔案型 session。

## 4. 驗證並持續執行

先傳送一次快照：

```bash
npm run agent:once
```

確認 Token Monitor 中出現第二台裝置，而且 SQLite 工具有用量。然後啟動持續執行的 agent：

```bash
npm run agent
```

如需無人值守執行，請參考[持續執行](headless-agent.zh-TW.md#持續執行)中的 systemd 服務範例。

## 疑難排解

- **沒有出現第二台裝置**：檢查 Hub URL、共享密鑰，以及 Windows 防火牆是否允許連到 hub 連接埠。
- **請求被代理攔截**：把 Windows 主機 IP 加入 `NO_PROXY` 與 `no_proxy`，或為 agent 程序取消代理環境變數。
- **總量重複**：縮小 `TOKEN_MONITOR_CLIENTS` 的範圍；如果 agent 負責全部 WSL 工具，則關閉 Windows 小工具內建的 WSL 掃描。
- **WSL 偵測仍顯示沒有資料**：Windows 端的狀態只描述它自己的 `\\wsl$` 掃描。WSL agent 會作為另一台同步裝置出現，並作為這些 SQLite 工具的權威來源。
