# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **OmO Native usage:** Adds token usage tracking and session details. Existing installs can enable it under Settings → Tools. (#1193)
- **Notch Panel trackpad navigation:** Swipe horizontally on a macOS trackpad to switch pages and browse quota accounts. (#1175)

### Changed
- **Notch Panel:** Graduates from experimental to a standard display mode, with settings under Window. (#1203)

### Improved
- **Display mode settings:** Organizes display modes into dedicated pages with previews. (#1203)
- **Notch Panel quick controls:** Adds menu-bar controls for visibility, hover behavior and collapsed summaries, plus a settings shortcut. (#1189)

### Fixed
- **OpenCode Console:** Restores Go quota and Zen balance display for accounts signed in through Console. (#1199)
- **Update button:** Stays accessible when Refresh expands and while Settings is open. (#1192)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.79.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.79.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.79.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-Setup-0.79.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.79.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.79.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0.AppImage)

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
- **OmO Native 用量：** 支持 Token 用量追踪与会话详情；已有安装可在“设置 → 工具”中启用。 （#1193）
- **刘海面板触控板导航：** 支持通过 macOS 触控板横向滑动切换页面和浏览额度账号。 （#1175）

### 变更
- **刘海面板：** 从实验性功能转为正式显示模式，设置移至“窗口”。 （#1203）

### 改进
- **显示模式设置：** 将显示模式整理为独立设置页，并加入预览。 （#1203）
- **刘海面板快捷控制：** 菜单栏新增显示开关、悬停行为、收起摘要控制及设置快捷入口。 （#1189）

### 修复
- **OpenCode Console：** 修复使用 Console 登录的账号无法显示 Go 额度和 Zen 余额的问题。 （#1199）
- **更新按钮：** 刷新按钮展开时不再重叠，打开设置后也能继续使用。 （#1192）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.79.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.79.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.79.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-Setup-0.79.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.79.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.79.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.78.0...v0.79.0">v0.78.0...v0.79.0</a></summary>

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
- **OmO Native 用量：** 支援 Token 用量追蹤與會話詳情；既有安裝可在「設定 → 工具」中啟用。 （#1193）
- **瀏海面板觸控板導覽：** 支援透過 macOS 觸控板橫向滑動切換頁面和瀏覽額度帳號。 （#1175）

### 變更
- **瀏海面板：** 從實驗性功能轉為正式顯示模式，設定移至「視窗」。 （#1203）

### 改進
- **顯示模式設定：** 將顯示模式整理為獨立設定頁，並加入預覽。 （#1203）
- **瀏海面板快捷控制：** 選單列新增顯示開關、懸停行為、收合摘要控制及設定捷徑。 （#1189）

### 修復
- **OpenCode Console：** 修復使用 Console 登入的帳號無法顯示 Go 額度和 Zen 餘額的問題。 （#1199）
- **更新按鈕：** 重新整理按鈕展開時不再重疊，開啟設定後也能繼續使用。 （#1192）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.79.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.79.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.79.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-Setup-0.79.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.79.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.79.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **OmO Native 사용량:** 토큰 사용량 추적과 세션 상세 정보를 지원합니다. 기존 설치에서는 '설정 → 도구'에서 켤 수 있습니다. (#1193)
- **노치 패널 트랙패드 탐색:** macOS 트랙패드를 좌우로 쓸어 페이지를 전환하고 한도 계정을 탐색할 수 있습니다. (#1175)

### 변경
- **노치 패널:** 실험 기능에서 정식 표시 모드로 전환하고, 설정을 '창'으로 옮겼습니다. (#1203)

### 개선
- **표시 모드 설정:** 모드별 설정 페이지와 미리보기를 제공합니다. (#1203)
- **노치 패널 빠른 제어:** 메뉴 막대에서 표시 여부, 마우스 오버 동작, 접힌 상태의 요약을 설정하고 상세 설정으로 바로 이동할 수 있습니다. (#1189)

### 수정
- **OpenCode Console:** Console로 로그인한 계정의 Go 한도와 Zen 잔액이 표시되지 않는 문제를 해결했습니다. (#1199)
- **업데이트 버튼:** 새로고침 버튼을 펼쳐도 겹치지 않으며, 설정을 연 상태에서도 사용할 수 있습니다. (#1192)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.79.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.79.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.79.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-Setup-0.79.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.79.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.79.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **OmO Native の使用量:** トークン使用量の追跡とセッション詳細に対応しました。既存のインストールでは「設定 → ツール」で有効にできます。 (#1193)
- **ノッチパネルのトラックパッド操作:** macOS のトラックパッドを左右にスワイプして、ページやクォータのアカウントを切り替えられます。 (#1175)

### 変更
- **ノッチパネル:** 実験的機能から正式な表示モードに移行し、設定を「ウィンドウ」に移動しました。 (#1203)

### 改善
- **表示モードの設定:** モードごとの設定ページとプレビューを用意しました。 (#1203)
- **ノッチパネルのクイック操作:** メニューバーから表示・非表示、ホバー動作、折りたたみ時の概要を設定でき、詳細設定へのショートカットも追加しました。 (#1189)

### 修正
- **OpenCode Console:** Console でログインしたアカウントの Go クォータと Zen 残高が表示されない問題を修正しました。 (#1199)
- **更新ボタン:** 再読み込みボタンを展開しても重ならず、設定を開いている間も使えるようにしました。 (#1192)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.79.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.79.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.79.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-Setup-0.79.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.79.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.79.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.79.0/Token-Monitor-0.79.0.AppImage)

</details>

</details>
