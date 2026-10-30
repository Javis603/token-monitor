# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Desktop plugins (experimental):** Adds extensions for main-window content, Notch Panel, Edge Dock and tray. Customize Token Monitor to suit your needs. (#1164)
- **Plugin discovery:** Browse a preset community catalog with localized descriptions, screenshots and update notes. (#1253)
- **Session reasoning effort:** Shows Codex and Claude Code session reasoning effort beside the model in real time. (#1224)
- **Volcengine Coding Plan quota:** Supports personal session, weekly and monthly limits through an existing `arkcli` login, without copying access keys. (#1211)

### Changed
- **Codex Pro labels:** Uses Pro 100, Pro 200 and Pro 500 to match the plan names shown by Codex. (#1244)
- **Proma usage totals:** Adjusts historical accounting to avoid counting the same usage twice. Some usage retained only in older archives no longer contributes to totals; daily trends keep their previously recorded values. (#1227)

### Improved
- **Multi-device sync:** Reduces traffic for session activity refreshes and usage updates when connected to an updated Hub or Worker. (#1250)
- **Proma usage:** Includes SDK transcripts and `.proma-dev` sessions alongside Agent journals. (#1227)
- **Grok Build speed:** Shows token generation speed when the session records inference timing. (#1227)

### Fixed
- **Windows Dots usage:** Fixes discovery failures that could leave local tasks without usage updates. Offline history and the main Dots chat are outside this coverage. (#1243)
- **macOS desktop widgets:** Fixes stale data caused by an old widget extension remaining active after an app update. (#1216)
- **Edge Dock auto-hide:** Prevents hidden rails and hover cards from briefly appearing after switching Spaces on macOS versions before 26. (#1194)
- **Hub responsiveness:** Prevents uploaded client names containing long runs of dashes from stalling the Hub or Worker. (#1252)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.81.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.81.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.81.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-Setup-0.81.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.81.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.81.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0.AppImage)

<details>
<summary><strong>First launch and other notes</strong></summary>

### First launch

**macOS:** the app is Developer ID-signed and notarized by Apple. Open the `.dmg`, then drag Token Monitor to Applications.

**Windows:** both executables are signed ([how to verify](https://github.com/Javis603/token-monitor/blob/main/docs/code-signing.md#verify-a-download)).

**Linux:** mark the AppImage executable, then run it:

```bash
chmod +x Token-Monitor-*.AppImage
./Token-Monitor-*.AppImage
```

### Other notes

Other platforms are not pre-built — run from source per the [README](https://github.com/Javis603/token-monitor#readme). The macOS `.zip` is the same app repackaged; ignore it unless you specifically need it.

### tokscale dependency

Tokscale is bundled with this app and updated through Token Monitor releases. See **Settings → Advanced → Tokscale** for the version and fork build identifier. Tokscale is MIT, open-source: https://github.com/junhoyeo/tokscale

</details>

---

# 中文

## 更新内容

<!-- app-update-notes:zh:start -->
### 新增
- **桌面插件（实验性）：** 支持为主窗口内容、刘海面板、Edge Dock 和托盘添加扩展。按你的需要自定义 Token Monitor。 （#1164）
- **插件发现：** 支持浏览预设社区目录，查看本地化介绍、截图及更新说明。 （#1253）
- **会话推理强度：** 在模型旁实时显示 Codex 和 Claude Code 会话的推理强度。 （#1224）
- **火山引擎 Coding Plan 额度：** 支持通过已登录的 `arkcli` 读取个人套餐的会话、每周及每月额度，无需复制访问密钥。 （#1211）

### 变更
- **Codex Pro 名称：** 改用 Pro 100、Pro 200 和 Pro 500，与 Codex 显示的套餐名称一致。 （#1244）
- **Proma 用量统计：** 调整历史用量统计，避免重复计数。部分仅保存在旧存档中的用量不再计入总量，每日趋势仍保留原有数据。 （#1227）

### 改进
- **多设备同步：** 连接更新后的 Hub 或 Worker 时，减少会话活动刷新和用量更新的同步流量。 （#1250）
- **Proma 用量：** 除 Agent 日志外，支持读取 SDK 会话记录及 `.proma-dev` 会话。 （#1227）
- **Grok Build 速度：** 会话记录包含推理耗时时，可显示 Tokens 生成速度。 （#1227）

### 修复
- **Windows Dots 用量：** 修复本机任务发现失败、用量无法更新的问题；不覆盖离线历史和点点主聊天。 （#1243）
- **macOS 桌面小组件：** 修复应用更新后旧扩展仍在运行，导致数据停留在更新前的问题。 （#1216）
- **Edge Dock 自动隐藏：** 修复 macOS 26 之前的版本切换空间后，已隐藏的侧栏或悬浮卡片短暂闪现的问题。 （#1194）
- **Hub 响应：** 修复上传的工具名称含大量连续短横线时，Hub 或 Worker 可能卡顿的问题。 （#1252）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.81.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.81.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.81.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-Setup-0.81.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.81.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.81.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0.AppImage)

<details>
<summary><strong>首次启动与其他说明</strong></summary>

### 首次启动

**macOS：** 应用已使用 Developer ID 签名并通过 Apple 公证。打开 `.dmg`，然后把 Token Monitor 拖到 Applications。

**Windows：** 两个可执行文件均已签名（[查看验证方法](https://github.com/Javis603/token-monitor/blob/main/docs/code-signing.md#verify-a-download)）。

**Linux：** 先给 AppImage 执行权限，然后运行：

```bash
chmod +x Token-Monitor-*.AppImage
./Token-Monitor-*.AppImage
```

### 其他说明

其他平台暂不提供预构建版本，请参考 [README](https://github.com/Javis603/token-monitor#readme) 从源码运行。macOS 的 `.zip` 只是同一个 app 的重新打包版本，除非你明确需要，否则可以忽略。

### tokscale 依赖

Tokscale 已随应用内置，并通过 Token Monitor 发布版本更新。你可以在 **设置 → 高级 → Tokscale** 查看版本和 fork 构建标识。Tokscale 是 MIT 开源项目：https://github.com/junhoyeo/tokscale

</details>

---

<details>
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.80.0...v0.81.0">v0.80.0...v0.81.0</a></summary>

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
- **桌面外掛（實驗性）：** 支援為主視窗內容、瀏海面板、Edge Dock 與系統匣加入擴充功能。依照你的需要自訂 Token Monitor。 （#1164）
- **外掛探索：** 可瀏覽預設社群目錄，查看在地化介紹、螢幕截圖與更新說明。 （#1253）
- **會話推理強度：** 在模型旁即時顯示 Codex 與 Claude Code 會話的推理強度。 （#1224）
- **火山引擎 Coding Plan 額度：** 支援透過已登入的 `arkcli` 讀取個人方案的會話、每週及每月額度，不必複製存取金鑰。 （#1211）

### 變更
- **Codex Pro 名稱：** 改用 Pro 100、Pro 200 與 Pro 500，與 Codex 顯示的方案名稱一致。 （#1244）
- **Proma 用量統計：** 調整歷史用量統計，避免重複計算。部分僅存於舊封存紀錄的用量不再計入總量，每日趨勢仍保留原有資料。 （#1227）

### 改進
- **多裝置同步：** 連接更新後的 Hub 或 Worker 時，減少會話活動刷新與用量更新的同步流量。 （#1250）
- **Proma 用量：** 除 Agent 日誌外，支援讀取 SDK 會話紀錄與 `.proma-dev` 會話。 （#1227）
- **Grok Build 速度：** 會話紀錄包含推理耗時時，可顯示 Token 生成速度。 （#1227）

### 修復
- **Windows Dots 用量：** 修復本機任務探索失敗、用量無法更新的問題；不涵蓋離線歷史與點點主聊天。 （#1243）
- **macOS 桌面小工具：** 修復應用程式更新後舊擴充功能仍在執行，導致資料停留在更新前的問題。 （#1216）
- **Edge Dock 自動隱藏：** 修復 macOS 26 之前的版本切換空間後，已隱藏的側欄或浮動卡片短暫閃現的問題。 （#1194）
- **Hub 回應：** 修復上傳的工具名稱含大量連續短橫線時，Hub 或 Worker 可能停頓的問題。 （#1252）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.81.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.81.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.81.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-Setup-0.81.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.81.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.81.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **데스크톱 플러그인(실험적):** 기본 창 콘텐츠, 노치 패널, Edge Dock과 트레이를 확장할 수 있습니다. 필요에 맞게 Token Monitor를 꾸밀 수 있습니다. (#1164)
- **플러그인 탐색:** 기본 제공 커뮤니티 카탈로그에서 현지화된 소개, 스크린샷과 업데이트 내용을 확인할 수 있습니다. (#1253)
- **세션 추론 강도:** Codex와 Claude Code 세션의 추론 강도를 모델 옆에 실시간으로 표시합니다. (#1224)
- **Volcengine Coding Plan 한도:** 로그인된 `arkcli`를 통해 개인 요금제의 세션, 주간 및 월간 한도를 확인할 수 있습니다. 액세스 키를 복사할 필요가 없습니다. (#1211)

### 변경
- **Codex Pro 이름:** Codex에 표시되는 요금제 이름에 맞춰 Pro 100, Pro 200, Pro 500을 사용합니다. (#1244)
- **Proma 사용량 집계:** 같은 사용량이 중복 계산되지 않도록 과거 사용량 집계 방식을 조정했습니다. 이전 보관 기록에만 남은 일부 사용량은 합계에서 제외되며, 일별 추이에는 기존 기록이 유지됩니다. (#1227)

### 개선
- **다중 기기 동기화:** 업데이트된 Hub 또는 Worker에 연결하면 세션 활동 새로고침과 사용량 업데이트에 필요한 트래픽이 줄어듭니다. (#1250)
- **Proma 사용량:** Agent 로그 외에 SDK 대화 기록과 `.proma-dev` 세션도 읽습니다. (#1227)
- **Grok Build 속도:** 세션에 추론 시간이 기록되어 있으면 토큰 생성 속도를 표시합니다. (#1227)

### 수정
- **Windows Dots 사용량:** 로컬 작업을 찾지 못해 사용량이 갱신되지 않는 문제를 수정했습니다. 오프라인 기록과 Dots 기본 채팅은 포함되지 않습니다. (#1243)
- **macOS 데스크톱 위젯:** 앱 업데이트 후 이전 위젯 확장이 계속 실행되어 오래된 데이터가 표시되는 문제를 수정했습니다. (#1216)
- **Edge Dock 자동 숨김:** macOS 26 이전 버전에서 Spaces를 전환한 뒤 숨겨진 바나 호버 카드가 잠깐 나타나는 문제를 수정했습니다. (#1194)
- **Hub 응답성:** 업로드된 도구 이름에 하이픈이 길게 이어져 있을 때 Hub나 Worker가 멈추는 문제를 수정했습니다. (#1252)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.81.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.81.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.81.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-Setup-0.81.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.81.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.81.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **デスクトッププラグイン（実験的）:** メインウィンドウのコンテンツ、ノッチパネル、Edge Dock、トレイを拡張できます。用途に合わせてToken Monitorをカスタマイズできます。 (#1164)
- **プラグインの検索:** あらかじめ登録されたコミュニティカタログで、各言語の紹介、スクリーンショット、更新内容を確認できます。 (#1253)
- **セッションの推論強度:** CodexとClaude Codeのセッションの推論強度を、モデルの横にリアルタイムで表示します。 (#1224)
- **Volcengine Coding Planの上限:** ログイン済みの`arkcli`で、個人プランのセッション、週間、月間の上限を確認できます。アクセスキーのコピーは不要です。 (#1211)

### 変更
- **Codex Proの名称:** Codexの表示に合わせて、Pro 100、Pro 200、Pro 500を使用します。 (#1244)
- **Promaの使用量集計:** 二重計上を避けるため、過去の使用量の集計方法を調整しました。古い保存データにしか残っていない使用量の一部は合計から除外されます。日別推移には従来の記録が残ります。 (#1227)


### 改善
- **複数デバイスの同期:** 更新済みのHubまたはWorkerに接続すると、セッションの活動情報や使用量の更新に必要な通信量を抑えられます。 (#1250)
- **Promaの使用量:** Agentログに加え、SDKの会話記録と`.proma-dev`のセッションも読み取ります。 (#1227)
- **Grok Buildの速度:** セッションに推論時間が記録されている場合、トークンの生成速度を表示します。 (#1227)

### 修正
- **WindowsのDots使用量:** ローカルタスクを検出できず、使用量が更新されない問題を修正しました。オフラインの履歴とDotsのメインチャットは対象外です。 (#1243)
- **macOSのデスクトップウィジェット:** アプリ更新後も古い拡張機能が動作し、更新前のデータが表示される問題を修正しました。 (#1216)
- **Edge Dockの自動非表示:** macOS 26より前のバージョンで、Spaces切り替え後に非表示のバーやホバーカードが一瞬表示される問題を修正しました。 (#1194)
- **Hubの応答性:** アップロードされたツール名に長いハイフンの連続が含まれると、HubやWorkerが応答しなくなる問題を修正しました。 (#1252)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.81.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.81.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.81.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-Setup-0.81.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.81.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.81.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.81.0/Token-Monitor-0.81.0.AppImage)

</details>

</details>
