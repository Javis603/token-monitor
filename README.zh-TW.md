<p align="right">
   <a href="./README.md">EN</a> | <a href="./README.zh-CN.md">简</a> | <strong>繁</strong> | <a href="./README.ko.md">KO</a> | <a href="./README.ja.md">JA</a>
</p>
<div align="center">
    <img src=".github/assets/app.png" alt="Token Monitor logo" width="120">
    <h1>Token Monitor</h1>
</div>

<p align="center">
    <em>跨裝置聚合每個 AI 編程工具的即時用量。</em>
</p>

<p align="center">
    <a href="https://github.com/Javis603/token-monitor/releases"><img src="https://img.shields.io/github/v/release/Javis603/token-monitor?include_prereleases&style=flat-square&label=release&color=22c55e" alt="最新發布" /></a>
    <a href="https://github.com/Javis603/token-monitor/releases"><img src="https://img.shields.io/github/downloads/Javis603/token-monitor/total?style=flat-square&color=22c55e" alt="總下載量" /></a>
    <img src="https://img.shields.io/badge/Windows-10%2B-0078D4?style=flat-square" alt="Windows 10 或更新" />
    <img src="https://img.shields.io/badge/macOS-14%2B-0A84FF?style=flat-square&logo=apple&logoColor=white" alt="macOS 14 或更新" />
    <img src="https://img.shields.io/badge/Linux-x64-64748b?style=flat-square&logo=linux&logoColor=white" alt="Linux x64" />
    <a href="https://discord.gg/HmdNVVvw5P"><img src="https://img.shields.io/discord/1344259784219689031?color=5865F2&label=Discord&logo=discord&logoColor=white&style=flat-square" alt="Discord"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-A855F7?style=flat-square" alt="授權：MIT" /></a>
</p>

<div align="center">
    <img src=".github/assets/demo.gif">
</div>

## 什麼是 Token Monitor？

一款桌面小工具，即時顯示各種 AI 編程工具（包含 Claude Code、Codex、Hermes Agent、OpenCode、OpenClaw、Cursor、Antigravity、Cline、Kimi、Qwen、Grok Build、GitHub Copilot 等）的 Token 用量與 AI 工具額度，具備即時多裝置同步與歷史使用趨勢功能，並支援依工具、裝置、模型或 session 分項顯示。

## 支援的工具

Token Monitor 對「Token 用量」「帳戶額度」與「session 明細」分別支援：

| Logo | 工具 | 資料路徑 | Token 用量 | AI 工具額度 | session 明細 |
|:---:|------|-----------|:---:|:---:|:---:|
| <img src=".github/assets/tools-icon/claude.png" width="28" alt="Claude Code" /> | Claude Code | `~/.claude/projects/`、`~/.claude/transcripts/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/codex.png" width="28" alt="Codex" /> | Codex | `~/.codex/sessions/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/opencode.png" width="28" alt="OpenCode" /> | OpenCode | `~/.local/share/opencode/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/hermes-agent.png" width="28" alt="Hermes Agent" /> | Hermes Agent | `$HERMES_HOME/state.db` 或 `~/.hermes/state.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/openclaw.png" width="28" alt="OpenClaw" /> | OpenClaw | `~/.openclaw/agents/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/cursor.png" width="28" alt="Cursor" /> | Cursor | `~/.config/tokscale/cursor-cache/`（由 Cursor 同步保持更新） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/antigravity.png" width="28" alt="Antigravity" /> | Antigravity | `~/.config/tokscale/antigravity-cache/`（由 Antigravity 同步保持更新） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/cline.png" width="28" alt="Cline" /> | Cline | VS Code globalStorage tasks（`.../saoudrizwan.claude-dev/tasks/`） | ✅ | — | — |
| <img src=".github/assets/tools-icon/kimi.png" width="28" alt="Kimi" /> | Kimi CLI / Kimi Code | `~/.kimi/sessions/`、`~/.kimi-code/sessions/`（`KIMI_CODE_HOME`）；Kimi Code API 金鑰（透過 Kimi API 查詢 Kimi Code 額度） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/qwen.png" width="28" alt="Qwen" /> | Qwen CLI | `~/.qwen/projects/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/xai.png" width="28" alt="Grok Build" /> | Grok Build | `$GROK_HOME/sessions/` 或 `~/.grok/sessions/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/copilot.png" width="28" alt="GitHub Copilot" /> | GitHub Copilot | VS Code `workspaceStorage/*/chatSessions/`、`~/.copilot/otel/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/pi.png" width="28" alt="Pi" /> | Pi | `~/.pi/agent/sessions/`、`~/.omp/agent/sessions/`（Oh My Pi） | ✅ | — | — |
| <img src=".github/assets/tools-icon/zed.png" width="28" alt="Zed" /> | Zed | `~/.local/share/zed/threads/threads.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/kilocode.png" width="28" alt="Kilo Code" /> | Kilo Code | VS Code globalStorage tasks（`.../kilocode.kilo-code/tasks/`）—— 僅 Linux 與遠端/WSL | ✅ | — | — |
| <img src=".github/assets/tools-icon/mimo-code.png" width="28" alt="MiMo Code" /> | MiMo Code | `~/.local/share/mimocode/mimocode.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/zcode.png" width="28" alt="ZCode" /> | ZCode / GLM | `~/.zcode/projects/`；Z.ai API 金鑰（透過 Z.ai API 查詢 GLM 個人/團隊 Coding Plan 額度） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/kiro.png" width="28" alt="Kiro" /> | Kiro | `~/.kiro/sessions/cli/`、Kiro IDE globalStorage 與 `kiro-cli` 資料庫 | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/codebuddy.png" width="28" alt="CodeBuddy" /> | CodeBuddy | `~/.codebuddy/projects/` 與 IDE / VS Code 擴充套件日誌 | ✅ | — | — |
| <img src=".github/assets/tools-icon/workbuddy.png" width="28" alt="WorkBuddy" /> | WorkBuddy | `~/.workbuddy/projects/`、`~/.workbuddy/workbuddy.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/proma.png" width="28" alt="Proma" /> | Proma | `~/.proma/agent-sessions/*.jsonl` | ✅ | — | — |
| <img src=".github/assets/tools-icon/deepseek.png" width="28" alt="DeepSeek" /> | DeepSeek | DeepSeek API 金鑰（透過 DeepSeek API 查詢餘額） | — | ✅ | — |
| <img src=".github/assets/tools-icon/minimax.png" width="28" alt="Minimax" /> | Minimax | Minimax API 金鑰（透過 Minimax API 查詢 Token Plan 額度） | — | ✅ | — |
| <img src=".github/assets/tools-icon/volcengine.png" width="28" alt="Volcengine" /> | Volcengine | Ark API key 或火山引擎 AK/SK（透過火山引擎 API 查詢火山方舟 Coding Plan 額度） | — | ✅ | — |
| <img src=".github/assets/tools-icon/qoder.png" width="28" alt="Qoder" /> | Qoder | Qoder dashboard cookie（透過 Qoder usage API 查詢 big-model credits） | — | ✅ | — |
| <img src=".github/assets/tools-icon/ollama.png" width="28" alt="Ollama" /> | Ollama | Ollama Cloud cookie（透過 ollama.com/settings 查詢 session／每週用量） | — | ✅ | — |

## 為什麼要用 Token Monitor？

大多數用量監控工具只在它執行的那台機器上有用。Token Monitor 是為多裝置工作流而設計的：每台裝置監看自己的本機紀錄、把摘要更新送到你的 hub，每個連線中的小工具幾乎都能即時看到 Token 變化。

## 功能特色

- **即時 Token 追蹤**：涵蓋 Claude Code、Codex、Hermes Agent、OpenCode、OpenClaw、Cursor、Antigravity、Cline、Kimi、Qwen、Grok Build、GitHub Copilot、Pi、Zed、Kilo Code、MiMo Code、ZCode、Kiro、CodeBuddy、WorkBuddy、Proma（每輪對話後 UI 在數秒內更新）
- **WSL 用量（Windows）**：在執行中的 WSL 發行版裡使用的 AI 工具用量會自動偵測並併入總量（隨定期掃描刷新，約每 5 分鐘一次）
- **多裝置即時同步**：透過 Server-Sent Events 推送
- **分組統計檢視**：可依工具、裝置、模型、session 或帳戶額度分組
- **單一 session 明細**：點進 Claude Code、Codex 或 OpenCode 的 session，可看每則提問的 Token 消耗，並展開查看每次回覆的 Token 拆分與用到的工具（開啟時才即時讀取本機 transcript 或資料庫，絕不同步）
- **快取命中統計**：點擊任何工具或模型以展開查看輸入 Token（快取命中與未命中）、輸出 Token 的詳細分類及命中率百分比
- **成本分項**：Token 數量旁附帶成本統計
- **以你的幣別顯示成本**：可用 USD、TWD、HKD 或 CNY 顯示成本；匯率每日自動更新，也可在設定中手動覆寫
- **使用趨勢與儀表板**：主頁的活躍熱力圖與趨勢圖，加上獨立的儀表板視窗，提供連續天數，以及跨所有裝置、依工具／依模型堆疊的歷史（柱狀圖與 K 線兩種檢視）
- **資料匯出**：把使用資料匯出成與工具無關的 CSV + JSON，可手動或自動寫入資料夾，接試算表、Obsidian、Grafana 或自寫腳本；詳見 [docs/export.md](docs/export.md)
- **AI 工具額度偵測**：支援 Claude Code、Codex、Cursor、Antigravity、OpenCode、Grok、Minimax、MiMo、GitHub Copilot、Kiro、GLM、Volcengine、Qoder、Kimi 與 Ollama，涵蓋各供應商不同的 session、每週、帳單與 credits 視窗，以及 DeepSeek 預付餘額與今日/本月消費。已加入追蹤的 Codex 帳號可一鍵設為本機 Codex 使用帳號，不用重新登入授權。
- **可選的狀態檢視**：追蹤 Claude、OpenAI、Cursor 與 DeepSeek status 頁，支援手動或定時重新檢查
- **工具列表自訂**：可隱藏、置頂和拖曳排序主列表中的工具，不影響實際追蹤
- **外觀控制**：介面主題切換（含淺色模式）、各工具廠商色、玻璃透明度、模糊度、完全透明視窗
- **選單列（macOS）與系統匣（Windows）彈出視窗**：圖示旁可顯示成本、token 數，或 Claude／Codex／Cursor／Antigravity／OpenCode／Grok／Minimax／MiMo／GitHub Copilot／Kiro／GLM／Volcengine／Qoder／Kimi／Ollama 最接近用完的剩餘額度百分比
- **懸浮小窗模式**：可將小工具收成可拖曳的緊湊小窗，支援點擊或懸停預覽展開，並可顯示托盤同款內容
- **可錄製全域快捷鍵**：可從任何地方快速顯示或隱藏視窗
- **本地優先**：單裝置使用完全不需伺服器
- **自架同步後端**：小工具內 hub、Node CLI hub 或 Cloudflare Worker
- **iOS 小工具支援**：透過 Worker hub 搭配 Widgy、Scriptable
- **Discord Rich Presence**：將今日 Token、花費與主要工具廣播到你的 Discord 個人檔案（需手動開啟）
- **隱私優先**：只有摘要數字會離開你的機器

| 額度檢視 | 裝置檢視 | 模型檢視 |
|:---:|:---:|:---:|
| ![額度檢視](.github/assets/limits-view.png) | ![裝置檢視](.github/assets/devices-view.png) | ![模型檢視](.github/assets/models-view.png) |

| Session 檢視 | Session 明細 | 服務狀態 |
|:---:|:---:|:---:|
| ![Session 檢視](.github/assets/sessions-view.png) | ![Session 明細](.github/assets/session-details.png) | ![服務狀態](.github/assets/status-view.png) |

| 使用儀表板 — 總覽 | 使用儀表板 — 趨勢 |
|:---:|:---:|
| ![使用儀表板 總覽](.github/assets/dashboard-overview.png) | ![使用儀表板 趨勢](.github/assets/dashboard-trends.png) |

## 安裝

從 [GitHub Releases](https://github.com/Javis603/token-monitor/releases) 下載。

- **macOS（Apple Silicon）** — `.dmg`，已簽章並 notarize
- **Windows 10/11** — 安裝版 `.exe`；簽章還在準備中，可能會出現 SmartScreen
- **Linux x64** — `.AppImage`

打包版會自動檢查 GitHub Releases。有新版本時，介面會顯示更新提示；支援的平台也可在 設定 → 一般 中安裝更新。

### 首次啟動

本地模式是預設模式：啟動 App 後會開始追蹤這台裝置。不需要 hub、代理或設定。

## 多裝置同步

挑一個所有裝置（與任何無頭代理）都連得到的 hub 後端。在每台裝置上打開小工具，在 設定 → 多裝置同步 選一個模式。小工具會自動回報本機用量；只在沒有小工具的機器上跑 `npm run agent`。

#### 選項 A——直接在小工具內開 hub（最簡單，無需命令列）

在一台持續開機的機器上打開小工具，進入 設定 → 多裝置同步，選 **Host hub on this device**。小工具會產生隨機 secret，並列出其他裝置可連入的區網 URL（Tailscale 或 ZeroTier 位址也會顯示在這裡）。在其他每台裝置上選 **Connect to a hub**，把 URL 與 secret 貼進去即可。

只要 Token Monitor 還在跑，hub 就會運作——結束 App（僅關閉視窗不算）會停掉 hub，所有連入的裝置都會中斷。

#### 選項 B——自架 Node hub（持續開機的無頭機器）

```bash
# 在會持續開機的機器上
cp .env.example .env
# 把 TOKEN_MONITOR_SECRET 設成你私有的值，然後：
npm run hub
```

#### 選項 C——Cloudflare Worker hub（跨網路，包括 iPhone）

[![部署到 Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Javis603/token-monitor/tree/main/worker)

一鍵部署——Cloudflare 會在過程中請你輸入 `TOKEN_MONITOR_SECRET`。或手動部署：

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put TOKEN_MONITOR_SECRET
npx wrangler deploy
```

把部署 URL 貼到每台裝置的小工具 設定 → 多裝置同步。iOS 小工具設定步驟與端點參考請見 [worker/README.md](worker/README.md)，hub HTTP API 請見 [docs/API.md](docs/API.md)。

## App 資料

App 狀態存在 OS 使用者資料目錄——解除安裝時一併刪除該資料夾即可完整移除。

| 平台 | 路徑 |
|------|------|
| macOS | `~/Library/Application Support/Token Monitor/` |
| Windows | `%APPDATA%/Token Monitor/` |
| Linux | `~/.config/Token Monitor/` |

## 從原始碼建置

如需自己從原始碼打包安裝檔，請在**對應的**作業系統上使用 Node.js 22.13+（electron-builder 無法在 Windows 上交叉建置 macOS 的 `.dmg`，反之亦然）。

```bash
npm install
npm run dist:mac   # macOS arm64 .dmg → dist/
npm run dist:win   # Windows x64 安裝檔 .exe → dist/
npm run dist:linux # Linux x64 AppImage → dist/
npm run pack       # 未封裝的 app 目錄（無安裝檔），方便本機快速測試
```

產物會放在 `dist/`。Windows 和 Linux 請在對應系統上使用上面的 `dist:*` 腳本。如果要打包 macOS 發布版，需要本機有 Developer ID Application 簽章身份；本機開發或未列出的平台請用 `npm start` 啟動。

## 運作原理

```text
模式 A——本地（預設，免設定）
    小工具 (Electron) ──▶ tokscale ──▶ ~/.claude、~/.codex、$HERMES_HOME

模式 B——同步（選用，多裝置）
    裝置 A agent ──▶
    裝置 B agent ──▶  hub  ──▶  任一裝置上的小工具
    裝置 C agent ──▶
```

小工具會根據 設定 → 多裝置同步 決定走本地或同步模式。hub 本身可以是獨立的 `npm run hub` 程序、Cloudflare Worker，或直接跑在某一個小工具裡（Host 模式）。同步模式下，hub 透過 Server-Sent Events 把彙總後的統計推送給每個連線中的小工具，所以一台裝置上的更新會在數秒內出現在其他裝置上。

## 設定

### 小工具（GUI）

點擊小工具標題列上的 `⚙` 按鈕開啟設定面板。

- **多裝置同步**——三種模式：**Local only**（僅本機，無 hub）、**Connect to a hub**（貼入其他機器的 Hub URL + secret）、**Host hub on this device**（在本機開 hub 供其他裝置連入；面板會列出可用的區網 / Tailscale / ZeroTier 位址）。
- **追蹤的工具**——選擇要收集的 AI 工具，也可以獨立隱藏、置頂或拖曳排序主列表中的工具。
- **AI 工具額度**——選擇 Claude Code、Codex、Cursor、Antigravity、OpenCode、DeepSeek、Grok、Minimax、MiMo、GitHub Copilot、Kiro、GLM、Volcengine、Qoder、Kimi 與 Ollama 的額度偵測與更新頻率。
- **趨勢**——選擇每日使用歷史的掃描間隔，或直接關閉；開啟使用儀表板可看到活躍熱力圖、連續天數，以及依工具／依模型堆疊的柱狀圖與 K 線圖。
- **視窗行為**——選擇浮在其他 app 上方、一般視窗，或固定在桌面。
- **托盤模式**——切換為 macOS 選單列或 Windows 系統匣的彈出視窗，並選擇圖示旁顯示的內容：成本、今日 token 數、累計 token 數、成本＋token、最接近用完的 Claude／Codex／Cursor／Antigravity／OpenCode／Grok／Minimax／MiMo／GitHub Copilot／Kiro／GLM／Volcengine／Qoder／Kimi／Ollama 剩餘額度百分比，或只顯示圖示。
- **懸浮小窗**——將小工具收成可拖曳的小窗，可用點擊或懸停預覽展開，並可選擇顯示圖示、token、費用或 AI 工具額度條。
- **快捷鍵**——錄製全域快捷鍵，用來顯示或隱藏視窗。
- **外觀**——介面主題切換，可選預設（預設、黑曜、瓷白淺色模式）或自訂色彩（強調色、背景、文字、次要文字）、各工具廠商色、系統玻璃、即時點、工具圖示、Discord Rich Presence、玻璃透明度、玻璃模糊度。
- **進階**——開啟底層 `settings.json` 來調整較少用的選項，例如 `allTimeSince`。

小工具標題列上的釘選按鈕可切換「永遠置頂」。

### 無頭代理與 hub（`.env`）

代理與 hub 沒有 UI。請在專案根目錄用 `.env` 檔案設定（從 `.env.example` 複製）:

```env
TOKEN_MONITOR_HUB_URL=               # 同步模式必填——Worker URL 或 http://<lan-ip>:17321
TOKEN_MONITOR_SECRET=                # 共用 secret，必須與 hub 一致
TOKEN_MONITOR_DEVICE_ID=             # 選填——預設為主機名稱
TOKEN_MONITOR_CLIENTS=               # 選填——預設為所有支援的工具；設為空表示不追蹤
TOKEN_MONITOR_PROJECTS_ENABLED=      # 選填——預設關閉；設為 1 可收集專案中繼資料
TOKEN_MONITOR_HISTORY_ENABLED=       # 選填——預設啟用；設為 0 可跳過收集趨勢歷史
TOKEN_MONITOR_LIMITS_ENABLED=        # 選填——預設啟用；設為 0 可跳過 CLI 探測
TOKEN_MONITOR_LIMIT_PROVIDERS=       # 選填——預設為所有支援的供應商（claude、codex、cursor、antigravity、opencode、deepseek、minimax、mimo、grok、copilot、kiro、zai、zaiteam、volcengine、qoder、kimi、ollama）
```

小工具會把同樣的環境變數讀作首次啟動的預設值，之後改由 GUI 設定接手。

每個值也都可以用 CLI 旗標傳入（`--hub=`、`--secret=`、`--device=`、`--clients=`、`--history=`、`--limits=`、`--limitProviders=`）——旗標優先於環境變數。較少用的調整項（`TOKEN_MONITOR_INTERVAL_MS`、`TOKEN_MONITOR_PORT`、`TOKEN_MONITOR_STALE_AFTER_MS`、`TOKEN_MONITOR_HISTORY_INTERVAL_MS`、`TOKEN_MONITOR_LIMITS_REFRESH_MS`、…）一樣可透過環境變數／旗標設定，但為了減少雜訊，不放進 `.env.example`。

一次性執行範例：

```bash
npm run agent -- --clients=claude,codex,opencode --once
```

## 隱私

hub 與代理只傳輸摘要欄位：

- 裝置 id、主機名稱、平台
- 每個時段的 Token 總數（今日 / 本月 / 全部）
- 成本總額（若 `tokscale` 回傳成本資料）
- 依客戶端與模型的分項統計
- 啟用 AI 工具額度時，正規化後的 Claude Code／Codex／Cursor／Antigravity／OpenCode／Grok／Minimax／MiMo／GitHub Copilot／Kiro／GLM／Volcengine／Qoder／Kimi／Ollama 額度狀態

完全不會傳輸原始 AI 紀錄、提示詞、原始碼或對話內容。也不會傳輸 OAuth 憑證、存取權杖、刷新權杖、電子郵件或供應商原始回應。`.env`、`data/`、`node_modules/` 已加入 gitignore。

## 系統需求

- macOS、Windows 或 Linux x64
- Node.js 22.13+
- 僅同步模式：每個代理／小工具到 hub 的網路連通性

## Star 歷史

<a href="https://www.star-history.com/?repos=Javis603%2Ftoken-monitor&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Javis603/token-monitor&type=date&theme=dark&legend=top-left&sealed_token=VEcaPQSNlH8coYjuILJy7eT6t-pGJrGDEjOAjVwP8WGwNBOeNXoLTcz-KVBaZ2Y8eSqG1tLEpWGF3-5eMvVhW5G8n1ckdYI_uMZ6UCBE7b_eANd6we__7g7yc4ShXemuWfi-8SRcxgJNLK12VZGgBIccY1ceI3T3xm7jBM1TJjTVQFWJ0MmX2e-7QBp9" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Javis603/token-monitor&type=date&legend=top-left&sealed_token=VEcaPQSNlH8coYjuILJy7eT6t-pGJrGDEjOAjVwP8WGwNBOeNXoLTcz-KVBaZ2Y8eSqG1tLEpWGF3-5eMvVhW5G8n1ckdYI_uMZ6UCBE7b_eANd6we__7g7yc4ShXemuWfi-8SRcxgJNLK12VZGgBIccY1ceI3T3xm7jBM1TJjTVQFWJ0MmX2e-7QBp9" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Javis603/token-monitor&type=date&legend=top-left&sealed_token=VEcaPQSNlH8coYjuILJy7eT6t-pGJrGDEjOAjVwP8WGwNBOeNXoLTcz-KVBaZ2Y8eSqG1tLEpWGF3-5eMvVhW5G8n1ckdYI_uMZ6UCBE7b_eANd6we__7g7yc4ShXemuWfi-8SRcxgJNLK12VZGgBIccY1ceI3T3xm7jBM1TJjTVQFWJ0MmX2e-7QBp9" />
 </picture>
</a>

## 參與貢獻

歡迎提交 Issue 和 PR。專案規範、架構說明和指令參考都在 [AGENTS.md](AGENTS.md) 中——它是為編碼代理撰寫的，但同樣可以作為貢獻者指南。

## 致謝

- [tokscale](https://github.com/junhoyeo/tokscale) 提供紀錄解析與 Token 計算。
- [CodexBar](https://github.com/steipete/CodexBar) 提供 AI 工具額度的研究參考。

## 授權

[MIT](LICENSE) © [@Javis](https://github.com/Javis603)
