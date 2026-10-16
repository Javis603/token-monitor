# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Cursor plans:** Supports The X Subscription plans, with included-usage quotas and prepaid balances. (#1056)

### Improved
- **Update controls:** Download or restart from the update button; hover over it or focus it with the keyboard to view release notes. (#1065)
- **Update checks:** Checks shortly after launch and more frequently in the background, including after wake or unlock. (#1065)

### Fixed
- **OpenCode 2.x sessions:** Restores conversation records and missing token usage in session details after upgrading. (#1060)
- **Session groups:** Corrects call counts, cache-hit rates, generation speed and latest activity time across grouped sessions. (#1053)
- **Windows Edge Dock:** Fixes clicks and drags becoming unresponsive after unlocking the screen. (#1059)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.72.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.72.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.72.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-Setup-0.72.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.72.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.72.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0.AppImage)

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
- **Cursor 方案：** 支持 The X Subscription 方案的内含用量额度与预付余额。 （#1056）

### 改进
- **更新按钮：** 可直接下载或重启更新，悬停或通过键盘聚焦按钮即可查看更新内容。 （#1065）
- **更新检查：** 启动后稍候即检查更新，提高后台检查频率，并在唤醒或解锁后检查。 （#1065）

### 修复
- **OpenCode 2.x 会话：** 修复升级后会话详情无法显示记录及部分 Token 用量缺失的问题。 （#1060）
- **会话分组：** 修正分组会话的调用次数、缓存命中率、生成速度和最近活动时间。 （#1053）
- **Windows Edge Dock：** 修复解锁屏幕后点击和拖动无响应的问题。 （#1059）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.72.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.72.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.72.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-Setup-0.72.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.72.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.72.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.71.0...v0.72.0">v0.71.0...v0.72.0</a></summary>

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
- **Cursor 方案：** 支援 The X Subscription 方案的內含用量額度與預付餘額。 （#1056）

### 改進
- **更新按鈕：** 可直接下載或重啟更新，懸停或透過鍵盤聚焦按鈕即可查看更新內容。 （#1065）
- **更新檢查：** 啟動後稍候即檢查更新，提高背景檢查頻率，並在喚醒或解鎖後檢查。 （#1065）

### 修復
- **OpenCode 2.x 會話：** 修復升級後會話詳情無法顯示記錄及部分 Token 用量缺失的問題。 （#1060）
- **會話分組：** 修正分組會話的呼叫次數、快取命中率、生成速度與最近活動時間。 （#1053）
- **Windows Edge Dock：** 修復解鎖螢幕後點擊與拖曳無回應的問題。 （#1059）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.72.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.72.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.72.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-Setup-0.72.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.72.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.72.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Cursor 요금제:** The X Subscription 요금제의 기본 제공 사용량 한도와 선불 잔액을 지원합니다. (#1056)

### 개선
- **업데이트 버튼:** 버튼에서 바로 다운로드하거나 다시 시작해 업데이트할 수 있습니다. 마우스를 올리거나 키보드로 포커스하면 업데이트 내용을 확인할 수 있습니다. (#1065)
- **업데이트 확인:** 실행 직후 잠시 뒤에 업데이트를 확인하고, 백그라운드 확인 주기를 단축했습니다. 절전 모드 해제나 잠금 해제 후에도 확인합니다. (#1065)

### 수정
- **OpenCode 2.x 세션:** 업그레이드 후 세션 상세에서 대화 기록과 일부 토큰 사용량이 누락되는 문제를 수정했습니다. (#1060)
- **세션 그룹:** 그룹에 포함된 세션의 호출 횟수, 캐시 적중률, 생성 속도와 최근 활동 시간을 올바르게 표시합니다. (#1053)
- **Windows Edge Dock:** 화면 잠금을 해제한 뒤 클릭과 드래그가 반응하지 않는 문제를 수정했습니다. (#1059)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.72.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.72.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.72.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-Setup-0.72.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.72.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.72.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Cursor プラン:** The X Subscription プランの利用枠とプリペイド残高に対応しました。 (#1056)

### 改善
- **更新ボタン:** ボタンから直接ダウンロードや再起動による更新ができます。マウスを重ねるかキーボードでフォーカスすると、更新内容を確認できます。 (#1065)
- **更新の確認:** 起動から少し待って更新を確認し、バックグラウンドでの確認間隔を短縮しました。スリープ復帰やロック解除後にも確認します。 (#1065)

### 修正
- **OpenCode 2.x のセッション:** アップグレード後、セッション詳細に会話記録や一部のトークン使用量が表示されない問題を修正しました。 (#1060)
- **セッショングループ:** グループ内の呼び出し回数、キャッシュヒット率、生成速度、最終アクティビティ時刻を正しく表示します。 (#1053)
- **Windows Edge Dock:** 画面のロック解除後にクリックやドラッグが反応しなくなる問題を修正しました。 (#1059)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.72.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.72.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.72.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-Setup-0.72.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.72.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.72.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.72.0/Token-Monitor-0.72.0.AppImage)

</details>

</details>
