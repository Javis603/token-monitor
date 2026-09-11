# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Compact live token rate:** Adds live generation speed (tok/s) or token burn (TPM) to the macOS menu bar and Floating Bubble; custom layouts can use all devices or this device. (#666, #670)
- **Session titles:** Shows persisted Claude, Codex, OpenCode, and DeepSeek Harness conversation titles on the machine where their transcripts are stored. (#658, #665)
- **Codex Auto Review:** Groups background review runs at the bottom of Sessions with aggregate usage and per-run drill-down. (#658)

### Fixed
- **DeepSeek Harness sessions:** Restores usage and Session Detail for versioned v3 transcripts, with correct inherited-session boundaries and failed-attempt usage. (#657)
- **Antigravity usage:** Restores date-filtered sessions that exceeded the previous response limit. (#663)
- **OpenClaw live tracking:** Refreshes new and archived Codex CLI profile sessions when they change. (#663)
- **Codex Session Detail:** Fixes affected sessions showing only `(session start)` without prompt details by correctly parsing current Codex conversation records. (#653)
- **Quota timing labels:** Distinguishes resets, expiries, and simultaneous changes in Limits and Home, including Kiro bonus and GLM/ZCode one-time windows. (#652)
- **Daily history archive:** Preserves the existing archive when a read or validation fails instead of overwriting it. (#646)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.56.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.56.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.56.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-Setup-0.56.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.56.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.56.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0.AppImage)

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
- **紧凑实时 Token 速率：** 支持在 macOS 菜单栏和悬浮球显示生成速度（tok/s）或 Token 消耗（TPM）；自定义布局可选择所有设备或本机。（#666, #670）
- **会话标题：** 在保存对话记录的本机显示 Claude、Codex、OpenCode 和 DeepSeek Harness 的持久化对话标题。（#658, #665）
- **Codex 自动审查：** 将后台审查运行汇总到“会话”底部，显示总用量并支持展开查看每次运行。（#658）

### 修复
- **DeepSeek Harness 会话：** 修复 v3 版本化对话记录无法统计用量或打开详情的问题，并正确处理继承内容与失败尝试用量。（#657）
- **Antigravity 用量：** 修复超过旧响应上限的日期筛选会话缺失问题。（#663）
- **OpenClaw 实时追踪：** Codex CLI 配置文件中的新会话与归档会话发生变化时可及时刷新。（#663）
- **Codex 会话详情：** 修复部分会话只显示 `(session start)`、看不到提问详情的问题，现可正确解析当前格式的 Codex 对话记录。（#653）
- **额度时间标签：** 在“额度”和主页正确区分重置、到期及同时变化，包括 Kiro 奖励与 GLM/ZCode 一次性额度。（#652）
- **每日历史归档：** 读取或校验失败时保留现有归档，不再覆盖原文件。（#646）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.56.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.56.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.56.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-Setup-0.56.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.56.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.56.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.55.0...v0.56.0">v0.55.0...v0.56.0</a></summary>

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
- **精簡即時 Token 速率：** 支援在 macOS 選單列與浮動泡泡顯示生成速度（tok/s）或 Token 消耗（TPM）；自訂版面可選擇所有裝置或這部裝置。（#666, #670）
- **工作階段標題：** 在儲存對話記錄的裝置上顯示 Claude、Codex、OpenCode 與 DeepSeek Harness 的持久化對話標題。（#658, #665）
- **Codex 自動審查：** 將背景審查執行彙整至「工作階段」底部，顯示總用量並可展開查看每次執行。（#658）

### 修復
- **DeepSeek Harness 工作階段：** 修復 v3 版本化對話記錄無法統計用量或開啟詳情的問題，並正確處理繼承內容與失敗嘗試的用量。（#657）
- **Antigravity 用量：** 修復超過舊回應上限的日期篩選工作階段遺漏問題。（#663）
- **OpenClaw 即時追蹤：** Codex CLI 設定檔中的新工作階段與封存工作階段變更時可即時更新。（#663）
- **Codex 工作階段詳情：** 修復部分工作階段只顯示 `(session start)`、看不到提問詳情的問題，現在可正確解析目前格式的 Codex 對話記錄。（#653）
- **額度時間標籤：** 在「額度」與首頁正確區分重設、到期及同時變更，包括 Kiro 獎勵與 GLM/ZCode 一次性額度。（#652）
- **每日歷史封存：** 讀取或驗證失敗時保留現有封存，不再覆寫原檔。（#646）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.56.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.56.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.56.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-Setup-0.56.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.56.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.56.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **컴팩트 실시간 토큰 속도:** macOS 메뉴 막대와 플로팅 버블에서 생성 속도(tok/s) 또는 토큰 소모량(TPM)을 표시합니다. 사용자 설정 레이아웃에서는 모든 기기 또는 이 기기를 선택할 수 있습니다. (#666, #670)
- **세션 제목:** 대화 기록이 저장된 기기에서 Claude, Codex, OpenCode 및 DeepSeek Harness의 저장된 대화 제목을 표시합니다. (#658, #665)
- **Codex 자동 리뷰:** 백그라운드 리뷰 실행을 세션 하단에 모아 전체 사용량을 표시하고 실행별 상세 정보를 펼쳐 볼 수 있습니다. (#658)

### 수정
- **DeepSeek Harness 세션:** 버전이 지정된 v3 대화 기록의 사용량 및 세션 상세 표시를 복구하고, 상속된 내용 경계와 실패한 시도의 사용량을 올바르게 처리합니다. (#657)
- **Antigravity 사용량:** 이전 응답 한도를 초과한 날짜 필터 세션이 누락되던 문제를 수정했습니다. (#663)
- **OpenClaw 실시간 추적:** Codex CLI 프로필의 새 세션과 보관된 세션이 변경되면 즉시 갱신합니다. (#663)
- **Codex 세션 상세:** 일부 세션에 프롬프트 상세 정보 없이 `(session start)`만 표시되던 문제를 수정하고, 현재 형식의 Codex 대화 기록을 올바르게 해석합니다. (#653)
- **할당량 시간 레이블:** 할당량 화면과 홈에서 리셋, 만료 및 동시 변경을 올바르게 구분합니다. Kiro 보너스와 GLM/ZCode 일회성 할당량도 포함됩니다. (#652)
- **일별 기록 보관 파일:** 읽기 또는 검증에 실패해도 기존 보관 파일을 덮어쓰지 않고 유지합니다. (#646)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.56.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.56.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.56.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-Setup-0.56.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.56.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.56.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **コンパクトなライブ Token レート：** macOS メニューバーとフローティングバブルに生成速度（tok/s）または Token 消費（TPM）を表示します。カスタムレイアウトでは、すべてのデバイスまたはこのデバイスを選択できます。（#666, #670）
- **セッションタイトル：** 会話記録が保存されているデバイスで、Claude、Codex、OpenCode、DeepSeek Harness の保存済みタイトルを表示します。（#658, #665）
- **Codex 自動レビュー：** バックグラウンドレビューをセッション下部にまとめ、合計使用量と実行ごとの詳細を表示できます。（#658）

### 修正
- **DeepSeek Harness セッション：** バージョン付きの v3 会話記録で使用量とセッション詳細を再び表示し、継承された内容の境界と失敗した試行の使用量を正しく処理します。（#657）
- **Antigravity の使用量：** 以前の応答上限を超えた日付フィルター対象のセッションが欠落する問題を修正しました。（#663）
- **OpenClaw のライブ追跡：** Codex CLI プロファイルの新規セッションとアーカイブ済みセッションが変更された際に更新します。（#663）
- **Codex セッション詳細：** 一部のセッションでプロンプトの詳細が表示されず `(session start)` だけになる問題を修正し、現行形式の Codex 会話記録を正しく解析します。（#653）
- **クォータ時刻ラベル：** クォータ画面とホームでリセット、期限、同時変更を正しく区別します。Kiro ボーナスと GLM/ZCode の一回限りのクォータも対象です。（#652）
- **日別履歴アーカイブ：** 読み込みまたは検証に失敗しても、既存のアーカイブを上書きせず保持します。（#646）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.56.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.56.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.56.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-Setup-0.56.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.56.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.56.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.56.0/Token-Monitor-0.56.0.AppImage)

</details>

</details>
