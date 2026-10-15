# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Goose usage:** Supports local cumulative usage tracking on macOS and Linux. Session usage is attributed to its creation date. (#1050)
- **WorkBuddy accounts:** Adds official browser sign-in for China and international accounts, with multiple-account management independent of encrypted desktop credentials. (#1020)
- **WorkBuddy quota totals:** Adds an optional total for accounts with current, compatible quotas. Each account retains its own quota. (#1020)
- **Notion AI allowances:** Adds support for rolling and monthly allowances in Business or Enterprise workspaces, configured with a session cookie and Workspace ID. (#1044)
- **Pi session details:** Supports viewing prompts, turns, per-turn token usage and tool records. (#1009)

### Improved
- **Session details:** Updates open details when session usage changes, preserving expanded entries and reading position. (#1009)

### Fixed
- **macOS tray popover:** Fixes the popover reopening after a click on the menu-bar icon closes it. (#1037)
- **Codex Dots usage:** Fixes missing local usage when the desktop app launches its executor with configuration overrides. (#1047)
- **CodeBuddy sub-agent details:** Fixes sub-agent sessions appearing to have no conversation records. (#1042)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.71.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.71.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.71.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-Setup-0.71.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.71.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.71.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0.AppImage)

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

Tokscale is bundled with this app and updated through Token Monitor releases. See **Settings → Advanced → Tokscale** for the version and fork build identifier. Tokscale is MIT, open-source: https://github.com/junhoyeo/tokscale

</details>

---

# 中文

## 更新内容

<!-- app-update-notes:zh:start -->
### 新增
- **Goose 用量：** 支持 macOS 和 Linux 上的本地累计用量追踪，会话用量归入创建日期。 （#1050）
- **WorkBuddy 账号：** 新增国内及国际账号的官方浏览器登录与多账号管理，无需依赖桌面端的加密凭据。 （#1020）
- **WorkBuddy 额度合计：** 可选择合计最新且兼容的账号额度，各账号的额度仍分开使用。 （#1020）
- **Notion AI 额度：** 支持 Business 或 Enterprise 工作区的滚动及月度额度，需配置会话 Cookie 和工作区 ID。 （#1044）
- **Pi 会话详情：** 支持查看提问、回合、每回合 Token 用量和工具记录。 （#1009）

### 改进
- **会话详情：** 用量变化时更新已打开的详情，保留展开内容和阅读位置。 （#1009）

### 修复
- **macOS 托盘弹窗：** 修复点击菜单栏图标关闭后又重新打开的问题。 （#1037）
- **Codex Dots 用量：** 修复桌面端带配置参数启动时本地用量缺失的问题。 （#1047）
- **CodeBuddy 子代理详情：** 修复子代理会话提示没有对话记录的问题。 （#1042）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.71.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.71.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.71.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-Setup-0.71.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.71.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.71.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0.AppImage)

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

Tokscale 已随应用内置，并通过 Token Monitor 发布版本更新。你可以在 **设置 → 高级 → Tokscale** 查看版本和 fork 构建标识。Tokscale 是 MIT 开源项目：https://github.com/junhoyeo/tokscale

</details>

---

<details>
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.70.0...v0.71.0">v0.70.0...v0.71.0</a></summary>

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
- **Goose 用量：** 支援 macOS 與 Linux 上的本機累計用量追蹤，會話用量歸入建立日期。 （#1050）
- **WorkBuddy 帳號：** 新增中國及國際帳號的官方瀏覽器登入與多帳號管理，無需依賴桌面端的加密憑證。 （#1020）
- **WorkBuddy 額度合計：** 可選擇合計最新且相容的帳號額度，各帳號的額度仍分開使用。 （#1020）
- **Notion AI 額度：** 支援 Business 或 Enterprise 工作區的滾動及月度額度，需設定會話 Cookie 與工作區 ID。 （#1044）
- **Pi 會話詳情：** 支援查看提問、回合、每回合 Token 用量與工具記錄。 （#1009）

### 改進
- **會話詳情：** 用量變化時更新已開啟的詳情，保留展開內容與閱讀位置。 （#1009）

### 修復
- **macOS 托盤彈出視窗：** 修復點擊選單列圖示關閉後又重新開啟的問題。 （#1037）
- **Codex Dots 用量：** 修復桌面端帶設定參數啟動時本機用量缺失的問題。 （#1047）
- **CodeBuddy 子代理詳情：** 修復子代理會話提示沒有對話記錄的問題。 （#1042）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.71.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.71.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.71.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-Setup-0.71.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.71.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.71.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Goose 사용량:** macOS와 Linux에서 로컬 누적 사용량을 추적합니다. 세션 사용량은 세션을 생성한 날짜에 반영됩니다. (#1050)
- **WorkBuddy 계정:** 중국 및 글로벌 계정의 공식 브라우저 로그인과 여러 계정 관리를 지원하며, 데스크톱 앱의 암호화된 인증 정보에 의존하지 않습니다. (#1020)
- **WorkBuddy 할당량 합계:** 최신 상태이며 호환되는 계정의 할당량을 합산해 표시하는 옵션을 추가했습니다. 각 계정의 할당량은 별도로 사용합니다. (#1020)
- **Notion AI 한도:** Business 또는 Enterprise 워크스페이스의 롤링 및 월간 한도를 지원합니다. 세션 쿠키와 워크스페이스 ID를 직접 설정해야 합니다. (#1044)
- **Pi 세션 상세:** 질문, 턴, 턴별 토큰 사용량과 도구 기록을 확인할 수 있습니다. (#1009)

### 개선
- **세션 상세:** 사용량이 바뀌면 열린 상세 화면을 갱신하면서 펼친 항목과 읽던 위치를 유지합니다. (#1009)

### 수정
- **macOS 트레이 팝오버:** 메뉴 막대 아이콘을 눌러 닫은 팝오버가 다시 열리는 문제를 수정했습니다. (#1037)
- **Codex Dots 사용량:** 데스크톱 앱이 설정 옵션을 지정해 실행할 때 로컬 사용량이 누락되는 문제를 수정했습니다. (#1047)
- **CodeBuddy 하위 에이전트 상세:** 하위 에이전트 세션에 대화 기록이 없다고 표시되는 문제를 수정했습니다. (#1042)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.71.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.71.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.71.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-Setup-0.71.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.71.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.71.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Goose の使用量:** macOS と Linux でローカルの累積使用量を追跡できます。セッションの使用量は作成日に計上されます。 (#1050)
- **WorkBuddy アカウント:** 中国版・国際版の公式ブラウザログインと複数アカウントの管理に対応しました。デスクトップアプリの暗号化された認証情報に依存しません。 (#1020)
- **WorkBuddy の利用枠合計:** 最新かつ互換性のあるアカウントの利用枠を合計表示するオプションを追加しました。利用枠はアカウントごとに個別に使われます。 (#1020)
- **Notion AI の利用枠:** Business または Enterprise ワークスペースのローリング・月間利用枠に対応しました。セッション Cookie とワークスペース ID の設定が必要です。 (#1044)
- **Pi のセッション詳細:** 質問、ターン、ターンごとのトークン使用量とツール記録を確認できます。 (#1009)

### 改善
- **セッション詳細:** 使用量の変化に合わせて開いている詳細を更新し、展開した項目と閲覧位置を維持します。 (#1009)

### 修正
- **macOS のトレイポップオーバー:** メニューバーのアイコンで閉じた後に再び開く問題を修正しました。 (#1037)
- **Codex Dots の使用量:** デスクトップアプリが設定オプション付きで起動した際にローカル使用量が欠落する問題を修正しました。 (#1047)
- **CodeBuddy のサブエージェント詳細:** サブエージェントのセッションで会話記録がないと表示される問題を修正しました。 (#1042)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.71.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.71.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.71.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-Setup-0.71.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.71.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.71.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.71.0/Token-Monitor-0.71.0.AppImage)

</details>

</details>
