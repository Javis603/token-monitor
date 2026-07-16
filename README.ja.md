<p align="right">
   <a href="./README.md">EN</a> | <a href="./README.zh-CN.md">简</a> | <a href="./README.zh-TW.md">繁</a> | <a href="./README.ko.md">KO</a> | <strong>JA</strong>
</p>
<div align="center">
    <img src=".github/assets/app.png" alt="Token Monitor logo" width="120">
    <h1>Token Monitor</h1>
</div>

<p align="center">
    <em>すべての AI コーディングツールのリアルタイム使用量を一画面で、複数デバイス間で同期。</em>
</p>

<p align="center">
    <a href="https://github.com/Javis603/token-monitor/releases"><img src="https://img.shields.io/github/v/release/Javis603/token-monitor?include_prereleases&style=flat-square&label=release&color=22c55e" alt="最新リリース" /></a>
    <a href="https://github.com/Javis603/token-monitor/releases"><img src="https://img.shields.io/github/downloads/Javis603/token-monitor/total?style=flat-square&color=22c55e" alt="総ダウンロード数" /></a>
    <img src="https://img.shields.io/badge/Windows-10%2B-0078D4?style=flat-square" alt="Windows 10 以降" />
    <img src="https://img.shields.io/badge/macOS-14%2B-0A84FF?style=flat-square&logo=apple&logoColor=white" alt="macOS 14 以降" />
    <img src="https://img.shields.io/badge/Linux-x64-64748b?style=flat-square&logo=linux&logoColor=white" alt="Linux x64" />
    <a href="https://discord.gg/HmdNVVvw5P"><img src="https://img.shields.io/discord/1344259784219689031?color=5865F2&label=Discord&logo=discord&logoColor=white&style=flat-square" alt="Discord"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-A855F7?style=flat-square" alt="ライセンス: MIT" /></a>
</p>

<div align="center">
    <img src=".github/assets/demo.gif">
</div>

## Token Monitor とは

Claude Code、Codex、Hermes Agent、OpenCode、OpenClaw、Cursor、Antigravity、Cline など、さまざまな AI コーディングツールのリアルタイムトークン使用量と AI ツール制限を表示するデスクトップウィジェットです。複数デバイス間のリアルタイム同期、使用履歴トレンド、ツール・デバイス・モデル・セッション別の内訳表示に対応しています。

## 対応ツール

Token Monitor は **トークン使用量**、**アカウント制限**、**セッション詳細** を個別にサポートします。

| Logo | ツール | データパス | トークン使用量 | AI ツール制限 | セッション詳細 |
|:---:|------|-----------|:---:|:---:|:---:|
| <img src=".github/assets/tools-icon/claude.png" width="28" alt="Claude Code" /> | Claude Code | `~/.claude/projects/`, `~/.claude/transcripts/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/codex.png" width="28" alt="Codex" /> | Codex | `~/.codex/sessions/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/opencode.png" width="28" alt="OpenCode" /> | OpenCode | `~/.local/share/opencode/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/hermes-agent.png" width="28" alt="Hermes Agent" /> | Hermes Agent | `$HERMES_HOME/state.db` または `~/.hermes/state.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/openclaw.png" width="28" alt="OpenClaw" /> | OpenClaw | `~/.openclaw/agents/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/cursor.png" width="28" alt="Cursor" /> | Cursor | `~/.config/tokscale/cursor-cache/`（Cursor 同期で更新） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/antigravity.png" width="28" alt="Antigravity" /> | Antigravity | `~/.config/tokscale/antigravity-cache/`（Antigravity 同期で更新） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/cline.png" width="28" alt="Cline" /> | Cline | VS Code globalStorage tasks (`.../saoudrizwan.claude-dev/tasks/`) | ✅ | — | — |
| <img src=".github/assets/tools-icon/kimi.png" width="28" alt="Kimi" /> | Kimi CLI / Kimi Code | `~/.kimi/sessions/`, `~/.kimi-code/sessions/` (`KIMI_CODE_HOME`); Kimi Code API キー（Kimi API で Kimi Code クォータ取得） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/qwen.png" width="28" alt="Qwen" /> | Qwen CLI | `~/.qwen/projects/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/xai.png" width="28" alt="Grok Build" /> | Grok Build | `$GROK_HOME/sessions/` または `~/.grok/sessions/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/copilot.png" width="28" alt="GitHub Copilot" /> | GitHub Copilot | VS Code `workspaceStorage/*/chatSessions/`、`~/.copilot/otel/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/pi.png" width="28" alt="Pi" /> | Pi | `~/.pi/agent/sessions/`, `~/.omp/agent/sessions/` (Oh My Pi) | ✅ | — | — |
| <img src=".github/assets/tools-icon/zed.png" width="28" alt="Zed" /> | Zed | `~/.local/share/zed/threads/threads.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/kilocode.png" width="28" alt="Kilo Code" /> | Kilo Code | VS Code globalStorage tasks (`.../kilocode.kilo-code/tasks/`) — Linux およびリモート/WSL のみ | ✅ | — | — |
| <img src=".github/assets/tools-icon/mimo-code.png" width="28" alt="MiMo Code" /> | MiMo Code | `~/.local/share/mimocode/mimocode.db` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/zcode.png" width="28" alt="ZCode" /> | ZCode / GLM | `~/.zcode/projects/`; Z.ai API キー（Z.ai API で GLM 個人/チーム Coding Plan クォータ取得） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/kiro.png" width="28" alt="Kiro" /> | Kiro | `~/.kiro/sessions/cli/`, Kiro IDE globalStorage および `kiro-cli` DB | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/codebuddy.png" width="28" alt="CodeBuddy" /> | CodeBuddy | `~/.codebuddy/projects/` + IDE / VS Code 拡張ログ | ✅ | — | — |
| <img src=".github/assets/tools-icon/workbuddy.png" width="28" alt="WorkBuddy" /> | WorkBuddy | `~/.workbuddy/projects/`, `~/.workbuddy/workbuddy.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/proma.png" width="28" alt="Proma" /> | Proma | `~/.proma/agent-sessions/*.jsonl` | ✅ | — | — |
| <img src=".github/assets/tools-icon/deepseek.png" width="28" alt="DeepSeek" /> | DeepSeek | DeepSeek API キー（DeepSeek API で残高取得） | — | ✅ | — |
| <img src=".github/assets/tools-icon/minimax.png" width="28" alt="Minimax" /> | Minimax | Minimax API キー（Minimax API で Token Plan クォータ取得） | — | ✅ | — |
| <img src=".github/assets/tools-icon/volcengine.png" width="28" alt="Volcengine" /> | Volcengine | Ark API key または Volcengine AK/SK（Volcengine API で Ark Coding Plan クォータ取得） | — | ✅ | — |
| <img src=".github/assets/tools-icon/qoder.png" width="28" alt="Qoder" /> | Qoder | Qoder dashboard cookie（Qoder usage API で big-model credits 取得） | — | ✅ | — |
| <img src=".github/assets/tools-icon/ollama.png" width="28" alt="Ollama" /> | Ollama | Ollama Cloud cookie（ollama.com/settings で session/weekly 使用量を取得） | — | ✅ | — |

## Token Monitor を使う理由

多くの使用量モニターは、実行しているマシン上でのみ役立ちます。Token Monitor はマルチデバイス作業のために設計されています。各デバイスがローカルログを監視し、hub にサマリーを送信すると、接続されたすべてのウィジェットがトークンの変化をほぼリアルタイムで確認できます。

## 機能

- **リアルタイムトークン追跡** — Claude Code、Codex、Hermes Agent、OpenCode、OpenClaw、Cursor、Antigravity、Cline、Kimi、Qwen、Grok Build、GitHub Copilot、Pi、Zed、Kilo Code、MiMo Code、ZCode、Kiro、CodeBuddy、WorkBuddy、Proma（各ターンから数秒以内に UI 更新）
- **WSL 使用量 (Windows)** — 実行中の WSL ディストリビューション内の AI ツール使用量を自動検出して合算（約 5 分ごとの定期スキャン）
- **マルチデバイスリアルタイム同期** — Server-Sent Events
- **内訳ビュー** — ツール、デバイス、モデル、セッション、アカウント制限別
- **セッション別詳細** — Claude Code、Codex、OpenCode セッションでプロンプトごとのトークン、各応答のトークン分割・使用ツールまで展開（ローカル transcript/DB を必要時のみ読み込み、同期しない）
- **キャッシュヒット統計** — ツール・モデルをクリックすると入力トークン（キャッシュ hit/miss）、出力トークン、ヒット率の詳細
- **コスト内訳** — トークン数とともにコストを表示
- **希望の通貨でコスト表示** — USD、TWD、HKD、CNY；為替レートは毎日自動更新、設定で手動上書き可能
- **使用トレンド & ダッシュボード** — ホーム画面のアクティビティヒートマップ・トレンドチャート、連続日数・全デバイス横断のツール/モデル別累積使用（棒・K 線）専用ダッシュボードウィンドウ
- **データエクスポート** — ツール非依存の CSV + JSON で手動エクスポートまたはフォルダへの自動書き込み（スプレッドシート、Obsidian、Grafana、スクリプト用）；[docs/export.md](docs/export.md) を参照
- **AI ツール制限検出** — Claude Code、Codex、Cursor、Antigravity、OpenCode、Grok、Minimax、MiMo、GitHub Copilot、Kiro、GLM、Volcengine、Qoder、Kimi、Ollama のプロバイダー固有の session/weekly/billing/credits、DeepSeek プリペイド残高・本日/今月の使用額。追跡済みの Codex アカウントは、再認証なしでローカル Codex アカウントに切り替えできます
- **ステータスビュー**（任意） — Claude、OpenAI、Cursor、DeepSeek のステータスページを手動/定期確認
- **ツールリストのカスタマイズ** — 追跡は維持したまま非表示、ピン留め、順序変更
- **外観** — テーマ（ライトモード含む）、ツール別カラー、ガラス透明度・ぼかし、透明ウィンドウ
- **メニューバー (macOS) / システムトレイ (Windows)** — コスト、トークン、Claude/Codex/Cursor/Antigravity/OpenCode/Grok/Minimax/MiMo/GitHub Copilot/Kiro/GLM/Volcengine/Qoder/Kimi/Ollama 制限 % など
- **フローティングバブル** — ドラッグ可能なミニウィンドウ、クリック/ホバープレビュー
- **グローバルショートカット** — どこからでもウィンドウの表示/非表示
- **ローカルファースト** — 単一デバイスではサーバー不要
- **セルフホスト同期** — ウィジェット内 hub、Node CLI hub、Cloudflare Worker
- **iOS ウィジェット** — Worker hub + Widgy、Scriptable
- **Discord Rich Presence** — 本日のトークン・コスト・主要クライアント（オプトイン）
- **プライバシー優先** — サマリー数値のみがデバイス外に送信される

| 制限ビュー | デバイスビュー | モデルビュー |
|:---:|:---:|:---:|
| ![制限ビュー](.github/assets/limits-view.png) | ![デバイスビュー](.github/assets/devices-view.png) | ![モデルビュー](.github/assets/models-view.png) |

| セッションビュー | セッション詳細 | サービスステータス |
|:---:|:---:|:---:|
| ![セッションビュー](.github/assets/sessions-view.png) | ![セッション詳細](.github/assets/session-details.png) | ![サービスステータス](.github/assets/status-view.png) |

| 使用ダッシュボード — 概要 | 使用ダッシュボード — トレンド |
|:---:|:---:|
| ![使用ダッシュボード概要](.github/assets/dashboard-overview.png) | ![使用ダッシュボードトレンド](.github/assets/dashboard-trends.png) |

## インストール

[GitHub Releases](https://github.com/Javis603/token-monitor/releases) からダウンロードできます。

- **macOS (Apple Silicon)** — `.dmg`、署名および notarize 済み
- **Windows 10/11** — インストーラー `.exe`。署名は準備中のため SmartScreen が表示される場合があります
- **Linux x64** — `.AppImage`

パッケージ版は GitHub Releases を自動確認します。新しいバージョンがある場合は画面に更新インジケーターが表示され、対応プラットフォームでは 設定 → 一般 からもインストールできます。

### 初回起動

ローカルモードがデフォルトです。アプリを起動すると、このデバイスの追跡を開始します。hub、agent、設定は不要です。

## マルチデバイス同期

すべてのデバイス（および headless agent）が接続する **hub を 1 つ** 選びます。各デバイスでウィジェットを開き、**設定 → マルチデバイス同期** でモードを選択します。ウィジェットがこのデバイスの使用量を自動的にアップロードします。ウィジェットがないマシンでのみ `npm run agent` を実行してください。

#### オプション A — ウィジェットから hub をホスト（最も簡単、CLI 不要）

常時起動のマシンで **設定 → マルチデバイス同期 → Host hub on this device** を選択します。ウィジェットが secret を生成し、LAN URL（Tailscale/ZeroTier 含む）を表示します。他のデバイスでは **Connect to a hub** に URL と secret を貼り付けます。

Token Monitor が実行中の間のみ hub が動作します。アプリを終了すると（ウィンドウを閉じるだけではなく）hub が停止し、接続されたデバイスが切断されます。

#### オプション B — Node hub をセルフホスト（常時 headless マシン）

```bash
# 常時起動のマシンで
cp .env.example .env
# TOKEN_MONITOR_SECRET を非公開の値に設定してから:
npm run hub
```

#### オプション C — Cloudflare Worker hub（ネットワーク間、iPhone 含む）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Javis603/token-monitor/tree/main/worker)

ワンクリックデプロイでは `TOKEN_MONITOR_SECRET` の入力を求められます。手動デプロイ:

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put TOKEN_MONITOR_SECRET
npx wrangler deploy
```

デプロイ URL を各デバイスの **設定 → マルチデバイス同期** に貼り付けます。iOS ウィジェットは [worker/README.md](worker/README.md)、HTTP API は [docs/API.md](docs/API.md) を参照してください。

## アプリデータ

アプリの状態は OS のユーザーデータディレクトリに保存されます。アプリと一緒にそのフォルダを削除すると完全にアンインストールできます。

| プラットフォーム | パス |
|--------|------|
| macOS | `~/Library/Application Support/Token Monitor/` |
| Windows | `%APPDATA%/Token Monitor/` |
| Linux | `~/.config/Token Monitor/` |

## ソースからビルド

自分でインストーラーをビルドする場合は、**対象 OS** 上で Node.js 22.13+ を使用してください（electron-builder は macOS `.dmg` と Windows `.exe` のクロスビルド不可）。

```bash
npm install
npm run dist:mac   # macOS arm64 .dmg          → dist/
npm run dist:win   # Windows x64 installer .exe → dist/
npm run dist:linux # Linux x64 AppImage        → dist/
npm run pack       # インストーラーなしのアプリディレクトリ（ローカルテスト用）
```

出力は `dist/` に生成されます。Windows と Linux は対象 OS 上で上記の対応する `dist:*` スクリプトを使います。macOS リリース版をパッケージングするには、この Mac に Developer ID Application の署名 ID が必要です。ローカル開発または未対応プラットフォームでは `npm start` を使ってください。

## 動作の仕組み

```text
モード A — ローカル（デフォルト、設定不要）
    ウィジェット (Electron) ──▶ tokscale ──▶ ~/.claude, ~/.codex, $HERMES_HOME

モード B — 同期（オプトイン、マルチデバイス）
    デバイス A agent ──▶
    デバイス B agent ──▶  hub  ──▶  任意のデバイスのウィジェット
    デバイス C agent ──▶
```

ウィジェットは **設定 → マルチデバイス同期** に応じてローカル/同期を選択します。hub は `npm run hub`、Cloudflare Worker、またはウィジェット内 Host モードで実行できます。同期モードでは hub が SSE で集計統計をプッシュし、1 台の変更が数秒以内に他のデバイスに反映されます。

## 設定

### ウィジェット (GUI)

ウィジェットヘッダーの `⚙` ボタンで設定パネルを開きます。

- **マルチデバイス同期** — **Local only**、**Connect to a hub**、**Host hub on this device**
- **追跡ツール** — 収集対象の選択、リストでの非表示・ピン留め・順序変更
- **AI ツール制限** — Claude Code、Codex、Cursor、Antigravity、OpenCode、DeepSeek、Grok、Minimax、MiMo、GitHub Copilot、Kiro、GLM、Volcengine、Qoder、Kimi、Ollama の制限検出と更新頻度
- **トレンド** — 日次使用履歴のスキャン間隔を選択またはオフ；使用ダッシュボード（ヒートマップ、連続日数、棒/K 線）を開く
- **ウィンドウ動作** — 常に前面、通常ウィンドウ、デスクトップ固定
- **トレイモード** — メニューバー/システムトレイポップオーバー、アイコン横の表示項目を選択
- **フローティングバブル** — ミニウィンドウ、クリック/ホバープレビュー
- **ショートカット** — グローバル表示/非表示
- **外観** — テーマ、カラー、Discord Rich Presence、ガラス効果など
- **詳細設定** — `settings.json` を直接編集（`allTimeSince` など）

ヘッダーのピンボタンで「常に前面」を切り替えます。

### Headless agent と hub (`.env`)

agent と hub には UI がありません。プロジェクトルートの `.env`（`.env.example` をコピー）で設定します。

```env
TOKEN_MONITOR_HUB_URL=               # 同期に必須 — Worker URL または http://<lan-ip>:17321
TOKEN_MONITOR_SECRET=                # hub と同じ secret
TOKEN_MONITOR_DEVICE_ID=             # 任意 — デフォルトはホスト名
TOKEN_MONITOR_CLIENTS=               # 任意 — デフォルトは全ツール；空にすると追跡無効
TOKEN_MONITOR_PROJECTS_ENABLED=      # 任意 — デフォルトは無効；1 でプロジェクトメタデータを収集
TOKEN_MONITOR_HISTORY_ENABLED=       # 任意 — デフォルトは有効；0 でトレンド履歴をスキップ
TOKEN_MONITOR_LIMITS_ENABLED=        # 任意 — デフォルトは有効；0 で CLI プローブをスキップ
TOKEN_MONITOR_LIMIT_PROVIDERS=       # 任意 — claude,codex,cursor,antigravity,opencode,deepseek,minimax,mimo,grok,copilot,kiro,zai,zaiteam,volcengine,qoder,kimi,ollama
```

ウィジェットは同じ env を初回実行のデフォルトとして読み込み、その後 GUI 設定で上書きします。

CLI フラグ（`--hub=`、`--secret=`、`--device=`、`--clients=`、`--history=`、`--limits=`、`--limitProviders=`）は env より優先されます。

一回限りの実行例:

```bash
npm run agent -- --clients=claude,codex,opencode --once
```

## プライバシー

hub と agent はサマリーフィールドのみを送信します。

- デバイス id、ホスト名、プラットフォーム
- 期間別の総トークン（本日 / 今月 / 全期間）
- コスト合計（`tokscale` がコストを返す場合）
- クライアント・モデル別の内訳
- AI ツール制限有効時の正規化された Claude Code/Codex/Cursor/Antigravity/OpenCode/Grok/Minimax/MiMo/GitHub Copilot/Kiro/GLM/Volcengine/Qoder/Kimi/Ollama 制限ステータス

生の AI ログ、プロンプト、ソースコード、会話内容、OAuth・トークン・メール・プロバイダー生レスポンスは送信しません。`.env`、`data/`、`node_modules/` は gitignore されます。

## 要件

- macOS、Windows、または Linux x64
- Node.js 22.13+
- 同期モードのみ: agent/ウィジェットから hub へのネットワーク接続

## Star 履歴

<a href="https://www.star-history.com/?repos=Javis603%2Ftoken-monitor&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Javis603/token-monitor&type=date&theme=dark&legend=top-left&sealed_token=VEcaPQSNlH8coYjuILJy7eT6t-pGJrGDEjOAjVwP8WGwNBOeNXoLTcz-KVBaZ2Y8eSqG1tLEpWGF3-5eMvVhW5G8n1ckdYI_uMZ6UCBE7b_eANd6we__7g7yc4ShXemuWfi-8SRcxgJNLK12VZGgBIccY1ceI3T3xm7jBM1TJjTVQFWJ0MmX2e-7QBp9" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Javis603/token-monitor&type=date&legend=top-left&sealed_token=VEcaPQSNlH8coYjuILJy7eT6t-pGJrGDEjOAjVwP8WGwNBOeNXoLTcz-KVBaZ2Y8eSqG1tLEpWGF3-5eMvVhW5G8n1ckdYI_uMZ6UCBE7b_eANd6we__7g7yc4ShXemuWfi-8SRcxgJNLK12VZGgBIccY1ceI3T3xm7jBM1TJjTVQFWJ0MmX2e-7QBp9" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Javis603/token-monitor&type=date&legend=top-left&sealed_token=VEcaPQSNlH8coYjuILJy7eT6t-pGJrGDEjOAjVwP8WGwNBOeNXoLTcz-KVBaZ2Y8eSqG1tLEpWGF3-5eMvVhW5G8n1ckdYI_uMZ6UCBE7b_eANd6we__7g7yc4ShXemuWfi-8SRcxgJNLK12VZGgBIccY1ceI3T3xm7jBM1TJjTVQFWJ0MmX2e-7QBp9" />
 </picture>
</a>

## コントリビュート

Issue や PR を歓迎します。プロジェクトの規約、アーキテクチャノート、コマンドリファレンスは [AGENTS.md](AGENTS.md) にあります — コーディングエージェント向けに書かれていますが、コントリビューターガイドとしても使えます。

## 謝辞

- [tokscale](https://github.com/junhoyeo/tokscale) — ログ解析とトークン集計
- [CodexBar](https://github.com/steipete/CodexBar) — AI ツール制限の調査

## ライセンス

[MIT](LICENSE) © [@Javis](https://github.com/Javis603)
