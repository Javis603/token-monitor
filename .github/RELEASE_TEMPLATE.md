# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Edge Dock reveal area.** In the auto-hide modes, choose whether the Edge Dock opens from its full span or only near its handle. The full span remains the default. (#1627)

### Fixed
- **macOS main window.** Fix the glass background turning into a solid dark panel when the main window reopens after the screen was unlocked. (#1628)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.96.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.96.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.96.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-Setup-0.96.1.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.96.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.96.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1.AppImage)

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

Tokscale is bundled with this app and updated through Token Monitor releases. See **Settings → General → Advanced → Tokscale** for the version and fork build identifier. Tokscale is MIT, open-source: https://github.com/junhoyeo/tokscale

</details>

---

# 中文

## 更新内容

<!-- app-update-notes:zh:start -->
### 新增
- **侧边栏展开范围：** 自动隐藏模式下，可选择鼠标靠近整条侧边栏时展开，或只在把手附近才展开。默认仍是整条范围。 （#1627）

### 修复
- **macOS 主窗口：** 修复解锁屏幕后重新打开主窗口时，玻璃背景变成实心深色面板的问题。 （#1628）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.96.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.96.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.96.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-Setup-0.96.1.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.96.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.96.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1.AppImage)

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

Tokscale 已随应用内置，并通过 Token Monitor 发布版本更新。你可以在 **设置 → 常规 → 高级 → Tokscale** 查看版本和 fork 构建标识。Tokscale 是 MIT 开源项目：https://github.com/junhoyeo/tokscale

</details>

---

<details>
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.96.0...v0.96.1">v0.96.0...v0.96.1</a></summary>

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
- **側邊欄展開範圍：** 自動隱藏模式下，可選擇游標靠近整條側邊欄時展開，或只在把手附近才展開。預設仍是整條範圍。 （#1627）

### 修復
- **macOS 主視窗：** 修復解鎖螢幕後重新開啟主視窗時，玻璃背景變成實心深色面板的問題。 （#1628）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.96.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.96.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.96.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-Setup-0.96.1.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.96.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.96.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **가장자리 도크 펼치기 감지 범위.** 자동 숨김 모드에서 Dock 전체 길이에서 펼칠지, 핸들 주변에서만 펼칠지 선택할 수 있습니다. 기본값은 Dock 전체 길이입니다. (#1627)

### 수정
- **macOS 메인 창.** 화면 잠금을 해제한 뒤 메인 창을 다시 열면 글래스 배경이 불투명한 어두운 패널로 바뀌던 문제를 수정했습니다. (#1628)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.96.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.96.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.96.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-Setup-0.96.1.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.96.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.96.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **エッジドックの展開範囲。** 自動で隠れるモードで、ドックの全長から展開するか、ハンドル付近だけで展開するかを選べます。既定はドックの全長です。 （#1627）

### 修正
- **macOS のメインウィンドウ。** 画面のロック解除後にメインウィンドウを開き直すと、ガラス背景が不透明な暗いパネルになることがある問題を修正しました。 （#1628）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.96.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.96.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.96.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-Setup-0.96.1.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.96.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.96.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.96.1/Token-Monitor-0.96.1.AppImage)

</details>

</details>
