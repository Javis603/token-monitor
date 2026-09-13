# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Custom scan paths:** Adds extra session folders for supported tools through **Settings → Collection → expand a tool → Add path**, covering records outside the default locations. (#674)
- **Session activity and projects:** Adds activity times across discoverable sessions and project attribution when the workspace folder can be identified. (#676)
- **Factory Droid usage:** Supports token usage from Droid CLI and Factory desktop sessions. (#682)
- **Volcengine Agent Plan:** Reads personal Agent Plan quotas automatically from the locally signed-in arkcli account on this computer when explicit Volcengine credentials are not configured. (#655)

### Improved
- **Hub sync bandwidth:** Reduces repeated full statistics transfers for Node and Cloudflare Worker Hubs while keeping older clients compatible. (#649)

### Fixed
- **Codex scheduled resets:** Shows an announced reset schedule instead of leaving the earlier forecast visible. (#679)
- **DeepSeek Harness sessions on Windows:** Switches to the latest versioned transcript even when it is created rapidly, so usage and details do not remain pinned to older data. (#680)
- **Pi-family sessions:** Avoids double-counting copied responses across forked or continued Pi, Senpi, and Omp session files.
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.57.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.57.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.57.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-Setup-0.57.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.57.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.57.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0.AppImage)

<details>
<summary><strong>First launch and other notes</strong></summary>

### First launch

**macOS:** the app is Developer ID-signed and notarized by Apple. Open the `.dmg`, then drag Token Monitor to Applications.

**Windows:** both executables are signed ([how to verify](https://github.com/Javis603/token-monitor/blob/main/docs/code-signing.md#verify-a-download)).

**Linux:** mark the AppImage executable, then run it:

```bash
chmod +x "Token Monitor"*.AppImage
./"Token Monitor"*.AppImage
```

### Other notes

Other platforms are not pre-built — run from source per the [README](https://github.com/Javis603/token-monitor#readme). The macOS `.zip` is the same app repackaged; ignore it unless you specifically need it.

### tokscale dependency

Tokscale is bundled with this app. See **Settings → Tokscale** for the exact version
and the option to download a newer version directly from npm. Tokscale is MIT,
open-source: https://github.com/junhoyeo/tokscale

</details>

---

# 中文

## 更新内容

<!-- app-update-notes:zh:start -->
### 新增
- **自定义扫描路径：** 可通过**“设置”→“采集”→展开工具→“添加路径”**为支持的工具添加额外 session 文件夹，读取不在默认位置的记录。（#674）
- **会话时间与项目：** 为可发现的会话补充活动时间；能识别工作区文件夹时，也会归入对应项目。（#676）
- **Factory Droid 用量：** 支持统计 Droid CLI 与 Factory 桌面版 session 的 Token 用量。（#682）
- **Volcengine Agent Plan：** 未配置 Volcengine 凭据时，可自动读取本机 arkcli 当前登录个人账号的 Agent Plan 额度。（#655）

### 改进
- **Hub 同步流量：** 减少 Node 与 Cloudflare Worker Hub 重复传输完整统计数据，同时保持旧版客户端兼容。（#649）

### 修复
- **Codex 计划重置：** 收到重置排期公告后会显示该排期，不再停留在先前的预测状态。（#679）
- **Windows DeepSeek Harness 会话：** 快速生成版本化对话记录时也会切换到最新记录，避免用量与详情停留在旧数据。（#680）
- **Pi 系列会话：** Pi、Senpi 与 Omp 分叉或续接 session 文件中的已复制响应不再重复计入用量。
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.57.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.57.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.57.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-Setup-0.57.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.57.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.57.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0.AppImage)

<details>
<summary><strong>首次启动与其他说明</strong></summary>

### 首次启动

**macOS：** 应用已使用 Developer ID 签名并通过 Apple 公证。打开 `.dmg`，然后把 Token Monitor 拖到 Applications。

**Windows：** 两个可执行文件均已签名（[查看验证方法](https://github.com/Javis603/token-monitor/blob/main/docs/code-signing.md#verify-a-download)）。

**Linux：** 先给 AppImage 执行权限，然后运行：

```bash
chmod +x "Token Monitor"*.AppImage
./"Token Monitor"*.AppImage
```

### 其他说明

其他平台暂不提供预构建版本，请参考 [README](https://github.com/Javis603/token-monitor#readme) 从源码运行。macOS 的 `.zip` 只是同一个 app 的重新打包版本，除非你明确需要，否则可以忽略。

### tokscale 依赖

Tokscale 已随应用内置。你可以在 **设置 → Tokscale** 查看确切版本，
也可以直接从 npm 下载更新版本。Tokscale 是 MIT 开源项目：
https://github.com/junhoyeo/tokscale

</details>

---

<details>
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.56.0...v0.57.0">v0.56.0...v0.57.0</a></summary>

<!-- github-generated-release-notes -->

</details>

<details>
<summary>繁體中文 · 한국어 · 日本語</summary>

<details>
<summary><strong>繁體中文</strong></summary>

## 繁體中文

## 更新內容

<!-- app-update-notes:zh-TW:start -->
### 新增
- **自訂掃描路徑：** 可透過**「設定」→「採集」→展開工具→「新增路徑」**為支援的工具加入額外 session 資料夾，讀取不在預設位置的記錄。（#674）
- **工作階段時間與專案：** 為可找到的工作階段補上活動時間；能識別工作區資料夾時，也會歸入對應專案。（#676）
- **Factory Droid 用量：** 支援統計 Droid CLI 與 Factory 桌面版 session 的 Token 用量。（#682）
- **Volcengine Agent Plan：** 未設定 Volcengine 憑證時，可自動讀取本機 arkcli 目前登入個人帳號的 Agent Plan 額度。（#655）

### 改進
- **Hub 同步流量：** 減少 Node 與 Cloudflare Worker Hub 重複傳輸完整統計資料，同時保持舊版用戶端相容。（#649）

### 修復
- **Codex 排程重設：** 收到重設排程公告後會顯示該排程，不再停留在先前的預測狀態。（#679）
- **Windows DeepSeek Harness 工作階段：** 快速產生版本化對話記錄時也會切換至最新記錄，避免用量與詳情停留在舊資料。（#680）
- **Pi 系列工作階段：** Pi、Senpi 與 Omp 分支或接續 session 檔案中的已複製回應不再重複計入用量。
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.57.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.57.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.57.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-Setup-0.57.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.57.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.57.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **사용자 지정 스캔 경로:** **설정 → 수집 → 도구 펼치기 → 경로 추가**에서 지원 도구별로 세션 폴더를 추가하여 기본 위치 밖의 기록을 읽을 수 있습니다. (#674)
- **세션 시간 및 프로젝트:** 탐색 가능한 세션에 활동 시간을 표시하고, 작업 공간 폴더를 식별할 수 있으면 해당 프로젝트에 연결합니다. (#676)
- **Factory Droid 사용량:** Droid CLI와 Factory 데스크톱 세션의 토큰 사용량을 지원합니다. (#682)
- **Volcengine Agent Plan:** Volcengine 자격 증명을 직접 설정하지 않은 경우 이 컴퓨터의 arkcli에 로그인된 개인 계정에서 Agent Plan 할당량을 자동으로 읽습니다. (#655)

### 개선
- **Hub 동기화 트래픽:** 이전 클라이언트 호환성을 유지하면서 Node 및 Cloudflare Worker Hub의 반복적인 전체 통계 전송을 줄였습니다. (#649)

### 수정
- **Codex 예약 리셋:** 리셋 일정이 공지되면 이전 예측 대신 공지된 일정을 표시합니다. (#679)
- **Windows의 DeepSeek Harness 세션:** 버전이 지정된 대화 기록이 빠르게 생성되어도 최신 기록으로 전환되어 사용량과 상세 정보가 이전 데이터에 머무르지 않습니다. (#680)
- **Pi 계열 세션:** 포크하거나 이어서 진행한 Pi, Senpi 및 Omp 세션 파일에 복사된 응답이 중복 집계되지 않습니다.
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.57.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.57.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.57.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-Setup-0.57.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.57.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.57.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **カスタムスキャンパス：** **設定 → 収集 → ツールを展開 → パスを追加**から、対応ツールごとに追加のセッションフォルダーを指定し、既定の場所にない記録を読み込めます。（#674）
- **セッション時刻とプロジェクト：** 検出可能なセッションにアクティビティ時刻を表示し、ワークスペースフォルダーを識別できる場合は該当プロジェクトに関連付けます。（#676）
- **Factory Droid の使用量：** Droid CLI と Factory デスクトップのセッションで Token 使用量を集計できます。（#682）
- **Volcengine Agent Plan：** Volcengine の認証情報を明示的に設定していない場合、このコンピューターで arkcli にログイン中の個人アカウントから Agent Plan のクォータを自動取得します。（#655）

### 改善
- **Hub 同期トラフィック：** 旧バージョンのクライアントとの互換性を保ちながら、Node および Cloudflare Worker Hub による完全な統計データの重複送信を減らしました。（#649）

### 修正
- **Codex の予定リセット：** リセット予定が告知されると、以前の予測ではなく告知された予定を表示します。（#679）
- **Windows の DeepSeek Harness セッション：** バージョン付きの会話記録が短時間に作成されても最新の記録へ切り替わり、使用量や詳細が古いデータのまま残りません。（#680）
- **Pi 系セッション：** フォークまたは継続した Pi、Senpi、Omp のセッションファイルにコピーされた応答を重複計上しません。
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.57.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.57.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.57.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-Setup-0.57.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.57.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.57.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.57.0/Token-Monitor-0.57.0.AppImage)

</details>

</details>
